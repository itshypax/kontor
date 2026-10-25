import { audit } from '../audit'
import { KIND_LABELS, loadAccounts, loadCategories, loadSettings } from '../catalog'
import type { Ctx } from '../context'
import { EXPENSE_POSITIONS, POSITIONS } from '../euer'
import { esc, field, html, HttpError, readForm, redirect } from '../http'
import { formatCents, parseAmount, plainCents } from '../money'
import { loadRegimes, modeLabel } from '../regime'
import { isTaxCode, TAX_CODES } from '../tax'
import { formatDate, isDate, isoSeconds } from '../time'
import type { CategoryKind, TaxCode } from '../types'
import { hint, page, pageHead } from '../views/layout'

const STAMMDATEN: Array<[string, string]> = [['business_name', 'Name des Unternehmens'], ['owner', 'Inhaber'], ['address', 'Anschrift'], ['tax_number', 'Steuernummer'], ['vat_id', 'USt-IdNr.'], ['tax_office', 'Finanzamt']]

function taxOptions(selected: string): string {
  return (Object.keys(TAX_CODES) as TaxCode[]).map(c => `<option value="${c}"${c === selected ? ' selected' : ''}>${esc(TAX_CODES[c].label)}</option>`).join('')
}

export async function settingsPage(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB
  const year = Number(ctx.url.searchParams.get('jahr')) || Number(ctx.today.slice(0, 4))
  const [settings, regimes, categories, accounts, yc, lines, fields, doc, years] = await Promise.all([
    loadSettings(db), loadRegimes(db), loadCategories(db), loadAccounts(db),
    db.prepare('SELECT * FROM year_config WHERE year = ?').bind(year).first<{ small_business_prev_limit: number; small_business_limit: number; gwg_limit: number }>(),
    db.prepare('SELECT position, line FROM euer_lines WHERE year = ?').bind(year).all<{ position: string; line: string }>(),
    db.prepare('SELECT direction, tax_code, base_field, tax_field, input_tax_field FROM ustva_fields WHERE year = ? ORDER BY direction DESC, tax_code').bind(year).all<{ direction: string; tax_code: string; base_field: string; tax_field: string; input_tax_field: string }>(),
    db.prepare('SELECT version, valid_from, text, created_at FROM procedure_docs ORDER BY version DESC LIMIT 1').first<{ version: number; valid_from: string; text: string; created_at: string }>(),
    db.prepare('SELECT year FROM year_config ORDER BY year').all<{ year: number }>()
  ])
  const ro = ctx.readOnly ? ' disabled' : ''
  const save = ctx.readOnly ? '' : '<div><button class="btn btn-primary">Speichern</button></div>'
  const lineMap = new Map(lines.results.map(l => [l.position, l.line]))
  const kinds = (Object.keys(KIND_LABELS) as CategoryKind[]).map(k => `<option value="${k}">${esc(KIND_LABELS[k])}</option>`).join('')
  const positions = EXPENSE_POSITIONS.map(p => `<option value="${p.key}">${esc(p.label)}</option>`).join('')

  const body = `${pageHead('Einstellungen', 'Stammdaten, Steuermodus, Kategorien, Konten und die Werte, die sich jedes Jahr ändern.')}
${hint(ctx.url)}
<nav class="seg-links on-surface" style="margin-bottom:20px" aria-label="Abschnitte"><a href="#stammdaten">Stammdaten</a><a href="#steuermodus">Steuermodus</a><a href="#kategorien">Kategorien</a><a href="#konten">Konten</a><a href="#jahr">Jahrestabellen</a><a href="#verfahren">Verfahrensdokumentation</a></nav>

<div class="row">
<form id="stammdaten" method="post" action="/einstellungen/stammdaten" class="card pad-lg grow stack" style="gap:16px">
  <h2>Stammdaten</h2>
  <div class="form-grid">${STAMMDATEN.map(([k, label]) => `<div class="field"><label for="s-${k}">${label}</label><input id="s-${k}" name="${k}" value="${esc(settings[k] ?? '')}" maxlength="300"${ro}></div>`).join('')}</div>
  <label class="check"><input type="checkbox" name="guard_counts_abroad" value="1"${settings.guard_counts_abroad !== '0' ? ' checked' : ''}${ro}>Nicht steuerbare Einnahmen (etwa Tebex) zählen für die Kleinunternehmergrenze</label>
  <p class="muted" style="margin:0;font-size:13px">Ob sie zählen, klärt der Steuerberater. Angehakt ist die vorsichtige Annahme.</p>
  ${save}
</form>

<section id="steuermodus" class="card pad-lg side stack" style="gap:16px">
  <h2>Steuermodus</h2>
  <ul class="timeline">${regimes.map(r => `<li><time>ab ${formatDate(r.validFrom)}</time>${esc(modeLabel(r))}${r.mode === 'standard' ? `, ${r.filingPeriod === 'month' ? 'monatlich' : 'vierteljährlich'}` : ''}</li>`).join('')}</ul>
  ${ctx.readOnly ? '' : `<form method="post" action="/einstellungen/steuermodus" class="stack" style="gap:12px">
    <p class="muted" style="margin:0;font-size:13px">Ein Wechsel gilt ab einem Datum, etwa wenn der Umsatz die Grenze überschreitet. Abgeschlossene Monate bleiben unberührt.</p>
    <div class="field"><label for="valid_from">Gilt ab</label><input id="valid_from" name="valid_from" type="date" required></div>
    <div class="field"><label for="mode">Modus</label><select id="mode" name="mode"><option value="small_business">Kleinunternehmer nach § 19 UStG</option><option value="standard">Regelbesteuerung</option></select></div>
    <div class="field"><label for="filing">Voranmeldung</label><select id="filing" name="filing_period"><option value="quarter">vierteljährlich</option><option value="month">monatlich</option><option value="none">keine</option></select></div>
    <label class="check"><input type="checkbox" name="cash_basis" value="1" checked>Ist-Versteuerung (nach Zahlungseingang)</label>
    <div><button class="btn" data-confirm="Neuen Steuermodus eintragen? Er lässt sich danach nicht mehr ändern, nur durch einen weiteren ablösen.">Eintragen</button></div>
  </form>`}
</section>
</div>

<section id="kategorien" class="card flush" style="margin-bottom:20px">
  <div class="card-head"><div><h2>Kategorien</h2><p class="sub">Bestimmen die Zeile der Anlage EÜR. Eine verwendete Kategorie behält ihre Zuordnung, für eine andere eine neue anlegen.</p></div></div>
  <div class="table-wrap"><table class="list" style="min-width:860px"><thead><tr><th>Name</th><th>Art</th><th>Zeile der EÜR</th><th>Üblicher Steuerschlüssel</th><th>Aktiv</th><th></th></tr></thead><tbody>
  ${categories.map(c => `<tr><td colspan="6" style="padding:0"><form method="post" action="/einstellungen/kategorien/${c.id}" style="display:grid;grid-template-columns:2fr 1.2fr 2fr 2fr .5fr auto;gap:8px;align-items:center;padding:10px 24px">
    <label class="sr" for="cn${c.id}">Name</label><input id="cn${c.id}" name="name" value="${esc(c.name)}" required maxlength="100"${ro}>
    <span class="muted">${esc(KIND_LABELS[c.kind])}</span>
    <span class="muted" style="font-size:13px">${esc(c.kind === 'income' ? 'je nach Steuermodus' : POSITIONS.find(p => p.key === c.position)?.label ?? (c.kind === 'asset' ? 'über die Abschreibung' : 'nicht in der EÜR'))}</span>
    <label class="sr" for="ct${c.id}">Steuerschlüssel</label><select id="ct${c.id}" name="default_tax_code"${ro}>${taxOptions(c.defaultTaxCode)}</select>
    <label class="check"><input type="checkbox" name="active" value="1"${c.active ? ' checked' : ''}${ro}><span class="sr">aktiv</span></label>
    ${ctx.readOnly ? '<span></span>' : '<button class="btn btn-sm">Speichern</button>'}
  </form></td></tr>`).join('')}
  </tbody></table></div>
  ${ctx.readOnly ? '' : `<form method="post" action="/einstellungen/kategorien" class="form-grid" style="padding:20px 24px 24px;align-items:end">
    <div class="field"><label for="nc-name">Neue Kategorie</label><input id="nc-name" name="name" required maxlength="100"></div>
    <div class="field"><label for="nc-kind">Art</label><select id="nc-kind" name="kind">${kinds}</select></div>
    <div class="field"><label for="nc-pos">Zeile der EÜR (bei Ausgaben)</label><select id="nc-pos" name="position">${positions}</select></div>
    <div class="field"><label for="nc-tax">Üblicher Steuerschlüssel</label><select id="nc-tax" name="default_tax_code">${taxOptions('DE19')}</select></div>
    <div><button class="btn">Anlegen</button></div>
  </form>`}
</section>

<section id="konten" class="card flush" style="margin-bottom:20px">
  <div class="card-head"><div><h2>Konten</h2><p class="sub">Zahlungswege. Konten mit Abgleich werden beim Monatsabschluss mit dem Kontostand verglichen.</p></div></div>
  <div class="table-wrap"><table class="list" style="min-width:700px"><thead><tr><th>Name</th><th>Anfangsbestand</th><th>Abgleich</th><th>Aktiv</th><th></th></tr></thead><tbody>
  ${accounts.map(a => `<tr><td colspan="5" style="padding:0"><form method="post" action="/einstellungen/konten/${a.id}" style="display:grid;grid-template-columns:2fr 1.2fr .6fr .6fr auto;gap:8px;align-items:center;padding:10px 24px">
    <label class="sr" for="an${a.id}">Name</label><input id="an${a.id}" name="name" value="${esc(a.name)}" required maxlength="100"${ro}>
    <label class="sr" for="ab${a.id}">Anfangsbestand</label><input id="ab${a.id}" name="opening_balance" class="num" value="${plainCents(a.openingBalance)}"${ro}>
    <label class="check"><input type="checkbox" name="reconcile" value="1"${a.reconcile ? ' checked' : ''}${ro}><span class="sr">Abgleich</span></label>
    <label class="check"><input type="checkbox" name="active" value="1"${a.active ? ' checked' : ''}${ro}><span class="sr">aktiv</span></label>
    ${ctx.readOnly ? '<span></span>' : '<button class="btn btn-sm">Speichern</button>'}
  </form></td></tr>`).join('')}
  </tbody></table></div>
  ${ctx.readOnly ? '' : `<form method="post" action="/einstellungen/konten" class="form-grid" style="padding:20px 24px 24px;align-items:end">
    <div class="field"><label for="na-name">Neues Konto</label><input id="na-name" name="name" required maxlength="100"></div>
    <div class="field"><label for="na-open">Anfangsbestand</label><input id="na-open" name="opening_balance" class="num" value="0,00"></div>
    <label class="check"><input type="checkbox" name="reconcile" value="1" checked>Beim Monatsabschluss abgleichen</label>
    <div><button class="btn">Anlegen</button></div>
  </form>`}
</section>

<form id="jahr" method="post" action="/einstellungen/jahr/${year}" class="card pad-lg stack" style="gap:16px;margin-bottom:20px">
  <div class="card-head" style="margin-bottom:0"><div><h2>Jahrestabelle ${year}</h2><p class="sub">Grenzen, Zeilen der Anlage EÜR und Kennzahlen der Voranmeldung. Jedes Jahr mit den amtlichen Vordrucken abgleichen.</p></div>
    <nav class="seg-links" aria-label="Jahr">${years.results.map(y => `<a href="/einstellungen?jahr=${y.year}#jahr"${y.year === year ? ' aria-current="true"' : ''}>${y.year}</a>`).join('')}</nav></div>
  ${yc ? `<div class="form-grid">
    <div class="field"><label for="y-prev">Kleinunternehmergrenze Vorjahr</label><input id="y-prev" name="prev_limit" class="num" value="${plainCents(yc.small_business_prev_limit)}"${ro}></div>
    <div class="field"><label for="y-limit">Grenze laufendes Jahr</label><input id="y-limit" name="limit" class="num" value="${plainCents(yc.small_business_limit)}"${ro}></div>
    <div class="field"><label for="y-gwg">GWG-Grenze netto</label><input id="y-gwg" name="gwg_limit" class="num" value="${plainCents(yc.gwg_limit)}"${ro}></div>
  </div>
  <h3 class="label" style="margin-top:8px">Zeilen der Anlage EÜR</h3>
  <div class="form-grid">${POSITIONS.map(p => `<div class="field"><label for="l-${p.key}">${esc(p.label)}</label><input id="l-${p.key}" name="line_${p.key}" value="${esc(lineMap.get(p.key) ?? '')}" maxlength="10" placeholder="Zeile"${ro}></div>`).join('')}</div>
  <h3 class="label" style="margin-top:8px">Kennzahlen der Voranmeldung</h3>
  <div class="table-wrap"><table class="list"><thead><tr><th>Richtung</th><th>Steuerschlüssel</th><th>Bemessungsgrundlage</th><th>Steuer</th><th>Vorsteuer</th></tr></thead><tbody>
  ${fields.results.map(f => { const k = `${f.direction}_${f.tax_code}`; return `<tr><td>${f.direction === 'income' ? 'Einnahme' : 'Ausgabe'}</td><td>${esc(isTaxCode(f.tax_code) ? TAX_CODES[f.tax_code].short : f.tax_code)}</td>
    <td><label class="sr" for="fb-${k}">Bemessungsgrundlage</label><input id="fb-${k}" name="kz_${k}_base" value="${esc(f.base_field)}" maxlength="4" style="width:90px"${ro}></td>
    <td><label class="sr" for="ft-${k}">Steuer</label><input id="ft-${k}" name="kz_${k}_tax" value="${esc(f.tax_field)}" maxlength="4" style="width:90px"${ro}></td>
    <td><label class="sr" for="fi-${k}">Vorsteuer</label><input id="fi-${k}" name="kz_${k}_input" value="${esc(f.input_tax_field)}" maxlength="4" style="width:90px"${ro}></td></tr>` }).join('')}
  </tbody></table></div>
  ${save}` : `<p class="muted">Für ${year} gibt es noch keine Jahrestabelle.</p>${ctx.readOnly ? '' : `<div><button class="btn" name="create" value="1">Aus dem Vorjahr übernehmen</button></div>`}`}
  ${yc && !ctx.readOnly ? `<p class="muted" style="margin:0;font-size:13px"><a href="/einstellungen?jahr=${year + 1}#jahr">Jahrestabelle ${year + 1}</a></p>` : ''}
</form>

<form id="verfahren" method="post" action="/einstellungen/verfahren" class="card pad-lg stack" style="gap:16px">
  <h2>Verfahrensdokumentation</h2>
  <p class="muted" style="margin:0;font-size:14px">Fassung ${doc?.version ?? 0}${doc ? `, gültig ab ${formatDate(doc.valid_from)}` : ''}. Speichern legt eine neue Fassung an, frühere bleiben erhalten und liegen jedem Prüfer-Paket bei. Platzhalter in eckigen Klammern ausfüllen.</p>
  <div class="field"><label for="doc-text">Text (Markdown)</label><textarea id="doc-text" name="text" style="min-height:420px" maxlength="50000"${ro}>${esc(doc?.text ?? '')}</textarea></div>
  ${ctx.readOnly ? '' : `<div class="actions"><div class="field"><label for="doc-from">Gilt ab</label><input id="doc-from" name="valid_from" type="date" value="${ctx.today}" required></div><button class="btn btn-primary" style="align-self:flex-end">Neue Fassung speichern</button></div>`}
</form>`
  return html(page({ title: 'Einstellungen', active: 'settings', body, readOnly: ctx.readOnly }))
}

