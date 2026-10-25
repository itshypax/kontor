import { loadAssets, totalAfa } from '../afa'
import { audit } from '../audit'
import { direction } from '../catalog'
import type { Ctx } from '../context'
import { listDocuments } from '../documents'
import { computeEuer, POSITIONS } from '../euer'
import { loadYearFacts } from '../facts'
import { esc, field, html, HttpError, readForm, redirect } from '../http'
import { formatCents } from '../money'
import { loadRegimes, modeLabel, regimeAt } from '../regime'
import { formatDate, formatDateTime, isoSeconds, MONTHS_SHORT, periodRange } from '../time'
import { computeVatReturn, loadFieldMap } from '../ustva'
import { snapshotOf, vatForYear, type VatPeriod } from '../vat'
import { hint, icon, notice, page, pageHead } from '../views/layout'
import { yearSwitch } from '../views/parts'

export async function euerLines(db: D1Database, year: number): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT position, line FROM euer_lines WHERE year = ?').bind(year).all<{ position: string; line: string }>()
  return new Map(results.map(r => [r.position, r.line]))
}

export async function reportsPage(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB
  const thisYear = Number(ctx.today.slice(0, 4))
  const year = Number(ctx.url.searchParams.get('jahr')) || thisYear
  const view = ctx.url.searchParams.get('ansicht') === 'kategorien' ? 'categories' : 'euer'
  const [facts, regimes, assets, lines, vat, docs] = await Promise.all([loadYearFacts(db, year), loadRegimes(db), loadAssets(db), euerLines(db, year), vatForYear(db, year, ctx.today), listDocuments(db, { limit: 50 })])
  const euer = computeEuer(year, facts, regimes, totalAfa(assets, year))
  const regime = regimeAt(regimes, year === thisYear ? ctx.today : `${year}-12-31`)
  const wanted = ctx.url.searchParams.get('zeitraum')
  const selected = vat.find(v => v.period === wanted) ?? vat.find(v => !v.filing || v.changed) ?? vat[vat.length - 1]

  const row = (key: string, label: string, sub = false) => {
    const value = euer.totals.get(key) ?? 0
    const line = lines.get(key)
    return `<tr${sub ? ' class="sub"' : ''}><td class="num ${line ? '' : 'faint'}" style="width:80px;font-size:12px">${line ? esc(line) : '[Zeile]'}</td><td>${esc(label)}</td><td class="r num">${formatCents(value)}</td></tr>`
  }
  const shown = (side: 'income' | 'expense') => POSITIONS.filter(p => p.side === side && ((euer.totals.get(p.key) ?? 0) !== 0 || (side === 'income' && p.key === (regime.mode === 'small_business' ? 'income_small_business' : 'income_taxable'))))
  const extra = [...euer.totals.keys()].filter(k => !POSITIONS.some(p => p.key === k))
  const euerTable = `<section id="euer" class="card flush grow">
  <div class="card-head"><div><h2>Anlage EÜR ${year}</h2><p class="sub">Summen je Zeile, zum Übertragen in Mein ELSTER</p></div>
    <form method="post" action="/export/euer"><input type="hidden" name="jahr" value="${year}"><button class="btn btn-sm">${icon('download')}PDF</button></form></div>
  <div class="table-wrap"><table class="list" style="min-width:520px"><tbody>
    <tr class="section"><td colspan="3">Betriebseinnahmen</td></tr>
    ${shown('income').map(p => row(p.key, p.label, p.sub)).join('')}
    <tr class="total"><td></td><td>Summe Betriebseinnahmen</td><td class="r num">${formatCents(euer.income)}</td></tr>
    <tr class="section"><td colspan="3">Betriebsausgaben</td></tr>
    ${shown('expense').map(p => row(p.key, p.label)).join('')}${extra.map(k => row(k, k)).join('')}
    <tr class="total"><td></td><td>Summe Betriebsausgaben</td><td class="r num">${formatCents(euer.expense)}</td></tr>
    <tr class="total"><td></td><td style="font-size:16px">Gewinn</td><td class="r num" style="font-size:18px">${formatCents(euer.profit)}</td></tr>
  </tbody></table></div>
  <p class="muted" style="margin:0;padding:14px 24px 20px;font-size:13px">Zeilennummern stehen in den Einstellungen je Jahr. ${euer.drafts ? `Enthält ${euer.drafts} ${euer.drafts === 1 ? 'Entwurf' : 'Entwürfe'}.` : 'Alles festgeschrieben.'}</p>
</section>`

  const vatCard = vatSection(ctx, year, vat, selected, docs.filter(d => d.kind === 'confirmation' || !d.linked))
  let categoriesTable = ''
  if (view === 'categories') {
    const byCategory = new Map<string, number[]>()
    for (const l of facts) {
      if (l.fiscalYear !== year) continue
      const values = byCategory.get(l.categoryName) ?? Array(12).fill(0)
      values[Number(l.paidOn.slice(5, 7)) - 1] += direction(l.kind) * l.gross
      byCategory.set(l.categoryName, values)
    }
    categoriesTable = `<section class="card flush" style="margin-bottom:20px"><div class="card-head"><div><h2>Kategorien je Monat ${year}</h2><p class="sub">Zahlungsbeträge, Eingänge positiv</p></div></div>
<div class="table-wrap"><table class="list" style="min-width:1100px"><thead><tr><th>Kategorie</th>${MONTHS_SHORT.map(m => `<th class="r">${m}</th>`).join('')}<th class="r">Summe</th></tr></thead><tbody>
${[...byCategory].map(([name, values]) => `<tr><td>${esc(name)}</td>${values.map(v => `<td class="r num">${v ? formatCents(v, { currency: false }) : ''}</td>`).join('')}<td class="r num">${formatCents(values.reduce((a, b) => a + b, 0), { currency: false })}</td></tr>`).join('')}
</tbody></table></div></section>`
  }

  const tabs = `<nav class="seg-links on-surface" aria-label="Ansicht"><a href="/auswertungen?jahr=${year}"${view === 'euer' ? ' aria-current="true"' : ''}>EÜR ${year}</a><a href="/auswertungen?jahr=${year}#ustva">Voranmeldung</a><a href="/auswertungen?jahr=${year}&ansicht=kategorien"${view === 'categories' ? ' aria-current="true"' : ''}>Kategorien je Monat</a></nav>`
  const body = `${pageHead('Auswertungen', `${esc(modeLabel(regime))} · Entwürfe zählen mit und sind markiert`, `${tabs}${yearSwitch('/auswertungen', year, [...new Set([thisYear - 1, thisYear, year])].sort())}`)}
${hint(ctx.url)}
<div class="row">
  <section class="card pad-lg grow"><span class="label">Gewinn nach EÜR ${year}</span><span class="hero-number" style="font-size:clamp(44px,7vw,76px)">${formatCents(euer.profit)}</span>
    <div class="figures"><div class="figure"><span>Betriebseinnahmen</span><strong>${formatCents(euer.income)}</strong></div><div class="figure"><span>Betriebsausgaben</span><strong>${formatCents(euer.expense)}</strong></div></div></section>
  <section class="card orange side stack" style="justify-content:space-between">
    <div><span class="label">${selected ? 'Voranmeldung ' + esc(selected.label) : 'Voranmeldung'}</span>
    <span class="num" style="display:block;margin-top:6px;font-size:56px;font-weight:500;letter-spacing:-.05em;line-height:1">${selected ? formatCents(selected.result.due) : 'keine'}</span>
    <span style="display:block;margin-top:6px;font-size:14px;font-weight:600">${selected ? (selected.filing && !selected.changed ? 'übermittelt am ' + formatDate(selected.filing.filedAt) : selected.result.due < 0 ? 'Erstattung vom Finanzamt' : 'an das Finanzamt zu zahlen') : regime.mode === 'small_business' ? 'Als Kleinunternehmer nur bei Reverse Charge nötig.' : 'In diesem Jahr noch kein Zeitraum.'}</span></div>
    ${selected && !selected.filing ? `<div class="actions" style="justify-content:space-between"><strong>fällig am ${formatDate(selected.deadline)}</strong><a class="btn btn-dark" href="#ustva">Ansehen</a></div>` : ''}
  </section>
</div>
${categoriesTable}
<div class="row">${euerTable}${vatCard}</div>`
  return html(page({ title: 'Auswertungen', active: 'reports', body, readOnly: ctx.readOnly }))
}

