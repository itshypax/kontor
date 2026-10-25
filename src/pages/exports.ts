import { zipSync } from 'fflate'
import type { Ctx } from '../context'
import { archiveExport, buildPackage, euerPdf, lastBackup, sqlDump } from '../exports'
import { esc, field, html, HttpError, readForm } from '../http'
import { formatSize } from '../documents'
import { formatDate, formatDateTime, isDate } from '../time'
import { hint, icon, page, pageHead } from '../views/layout'

function download(bytes: Uint8Array, filename: string, type: string, sha: string): Response {
  return new Response(bytes, { headers: {
    'content-type': type,
    'content-disposition': `attachment; filename="${filename}"`,
    'x-checksum-sha256': sha,
    'cache-control': 'no-store'
  } })
}

export async function exportsPage(ctx: Ctx): Promise<Response> {
  const year = Number(ctx.today.slice(0, 4))
  const [{ results: past }, backup, full] = await Promise.all([
    ctx.env.DB.prepare('SELECT id, kind, label, created_at, sha256, size, filename, r2_key FROM exports ORDER BY id DESC LIMIT 50').all<{ id: number; kind: string; label: string; created_at: string; sha256: string; size: number; filename: string; r2_key: string | null }>(),
    lastBackup(ctx.env),
    ctx.env.DB.prepare(`SELECT MAX(created_at) AS at FROM exports WHERE kind = 'backup'`).first<{ at: string | null }>()
  ])
  const age = full?.at ? Math.floor((Date.parse(ctx.today) - Date.parse(full.at.slice(0, 10))) / 86400000) : null
  const rows = past.map(p => `<tr><td class="num muted">${formatDateTime(p.created_at)}</td><td><span class="cell-main">${esc(p.label)}</span><span class="cell-sub">${esc(p.filename)}</span></td><td class="r num muted">${formatSize(p.size)}</td>
<td class="num muted" style="font-size:12px">${esc(p.sha256.slice(0, 8))} … ${esc(p.sha256.slice(-8))}</td>
<td class="r">${p.r2_key ? `<a class="btn btn-sm" href="/export/${p.id}" aria-label="${esc(p.label)} herunterladen">${icon('download')}</a>` : '<span class="muted" style="font-size:12px">nicht gespeichert</span>'}</td></tr>`).join('')
  const body = `${pageHead('Export', 'Jeder Export bekommt eine Prüfsumme und steht unten in der Liste. So bleibt nachvollziehbar, was wann herausgegeben wurde.')}
${hint(ctx.url)}
<div class="row">
  <form method="post" action="/export/pruefer" class="card orange pad-lg grow stack">
    <div><span class="label">Für Betriebsprüfung oder Steuerberater</span><h2 style="margin-top:6px;font-size:40px;letter-spacing:-.045em;line-height:1.05">Prüfer-Paket</h2>
    <p style="margin:8px 0 0;font-weight:500;max-width:52ch">Alle Daten maschinell auswertbar als CSV mit Beschreibung nach dem Beschreibungsstandard, dazu die Belege und eine Prüfsumme je Datei.</p></div>
    <div class="actions" style="align-items:flex-end">
      <div class="field"><label for="from" style="color:var(--on-orange)">Von</label><input id="from" name="from" type="date" value="${year}-01-01" required></div>
      <div class="field"><label for="to" style="color:var(--on-orange)">Bis</label><input id="to" name="to" type="date" value="${year}-12-31" required></div>
    </div>
    <fieldset style="margin:0;padding:0;border:0" class="stack">
      <legend style="font-weight:700;font-size:13px;margin-bottom:6px">Enthält</legend>
      <label class="check" style="font-weight:600"><input type="checkbox" name="documents" value="1" checked style="accent-color:#111113">Belegdateien</label>
      <label class="check" style="font-weight:600"><input type="checkbox" name="log" value="1" checked style="accent-color:#111113">Änderungsprotokoll</label>
      <label class="check" style="font-weight:600"><input type="checkbox" name="procedure" value="1" checked style="accent-color:#111113">Verfahrensdokumentation</label>
    </fieldset>
    <div><button class="btn btn-dark btn-lg">Paket erzeugen</button></div>
  </form>
  <section class="card side">
    <h2 class="label">Im Paket</h2>
    <ul class="timeline" style="margin-top:12px;font-family:var(--mono);font-size:13px">
      <li>index.xml <span class="muted">Beschreibung aller Tabellen</span></li>
      <li>buchungen.csv, positionen.csv</li><li>belege.csv, buchung_belege.csv</li>
      <li>konten.csv, kategorien.csv, anlagen.csv</li><li>steuermodi.csv, voranmeldungen.csv</li>
      <li>protokoll.csv</li><li>verfahrensdokumentation/</li><li>belege/ <span class="muted">alle Dateien</span></li>
      <li>pruefsummen.txt <span class="muted">SHA-256 je Datei</span></li>
    </ul>
  </section>
</div>
<div class="grid">
  <form method="post" action="/export/euer" class="card stack" style="gap:12px">
    <h2>EÜR-Übersicht</h2>
    <p class="muted" style="margin:0;font-size:14px">PDF mit den Summen je Zeile, Kategorien und Anlagenverzeichnis, zum Übertragen in Mein ELSTER.</p>
    <div class="actions" style="margin-top:auto"><label class="sr" for="e-year">Jahr</label><select id="e-year" name="jahr" style="border-radius:999px">${[year, year - 1].map(y => `<option>${y}</option>`).join('')}</select><button class="btn" style="flex:1">PDF erzeugen</button></div>
  </form>
  <form method="post" action="/export/sicherung" class="card stack${age === null || age > 31 ? ' alert' : ''}" style="gap:12px">
    <h2>Gesamtsicherung</h2>
    <p class="muted" style="margin:0;font-size:14px">Alle Jahre mit allen Belegen plus SQL-Dump. Einmal im Monat außerhalb von Cloudflare ablegen.</p>
    <strong style="color:${age === null || age > 31 ? 'var(--orange-text)' : 'var(--text)'};font-size:14px">${age === null ? 'Noch nie heruntergeladen' : age === 0 ? 'Zuletzt heute' : `Zuletzt vor ${age} ${age === 1 ? 'Tag' : 'Tagen'}`}</strong>
    <span class="muted" style="font-size:13px">Nächtliche Sicherung der Datenbank: ${backup ? formatDate(backup) : 'noch keine'}</span>
    <div style="margin-top:auto"><button class="btn btn-light" style="width:100%">Herunterladen</button></div>
  </form>
  <section class="card dashed stack" style="gap:12px">
    <h2 class="muted">DATEV-Buchungsstapel</h2>
    <p class="muted" style="margin:0;font-size:14px">Kommt, wenn ein Steuerberater dazukommt. Jede Kategorie bekommt dann ein Konto im SKR03 oder SKR04.</p>
    <span class="badge" style="align-self:flex-start">später</span>
  </section>
</div>
<section class="card flush">
  <div class="card-head"><h2 class="label">Frühere Exporte</h2></div>
  ${past.length ? `<div class="table-wrap"><table class="list" style="min-width:680px"><tbody>${rows}</tbody></table></div>` : '<p class="muted" style="padding:0 24px 24px">Noch keine Exporte.</p>'}
</section>`
  return html(page({ title: 'Export', active: 'export', body, readOnly: ctx.readOnly }))
}