export async function saveSettingsAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const values = Object.fromEntries(STAMMDATEN.map(([k]) => [k, field(form, k).slice(0, 300)]))
  values.guard_counts_abroad = field(form, 'guard_counts_abroad') === '1' ? '1' : '0'
  await ctx.env.DB.batch([
    ...Object.entries(values).map(([k, v]) => ctx.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v)),
    audit(ctx.env.DB, ctx.actor, 'settings.update', 'settings', values)
  ])
  return redirect('/einstellungen?hinweis=gespeichert#stammdaten')
}

export async function addRegimeAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const validFrom = field(form, 'valid_from')
  const mode = field(form, 'mode')
  const filing = field(form, 'filing_period')
  if (!isDate(validFrom)) throw new HttpError(400, 'Das Datum ist ungültig.')
  if (!['small_business', 'standard'].includes(mode) || !['month', 'quarter', 'none'].includes(filing)) throw new HttpError(400, 'Ungültiger Steuermodus.')
  const locked = await ctx.env.DB.prepare('SELECT MAX(month) AS month FROM periods WHERE locked_at IS NOT NULL').first<{ month: string | null }>()
  if (locked?.month && validFrom.slice(0, 7) <= locked.month) throw new HttpError(409, `Bis ${locked.month} sind die Monate abgeschlossen. Ein neuer Steuermodus kann erst danach gelten.`)
  const exists = await ctx.env.DB.prepare('SELECT 1 FROM tax_regimes WHERE valid_from = ?').bind(validFrom).first()
  if (exists) throw new HttpError(409, 'Für dieses Datum gibt es schon einen Steuermodus.')
  const cash = field(form, 'cash_basis') === '1' ? 1 : 0
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO tax_regimes (valid_from, mode, filing_period, cash_basis, created_at) VALUES (?, ?, ?, ?, ?)').bind(validFrom, mode, mode === 'small_business' ? 'none' : filing, cash, isoSeconds()),
    audit(ctx.env.DB, ctx.actor, 'regime.create', `regime:${validFrom}`, { mode, filing, cash })
  ])
  return redirect('/einstellungen?hinweis=gespeichert#steuermodus')
}