function vatSection(ctx: Ctx, year: number, vat: VatPeriod[], selected: VatPeriod | undefined, docs: Awaited<ReturnType<typeof listDocuments>>): string {
  if (!selected) return `<section id="ustva" class="card side"><h2>Voranmeldung</h2><p class="muted">Für ${year} ist bisher keine Voranmeldung nötig.</p></section>`
  const options = vat.map(v => `<option value="${v.period}"${v === selected ? ' selected' : ''}>${esc(v.label)}${v.filing ? (v.changed ? ', geändert' : ', übermittelt') : ', offen'}</option>`).join('')
  const r = selected.result
  const fields = r.fields.map(f => `<li style="display:flex;align-items:center;gap:14px;padding:12px 24px;border-top:1px solid var(--line)"><span class="num" style="flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:30px;border-radius:999px;background:var(--orange-tint);color:var(--orange-text);font-size:13px">${esc(f.field)}</span><span style="flex:1;min-width:0;font-size:13px">${esc(f.label)}${f.wholeEuro ? ' <span class="muted">(volle Euro)</span>' : ''}</span><span class="num" style="flex:none">${formatCents(f.cents)}</span></li>`).join('')
  let status = ''
  if (selected.filing && selected.changed) status = notice(`<strong>Berichtigung nötig.</strong> Übermittelt am ${formatDateTime(selected.filing.filedAt)}, seitdem haben sich Buchungen im Zeitraum geändert. Eine berichtigte Voranmeldung abgeben.`, true)
  else if (selected.filing) status = notice(`Übermittelt am ${formatDateTime(selected.filing.filedAt)} von ${esc(selected.filing.filedBy)}.${selected.filing.documentId ? ` <a href="/belege/${selected.filing.documentId}">Bestätigung</a>` : ''}`)
  else if (r.drafts) status = notice(`<strong>Enthält ${r.drafts} ${r.drafts === 1 ? 'Entwurf' : 'Entwürfe'}.</strong> Erst festschreiben, dann übermitteln. Fällig am ${formatDate(selected.deadline)}.`, true)
  const form = selected.filing && !selected.changed || ctx.readOnly ? '' : `<form method="post" action="/voranmeldung/${selected.period}" class="stack" style="gap:12px;padding:0 24px 24px">
    <div class="field"><label for="doc">ELSTER-Bestätigung (vorher unter Belege hochladen)</label><select id="doc" name="document_id"><option value="">ohne</option>${docs.map(d => `<option value="${d.id}">${esc(d.number)} · ${esc(d.filename)}</option>`).join('')}</select></div>
    <div><button class="btn"${r.drafts ? ' disabled' : ''} data-confirm="Als übermittelt vermerken? Die Kennzahlen werden dabei festgehalten.">${selected.changed ? 'Berichtigung als übermittelt markieren' : 'Als übermittelt markieren'}</button></div>
  </form>`
  return `<section id="ustva" class="card flush side">
  <div class="card-head" style="margin-bottom:8px"><div><h2>Voranmeldung</h2><p class="sub">Kennzahlen zum Eintragen in Mein ELSTER</p></div></div>
  <form method="get" action="/auswertungen#ustva" data-autosubmit style="margin:0 24px 8px" class="actions"><input type="hidden" name="jahr" value="${year}"><label class="sr" for="zeitraum">Zeitraum</label><select id="zeitraum" name="zeitraum" style="flex:1;border-radius:999px;font-weight:600">${options}</select><noscript><button class="btn btn-sm">Zeigen</button></noscript></form>
  <ul style="list-style:none;margin:8px 0 0;padding:0">${fields}
    <li style="display:flex;align-items:center;gap:14px;padding:14px 24px;border-top:1px solid var(--line-strong);background:var(--surface-2)"><span class="num" style="flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:30px;border-radius:999px;background:var(--orange-tint);color:var(--orange-text);font-size:13px">83</span><strong style="flex:1;font-size:13px">${r.due < 0 ? 'Überschuss' : 'Verbleibende Vorauszahlung'}</strong><span class="num" style="flex:none;font-size:16px">${formatCents(r.due)}</span></li>
  </ul>
  <div style="padding:16px 24px 0">${status}</div>
  ${form}
</section>`
}