export async function packageAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const from = field(form, 'from')
  const to = field(form, 'to')
  if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, 'Bitte einen gültigen Zeitraum wählen.')
  const opts = { from, to, documents: field(form, 'documents') === '1', log: field(form, 'log') === '1', procedure: field(form, 'procedure') === '1' }
  const result = await buildPackage(ctx.env, opts)
  const filename = `pruefer-paket_${from}_${to}.zip`
  const sha = await archiveExport(ctx.env, 'pruefer', `Prüfer-Paket ${formatDate(from)} bis ${formatDate(to)}`, filename, result.zip, ctx.actor)
  return download(result.zip, filename, 'application/zip', sha)
}

export async function euerPdfAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const year = Number(field(form, 'jahr'))
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'Ungültiges Jahr.')
  const pdf = await euerPdf(ctx.env.DB, year)
  const filename = `euer-${year}.pdf`
  const sha = await archiveExport(ctx.env, 'euer', `EÜR-Übersicht ${year}`, filename, pdf, ctx.actor)
  return download(pdf, filename, 'application/pdf', sha)
}

/** All years with all documents and a SQL dump. Handed out but not kept: it repeats every document. */
export async function backupAction(ctx: Ctx): Promise<Response> {
  const result = await buildPackage(ctx.env, { from: '2000-01-01', to: '2100-12-31', documents: true, log: true, procedure: true })
  const dump = await sqlDump(ctx.env.DB)
  const inner = new Uint8Array(result.zip)
  const zip = zipSync({ 'daten.zip': [inner, { level: 0 }], 'kontor.sql': new TextEncoder().encode(dump) }, { level: 6 })
  const filename = `kontor-sicherung_${ctx.today}.zip`
  const sha = await archiveExport(ctx.env, 'backup', `Gesamtsicherung ${formatDate(ctx.today)}`, filename, zip, ctx.actor, false)
  return download(zip, filename, 'application/zip', sha)
}

export async function exportFile(ctx: Ctx, id: number): Promise<Response> {
  const row = await ctx.env.DB.prepare('SELECT r2_key, filename, sha256 FROM exports WHERE id = ?').bind(id).first<{ r2_key: string | null; filename: string; sha256: string }>()
  if (!row?.r2_key) throw new HttpError(404, 'Diesen Export gibt es nicht oder er wurde nicht gespeichert.')
  const object = await ctx.env.FILES.get(row.r2_key)
  if (!object) throw new HttpError(404, 'Die Datei fehlt im Speicher.')
  return new Response(object.body, { headers: { 'content-type': row.filename.endsWith('.pdf') ? 'application/pdf' : 'application/zip', 'content-disposition': `attachment; filename="${row.filename}"`, 'x-checksum-sha256': row.sha256, 'cache-control': 'no-store' } })
}