export async function addCategoryAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const name = field(form, 'name').slice(0, 100)
  const kind = field(form, 'kind') as CategoryKind
  const tax = field(form, 'default_tax_code')
  if (!name || !Object.hasOwn(KIND_LABELS, kind) || !isTaxCode(tax)) throw new HttpError(400, 'Name, Art und Steuerschlüssel angeben.')
  const position = kind === 'expense' ? field(form, 'position') : kind === 'income' ? 'income' : kind === 'asset' ? 'asset' : kind === 'tax_payment' ? 'vat_paid' : kind === 'tax_refund' ? 'vat_refund' : 'private'
  if (kind === 'expense' && !EXPENSE_POSITIONS.some(p => p.key === position)) throw new HttpError(400, 'Bitte eine Zeile der EÜR wählen.')
  const exists = await ctx.env.DB.prepare('SELECT 1 FROM categories WHERE name = ?').bind(name).first()
  if (exists) throw new HttpError(409, 'Eine Kategorie mit diesem Namen gibt es schon.')
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO categories (name, kind, position, default_tax_code, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM categories))').bind(name, kind, position, tax),
    audit(ctx.env.DB, ctx.actor, 'category.create', `category:${name}`, { kind, position, tax })
  ])
  return redirect('/einstellungen?hinweis=gespeichert#kategorien')
}