export async function fileVatAction(ctx: Ctx, period: string): Promise<Response> {
  const range = periodRange(period)
  if (!range) throw new HttpError(404, 'Diesen Zeitraum gibt es nicht.')
  const form = await readForm(ctx.request)
  const documentId = Number(field(form, 'document_id')) || null
  const db = ctx.env.DB
  const year = Number(period.slice(0, 4))
  const [facts, regimes, fields] = await Promise.all([loadYearFacts(db, year), loadRegimes(db), loadFieldMap(db, year)])
  const result = computeVatReturn(facts, regimes, fields, range.from, range.to)
  if (result.drafts) throw new HttpError(409, 'Im Zeitraum liegen noch Entwürfe. Erst festschreiben, dann übermitteln.')
  const existing = await db.prepare(`SELECT snapshot FROM vat_filings WHERE period = ?1 OR period LIKE ?1 || '#%' ORDER BY period DESC LIMIT 1`).bind(period).first<{ snapshot: string }>()
  const snapshot = snapshotOf(result)
  if (existing && existing.snapshot === snapshot) throw new HttpError(409, 'Diese Voranmeldung ist schon als übermittelt vermerkt.')
  // A correction is stored under its own key, so the first filing stays as it was.
  const key = existing ? `${period}#${isoSeconds()}` : period
  await db.batch([
    db.prepare('INSERT INTO vat_filings (period, filed_at, filed_by, document_id, snapshot) VALUES (?, ?, ?, ?, ?)').bind(key, isoSeconds(), ctx.actor, documentId, snapshot),
    audit(db, ctx.actor, 'vat.filed', `vat:${period}`, { snapshot: JSON.parse(snapshot), correction: !!existing })
  ])
  return redirect(`/auswertungen?jahr=${year}&zeitraum=${period}&hinweis=uebermittelt#ustva`)
}