export async function updateCategoryAction(ctx: Ctx, id: number): Promise<Response> {
  const form = await readForm(ctx.request)
  const name = field(form, 'name').slice(0, 100)
  const tax = field(form, 'default_tax_code')
  if (!name || !isTaxCode(tax)) throw new HttpError(400, 'Name und Steuerschlüssel angeben.')
  const active = field(form, 'active') === '1' ? 1 : 0
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE categories SET name = ?, default_tax_code = ?, active = ? WHERE id = ?').bind(name, tax, active, id),
    audit(ctx.env.DB, ctx.actor, 'category.update', `category:${id}`, { name, tax, active })
  ])
  return redirect('/einstellungen?hinweis=gespeichert#kategorien')
}

export async function addAccountAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const name = field(form, 'name').slice(0, 100)
  const opening = parseAmount(field(form, 'opening_balance') || '0')
  if (!name || opening === null) throw new HttpError(400, 'Name und Anfangsbestand angeben.')
  const reconcile = field(form, 'reconcile') === '1' ? 1 : 0
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO accounts (name, reconcile, opening_balance, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts))').bind(name, reconcile, opening),
    audit(ctx.env.DB, ctx.actor, 'account.create', `account:${name}`, { reconcile, opening })
  ])
  return redirect('/einstellungen?hinweis=gespeichert#konten')
}

export async function updateAccountAction(ctx: Ctx, id: number): Promise<Response> {
  const form = await readForm(ctx.request)
  const name = field(form, 'name').slice(0, 100)
  const opening = parseAmount(field(form, 'opening_balance') || '0')
  if (!name || opening === null) throw new HttpError(400, 'Name und Anfangsbestand angeben.')
  const reconcile = field(form, 'reconcile') === '1' ? 1 : 0
  const active = field(form, 'active') === '1' ? 1 : 0
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE accounts SET name = ?, opening_balance = ?, reconcile = ?, active = ? WHERE id = ?').bind(name, opening, reconcile, active, id),
    audit(ctx.env.DB, ctx.actor, 'account.update', `account:${id}`, { name, opening: formatCents(opening), reconcile, active })
  ])
  return redirect('/einstellungen?hinweis=gespeichert#konten')
}

export async function saveYearAction(ctx: Ctx, year: number): Promise<Response> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(404, 'Ungültiges Jahr.')
  const form = await readForm(ctx.request)
  const db = ctx.env.DB
  if (field(form, 'create') === '1') {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO year_config SELECT ?1, small_business_prev_limit, small_business_limit, gwg_limit FROM year_config WHERE year = (SELECT MAX(year) FROM year_config WHERE year < ?1)').bind(year),
      db.prepare('INSERT OR IGNORE INTO euer_lines SELECT ?1, position, line FROM euer_lines WHERE year = (SELECT MAX(year) FROM euer_lines WHERE year < ?1)').bind(year),
      db.prepare('INSERT OR IGNORE INTO ustva_fields SELECT ?1, direction, tax_code, base_field, tax_field, input_tax_field FROM ustva_fields WHERE year = (SELECT MAX(year) FROM ustva_fields WHERE year < ?1)').bind(year),
      audit(db, ctx.actor, 'year.update', `year:${year}`, 'aus dem Vorjahr übernommen')
    ])
    return redirect(`/einstellungen?jahr=${year}&hinweis=gespeichert#jahr`)
  }
  const prev = parseAmount(field(form, 'prev_limit'))
  const limit = parseAmount(field(form, 'limit'))
  const gwg = parseAmount(field(form, 'gwg_limit'))
  if (prev === null || limit === null || gwg === null) throw new HttpError(400, 'Die Grenzen sind ungültig.')
  const statements: D1PreparedStatement[] = [db.prepare('UPDATE year_config SET small_business_prev_limit = ?, small_business_limit = ?, gwg_limit = ? WHERE year = ?').bind(prev, limit, gwg, year)]
  for (const p of POSITIONS) statements.push(db.prepare('INSERT INTO euer_lines (year, position, line) VALUES (?, ?, ?) ON CONFLICT(year, position) DO UPDATE SET line = excluded.line').bind(year, p.key, field(form, `line_${p.key}`).slice(0, 10)))
  const { results } = await db.prepare('SELECT direction, tax_code FROM ustva_fields WHERE year = ?').bind(year).all<{ direction: string; tax_code: string }>()
  const kz = (v: string) => (/^\d{0,4}$/.test(v) ? v : '')
  for (const r of results) {
    const k = `kz_${r.direction}_${r.tax_code}`
    statements.push(db.prepare('UPDATE ustva_fields SET base_field = ?, tax_field = ?, input_tax_field = ? WHERE year = ? AND direction = ? AND tax_code = ?')
      .bind(kz(field(form, `${k}_base`)), kz(field(form, `${k}_tax`)), kz(field(form, `${k}_input`)), year, r.direction, r.tax_code))
  }
  statements.push(audit(db, ctx.actor, 'year.update', `year:${year}`, { prev, limit, gwg }))
  await db.batch(statements)
  return redirect(`/einstellungen?jahr=${year}&hinweis=gespeichert#jahr`)
}

export async function saveProcedureAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const text = field(form, 'text')
  const validFrom = field(form, 'valid_from')
  if (!text || !isDate(validFrom)) throw new HttpError(400, 'Text und Gültigkeitsdatum angeben.')
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO procedure_docs (version, valid_from, text, created_at, created_by) VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM procedure_docs), ?, ?, ?, ?)').bind(validFrom, text.slice(0, 50000), isoSeconds(), ctx.actor),
    audit(ctx.env.DB, ctx.actor, 'procedure.create', 'procedure', { validFrom })
  ])
  return redirect('/einstellungen?hinweis=gespeichert#verfahren')
}
