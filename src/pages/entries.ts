import { ACTION_LABELS } from '../audit'
import { type Category, KIND_LABELS, loadAccounts, loadCategories } from '../catalog'
import type { Ctx } from '../context'
import { DOC_KINDS, getDocument, listDocuments } from '../documents'
import { createDraft, CURRENCIES, discardDraft, type EntryDraftForm, type EntryView, getEntry, listEntries, postEntry, readEntryForm, reverseEntry, updateDraft, validateEntry } from '../entries'
import { esc, field, guardMessage, html, HttpError, readForm, redirect } from '../http'
import { formatCents, parseAmount, plainCents } from '../money'
import { monthSummary } from '../periods'
import { loadRegimes, regimeAt } from '../regime'
import { isTaxCode, lineEffect, splitGross, TAX_CODES } from '../tax'
import { formatDate, formatDateTime, isMonth, monthName } from '../time'
import type { TaxCode } from '../types'
import { errorList, hint, icon, page, pageHead } from '../views/layout'
import { amount, statusBadge } from '../views/parts'

const STATUS_FILTERS = [['all', 'Alle'], ['draft', 'Entwürfe'], ['posted', 'Festgeschrieben'], ['storno', 'Storno']] as const

export async function entriesPage(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB
  const params = ctx.url.searchParams
  const period = params.get('monat') ?? ctx.today.slice(0, 7)
  const status = (STATUS_FILTERS.find(([k]) => k === params.get('status'))?.[0] ?? 'all')
  const q = (params.get('q') ?? '').slice(0, 100)
  const isYear = /^\d{4}$/.test(period)
  if (!isYear && !isMonth(period)) throw new HttpError(400, 'Ungültiger Zeitraum.')
  const from = isYear ? `${period}-01-01` : `${period}-01`
  const to = isYear ? `${period}-12-31` : `${period}-31`
  // A draft list without a period is more useful: drafts of every month at once.
  const rows = await listEntries(db, status === 'draft' && !params.has('monat') ? { status } : { from, to, status, q })
  // By category, so a reversed expense lowers the expenses instead of counting as income.
  const income = rows.reduce((s, r) => s + r.inflow, 0)
  const expense = -rows.reduce((s, r) => s + r.outflow, 0)
  const year = Number(period.slice(0, 4))
  const months: string[] = []
  for (let y = year; y >= year - 1; y--) for (let m = 12; m >= 1; m--) { const v = `${y}-${String(m).padStart(2, '0')}`; if (v <= ctx.today.slice(0, 7) || v === period) months.push(v) }
  const options = [...new Set([String(Number(ctx.today.slice(0, 4))), ...months, period])].map(v => `<option value="${v}"${v === period ? ' selected' : ''}>${/^\d{4}$/.test(v) ? 'ganzes Jahr ' + v : monthName(v)}</option>`).join('')
  const link = (s: string) => `/buchungen?${new URLSearchParams({ monat: period, status: s, ...(q ? { q } : {}) })}`
  const pills = STATUS_FILTERS.map(([k, label]) => `<a href="${esc(link(k))}"${k === status ? ' aria-current="true"' : ''}>${label}</a>`).join('')
  let monthCard = ''
  if (!isYear) {
    const summary = await monthSummary(db, period)
    monthCard = summary.locked
      ? `<div class="tile"><span class="label">${esc(monthName(period))}</span><strong style="font-size:17px">${icon('lock')} abgeschlossen</strong><small>am ${formatDate(summary.locked.at)}</small></div>`
      : `<a class="tile${period < ctx.today.slice(0, 7) ? ' alert' : ''}" href="/monate/${period}"><span class="label" style="color:var(--orange-text)">${esc(monthName(period))} offen</span><strong style="font-size:17px">${summary.drafts ? `${summary.drafts} ${summary.drafts === 1 ? 'Entwurf' : 'Entwürfe'} offen` : 'Bereit zum Abschluss'}</strong><small>Kontoabgleich und Sperre</small></a>`
  }
  const table = rows.length ? `<div class="table-wrap"><table class="list" style="min-width:900px">
<thead><tr><th>Zahlung</th><th>Buchung</th><th>Kategorie</th><th>Steuer</th><th>Beleg</th><th>Status</th><th class="r">Betrag</th></tr></thead>
<tbody>${rows.map(r => {
    const reversed = !!r.reversedById
    const docs = r.documents ? r.documents.split(',').map(n => `<span class="num" style="color:var(--orange-text)">${esc(n.replace(/^B-\d{4}-/, 'B-'))}</span>`).join(' ') : r.hasReason ? '<span class="badge">Eigenbeleg</span>' : '<span class="badge missing">fehlt</span>'
    const taxes = (r.taxCodes ?? '').split(',').filter(isTaxCode).map(c => TAX_CODES[c as TaxCode].short).join(', ')
    return `<tr><td class="num muted">${formatDate(r.paidOn).slice(0, 6)}</td>
<td${reversed ? ' class="strike"' : ''}><a class="cell-main" href="/buchungen/${r.id}">${esc(r.text)}</a><span class="cell-sub">${esc(r.counterparty || r.accountName)} · ${r.number ? `<span class="num">${esc(r.number)}</span>` : 'noch ohne Nummer'}</span></td>
<td class="muted">${esc(r.categories ?? '')}</td><td class="muted">${esc(taxes)}</td><td>${docs}</td><td>${statusBadge(r)}</td><td class="r">${amount(r.total, { strike: reversed })}</td></tr>`
  }).join('')}</tbody></table></div>` : `<p class="muted" style="padding:0 24px 24px">Keine Buchungen in diesem Zeitraum.</p>`
  const body = `${pageHead('Buchungen', '', ctx.readOnly ? '' : `<a class="btn btn-primary" href="/buchungen/neu">${icon('plus')}Neue Buchung</a>`)}
${hint(ctx.url)}
<div class="grid">
  <div class="tile"><span class="label">Einnahmen</span><span class="big" style="font-size:30px">${formatCents(income)}</span><small>${esc(isYear ? 'Jahr ' + period : monthName(period))}</small></div>
  <div class="tile"><span class="label">Ausgaben</span><span class="big" style="font-size:30px">${formatCents(-expense)}</span><small>Saldo ${formatCents(income + expense)}</small></div>
  ${monthCard}
</div>
<section class="card flush">
  <form class="filters" method="get" action="/buchungen" data-autosubmit>
    <div class="search">${icon('search')}<label class="sr" for="q">Suchen</label><input id="q" name="q" value="${esc(q)}" placeholder="Text, Gegenpartei oder Nummer"></div>
    <label class="sr" for="monat">Zeitraum</label><select id="monat" name="monat">${options}</select>
    <input type="hidden" name="status" value="${status}">
    <noscript><button class="btn btn-sm">Filtern</button></noscript>
    <nav class="seg-links" aria-label="Status">${pills}</nav>
  </form>
  ${table}
  <div class="table-foot"><span>Stornierte Buchungen bleiben sichtbar. Storno und Original heben sich auf.</span><span>${rows.length} ${rows.length === 1 ? 'Buchung' : 'Buchungen'}</span></div>
</section>`
  return html(page({ title: 'Buchungen', active: 'entries', body, readOnly: ctx.readOnly }))
}

function categoryOptions(categories: Category[], selected: string, keepId?: number): string {
  const groups: Array<[string, Category[]]> = []
  for (const c of categories.filter(c => c.active || c.id === keepId || String(c.id) === selected)) {
    const label = c.kind === 'income' ? 'Einnahmen' : c.kind === 'expense' ? 'Ausgaben' : c.kind === 'asset' ? 'Anlagegüter' : c.kind.startsWith('tax') ? 'Finanzamt' : 'Privat'
    let group = groups.find(g => g[0] === label)
    if (!group) groups.push(group = [label, []])
    group[1].push(c)
  }
  return `<option value="">Kategorie wählen</option>` + groups.map(([label, list]) => `<optgroup label="${label}">${list.map(c => `<option value="${c.id}" data-kind="${c.kind}" data-tax="${c.defaultTaxCode}"${String(c.id) === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('')
}

type Effect = { net: number; tax: number; gross: number; title: string; text: string; warn: boolean }

function effectFor(categories: Category[], line: EntryDraftForm['lines'][number], mode: 'small_business' | 'standard'): Effect | null {
  const category = categories.find(c => String(c.id) === line.categoryId)
  const gross = parseAmount(line.gross)
  if (!category || gross === null || !isTaxCode(line.taxCode)) return null
  const split = splitGross(gross, line.taxCode)
  return { ...split, ...lineEffect(category.kind, line.taxCode, mode, split, c => formatCents(c)) }
}

function lineCard(i: number, line: EntryDraftForm['lines'][number], categories: Category[], effect: Effect | null): string {
  const codes = (Object.keys(TAX_CODES) as TaxCode[]).map(code => `<label><input type="radio" name="line_tax_${i}" value="${code}"${line.taxCode === code ? ' checked' : ''}><span>${TAX_CODES[code].short}</span></label>`).join('')
  return `<div class="line-card" data-line>
  <div class="card-head" style="margin-bottom:8px"><label class="label" for="gross-${i}">${i === 0 ? 'Betrag laut Konto' : `Position ${i + 1}, Betrag`}</label>${i > 0 ? '<button type="button" class="btn btn-sm btn-ghost" data-remove-line>Entfernen</button>' : ''}</div>
  <div class="amount-input"><input id="gross-${i}" name="line_gross" class="num" inputmode="decimal" autocomplete="off" value="${esc(line.gross)}" placeholder="0,00"><span>€</span></div>
  <div class="form-grid" style="margin-top:16px"><div class="field"><label for="cat-${i}">Kategorie</label><select id="cat-${i}" name="line_category" data-category>${categoryOptions(categories, line.categoryId)}</select></div></div>
  <fieldset class="choice" style="margin-top:18px"><legend class="label">Umsatzsteuer</legend>${codes}</fieldset>
  <div class="split" data-split>
    <div><span>Netto</span><strong>${effect ? formatCents(effect.net) : '0,00 €'}</strong></div>
    <div><span>Steuer</span><strong>${effect ? formatCents(effect.tax) : '0,00 €'}</strong></div>
    <div><span>Brutto laut Beleg</span><strong>${effect ? formatCents(effect.gross) : '0,00 €'}</strong></div>
  </div>
  <div class="effect${effect?.warn ? ' warn' : ''}" data-effect aria-live="polite"${effect ? '' : ' hidden'}>${icon('info')}<div><strong>${esc(effect?.title ?? '')}</strong><span>${esc(effect?.text ?? '')}</span></div></div>
</div>`
}

async function entryForm(ctx: Ctx, opts: { raw: EntryDraftForm; entry?: EntryView; errors?: string[] }): Promise<string> {
  const db = ctx.env.DB
  const [categories, accounts, regimes, unlinked] = await Promise.all([loadCategories(db), loadAccounts(db), loadRegimes(db), listDocuments(db, { unlinked: true })])
  const raw = opts.raw
  const mode = regimeAt(regimes, raw.paidOn || ctx.today).mode
  const linkedIds = new Set(raw.documentIds)
  const linked = await Promise.all([...linkedIds].map(id => getDocument(db, Number(id))))
  const available = unlinked.filter(d => !linkedIds.has(String(d.id)))
  const lines = raw.lines.length ? raw.lines : [{ categoryId: '', taxCode: '', gross: '' }]
  const action = opts.entry ? `/buchungen/${opts.entry.id}` : '/buchungen'
  const fiscalOptions = raw.paidOn ? [Number(raw.paidOn.slice(0, 4)) - 1, Number(raw.paidOn.slice(0, 4)) + 1] : []
  const docList = linked.filter(Boolean).map(d => `<li><label class="check" style="flex:1;min-width:0"><input type="checkbox" name="document_id" value="${d!.id}" checked><span class="text"><strong>${esc(d!.filename)}</strong><span><span class="num">${esc(d!.number)}</span> · ${esc(DOC_KINDS[d!.kind])}</span></span></label><a class="btn btn-sm" href="/belege/${d!.id}" target="_blank" rel="noopener">Ansehen</a></li>`).join('')
  const preview = linked.find(d => d && d.mime.startsWith('image/') && !d.mime.includes('hei'))
  const auditRows = opts.entry ? await entryLog(db, opts.entry.id) : ''
  return `<form method="post" action="${action}" class="row" data-entry-form>
  <div class="grow stack">
    ${errorList(opts.errors ?? [])}
    <section class="card pad-lg" data-lines>
      ${lines.map((line, i) => lineCard(i, line, categories, effectFor(categories, line, mode))).join('')}
      <div class="actions" style="margin-top:20px"><button class="btn btn-sm" type="submit" name="then" value="add_line" data-add-line formnovalidate>${icon('plus')}Weitere Position</button><span class="muted" style="font-size:13px">etwa 19 % und 7 % auf einer Rechnung</span></div>
    </section>
    <section class="card pad-lg">
      <h2 class="label" style="margin-bottom:16px">Zahlung</h2>
      <div class="form-grid">
        <div class="field"><label for="paid_on">Zahlungsdatum</label><input id="paid_on" name="paid_on" type="date" value="${esc(raw.paidOn)}" required><small>zählt für EÜR und Voranmeldung</small></div>
        <div class="field"><label for="account_id">Konto</label><select id="account_id" name="account_id">${accounts.filter(a => a.active || String(a.id) === raw.accountId).map(a => `<option value="${a.id}"${String(a.id) === raw.accountId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="counterparty">Gegenpartei</label><input id="counterparty" name="counterparty" value="${esc(raw.counterparty)}" maxlength="200" autocomplete="off"></div>
        <div class="field"><label for="text">Buchungstext</label><input id="text" name="text" value="${esc(raw.text)}" maxlength="200" required></div>
        <div class="field"><label for="invoice_date">Rechnungsdatum</label><input id="invoice_date" name="invoice_date" type="date" value="${esc(raw.invoiceDate)}"></div>
        <div class="field"><label for="original_amount">Betrag in Originalwährung</label><div style="display:flex;gap:6px"><input id="original_amount" name="original_amount" class="num" inputmode="decimal" value="${esc(raw.originalAmount)}" style="flex:1;min-width:0"><label class="sr" for="currency">Währung</label><select id="currency" name="currency">${CURRENCIES.map(c => `<option${c === raw.currency ? ' selected' : ''}>${c}</option>`).join('')}</select></div><small>nur bei Rechnungen in fremder Währung</small></div>
        <div class="field"><label for="fiscal_year">Wirtschaftsjahr</label><select id="fiscal_year" name="fiscal_year"><option value="">wie Zahlungsdatum</option>${fiscalOptions.map(y => `<option value="${y}"${String(y) === raw.fiscalYear ? ' selected' : ''}>${y}</option>`).join('')}</select><small>nur für die 10-Tage-Regel um den Jahreswechsel</small></div>
      </div>
      <div class="field" style="margin-top:16px"><label for="reason">Notiz oder Begründung</label><textarea id="reason" name="reason" maxlength="500" style="min-height:80px">${esc(raw.reason)}</textarea><small>Pflicht, wenn kein Beleg vorliegt. Sie gilt dann als Eigenbeleg.</small></div>
    </section>
    ${ctx.readOnly ? '' : `<div class="actions">
      <button class="btn btn-primary btn-lg" type="submit" name="then" value="save">Als Entwurf speichern</button>
      <button class="btn btn-lg" type="submit" name="then" value="post" data-confirm="Festschreiben? Danach lässt sich die Buchung nur noch stornieren.">${icon('lock')}Speichern und festschreiben</button>
      <a class="btn btn-ghost btn-lg" href="/buchungen">Abbrechen</a>
    </div>`}
  </div>
  <aside class="side stack entry-side">
    <section class="card">
      <div class="card-head"><h2 class="label">Beleg</h2><a class="btn btn-sm" href="/belege" target="_blank" rel="noopener">${icon('upload')}Hochladen</a></div>
      ${preview ? `<img class="doc-preview" src="/belege/${preview.id}/datei" alt="" style="margin-bottom:14px">` : ''}
      ${docList ? `<ul class="doclist">${docList}</ul>` : '<p class="muted" style="margin:0 0 12px">Noch kein Beleg verknüpft.</p>'}
      ${available.length ? `<div class="field" style="margin-top:14px"><label for="add_doc">Offenen Beleg verknüpfen</label><select id="add_doc" name="document_id"><option value="">keiner</option>${available.map(d => `<option value="${d.id}">${esc(d.number)} · ${esc(d.filename)}</option>`).join('')}</select></div>` : ''}
    </section>
    ${auditRows ? `<section class="card"><h2 class="label" style="margin-bottom:12px">Protokoll</h2>${auditRows}</section>` : ''}
  </aside>
</form>`
}

async function entryLog(db: D1Database, id: number): Promise<string> {
  const { results } = await db.prepare(`SELECT at, actor, action, detail FROM audit_log WHERE subject = ? ORDER BY id`).bind(`entry:${id}`).all<{ at: string; actor: string; action: string; detail: string }>()
  if (!results.length) return ''
  return `<ol class="timeline">${results.map(r => `<li><time>${formatDateTime(r.at)}</time>${esc(ACTION_LABELS[r.action] ?? r.action)}${r.action === 'entry.reverse' ? ': ' + esc(JSON.parse(r.detail || '{}').reason ?? '') : ''} <span class="muted">${esc(r.actor)}</span></li>`).join('')}</ol>`
}

function emptyForm(ctx: Ctx, documentId?: string): EntryDraftForm {
  return { paidOn: ctx.today, invoiceDate: '', fiscalYear: '', text: '', counterparty: '', accountId: '1', currency: 'EUR', originalAmount: '', reason: '', lines: [{ categoryId: '', taxCode: '', gross: '' }], documentIds: documentId ? [documentId] : [] }
}

export async function newEntryPage(ctx: Ctx): Promise<Response> {
  const beleg = ctx.url.searchParams.get('beleg')
  const raw = emptyForm(ctx, beleg && /^\d+$/.test(beleg) ? beleg : undefined)
  if (beleg) {
    const doc = await getDocument(ctx.env.DB, Number(beleg))
    if (doc) raw.text = doc.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 200)
  }
  const body = `${pageHead('Neue Buchung', 'Wird als Entwurf gespeichert.', '<span class="badge draft">Entwurf</span>', { href: '/buchungen', label: 'Buchungen' })}
${await entryForm(ctx, { raw })}`
  return html(page({ title: 'Neue Buchung', active: 'entries', body, readOnly: ctx.readOnly }))
}

async function saveFromForm(ctx: Ctx, id: number | null): Promise<Response> {
  const form = await readForm(ctx.request)
  const raw = readEntryForm(form)
  const then = field(form, 'then')
  const existing = id === null ? undefined : (await getEntry(ctx.env.DB, id)) ?? undefined
  if (id !== null && !existing) throw new HttpError(404, 'Diese Buchung gibt es nicht.')
  if (existing && existing.status !== 'draft') throw new HttpError(409, 'Nur Entwürfe lassen sich ändern.')
  const title = existing ? 'Entwurf bearbeiten' : 'Neue Buchung'
  const render = async (errors: string[]) => html(page({ title, active: 'entries', readOnly: ctx.readOnly, body: `${pageHead(title, '', '<span class="badge draft">Entwurf</span>', { href: '/buchungen', label: 'Buchungen' })}${await entryForm(ctx, { raw, entry: existing, errors })}` }), errors.length ? 400 : 200)
  if (then === 'add_line') {
    raw.lines.push({ categoryId: '', taxCode: '', gross: '' })
    return render([])
  }
  const [categories, accounts] = await Promise.all([loadCategories(ctx.env.DB), loadAccounts(ctx.env.DB)])
  const { input, errors } = validateEntry(raw, categories, accounts, existing?.lines.map(l => l.categoryId) ?? [])
  if (!input) return render(errors)
  let entryId = id
  try {
    if (entryId === null) entryId = await createDraft(ctx.env.DB, input, ctx.actor)
    else await updateDraft(ctx.env.DB, entryId, input, ctx.actor)
  } catch (error) {
    if (error instanceof HttpError) throw error
    const guard = guardMessage(error)
    if (!guard) throw error
    return render([guard])
  }
  if (then === 'post') {
    try { await postEntry(ctx.env.DB, entryId, ctx.actor) }
    catch (error) {
      const message = error instanceof HttpError ? error.message : guardMessage(error)
      if (!message) throw error
      return redirect(`/buchungen/${entryId}?fehler=${encodeURIComponent(message)}`)
    }
    return redirect(`/buchungen/${entryId}?hinweis=festgeschrieben`)
  }
  return redirect(`/buchungen/${entryId}?hinweis=entwurf`)
}


export const createEntryAction = (ctx: Ctx) => saveFromForm(ctx, null)
export const updateEntryAction = (ctx: Ctx, id: number) => saveFromForm(ctx, id)

export async function entryPage(ctx: Ctx, id: number): Promise<Response> {
  const entry = await getEntry(ctx.env.DB, id)
  if (!entry) throw new HttpError(404, 'Diese Buchung gibt es nicht.')
  const failed = ctx.url.searchParams.get('fehler')
  const banner = `${hint(ctx.url)}${failed ? errorList([failed.slice(0, 300)]) : ''}`
  if (entry.status === 'draft') {
    const raw: EntryDraftForm = {
      paidOn: entry.paidOn, invoiceDate: entry.invoiceDate ?? '', fiscalYear: entry.fiscalYear ? String(entry.fiscalYear) : '', text: entry.text,
      counterparty: entry.counterparty, accountId: String(entry.accountId), currency: entry.currency, originalAmount: entry.originalAmount === null ? '' : plainCents(entry.originalAmount),
      reason: entry.reason, lines: entry.lines.map(l => ({ categoryId: String(l.categoryId), taxCode: l.taxCode, gross: plainCents(l.gross) })), documentIds: entry.documents.map(d => String(d.id))
    }
    const discard = ctx.readOnly ? '' : `<form method="post" action="/buchungen/${id}/verwerfen"><button class="btn btn-ghost" data-confirm="Entwurf verwerfen? Er bleibt im Protokoll sichtbar.">Verwerfen</button></form>`
    const body = `${pageHead('Entwurf bearbeiten', `Angelegt am ${formatDateTime(entry.createdAt)}`, `<span class="badge draft">Entwurf</span>${discard}`, { href: '/buchungen', label: 'Buchungen' })}
${banner}
${await entryForm(ctx, { raw, entry })}`
    return html(page({ title: entry.text, active: 'entries', body, readOnly: ctx.readOnly }))
  }
  const regimes = await loadRegimes(ctx.env.DB)
  const mode = regimeAt(regimes, entry.paidOn).mode
  const lines = entry.lines.map(l => `<tr><td><span class="cell-main">${esc(l.categoryName)}</span><span class="cell-sub">${esc(KIND_LABELS[l.kind])}</span></td><td class="muted">${esc(TAX_CODES[l.taxCode].short)}</td><td class="r num">${formatCents(l.net)}</td><td class="r num">${formatCents(l.tax)}</td><td class="r num">${formatCents(l.gross)}</td></tr>`).join('')
  const effects = entry.lines.map(l => lineEffect(l.kind, l.taxCode, mode, l, c => formatCents(c)))
  const relation = entry.reversesId
    ? `<p>Storniert <a href="/buchungen/${entry.reversesId}">${esc(entry.reversesNumber ?? '')}</a>. Begründung: ${esc(entry.reason)}</p>`
    : entry.reversedById ? `<p>Storniert durch <a href="/buchungen/${entry.reversedById}">${esc(entry.reversedByNumber ?? '')}</a>.</p>` : ''
  const canReverse = !ctx.readOnly && entry.status === 'posted' && !entry.reversesId && !entry.reversedById
  const docs = entry.documents.length
    ? `<ul class="doclist">${entry.documents.map(d => `<li><span class="text"><a href="/belege/${d.id}">${esc(d.filename)}</a><span class="num">${esc(d.number)}</span></span></li>`).join('')}</ul>`
    : `<p class="muted">Kein Beleg. Eigenbeleg: ${esc(entry.reason)}</p>`
  const body = `${pageHead(entry.number ? `${entry.number}` : 'Verworfener Entwurf', esc(entry.text), statusBadge({ status: entry.status, reversesId: entry.reversesId, reversedById: entry.reversedById }), { href: '/buchungen', label: 'Buchungen' })}
${banner}
<div class="row">
  <div class="grow stack">
    <section class="card pad-lg">
      <span class="label">${entry.total >= 0 ? 'Eingang' : 'Ausgang'}</span>
      <span class="hero-number" style="font-size:clamp(40px,6vw,64px)">${formatCents(entry.total, { sign: true })}</span>
      ${relation}
      <div class="table-wrap" style="margin:20px -32px 0"><table class="list"><thead><tr><th>Position</th><th>Steuer</th><th class="r">Netto</th><th class="r">Steuer</th><th class="r">Brutto</th></tr></thead><tbody>${lines}</tbody></table></div>
      ${effects.map(e => `<div class="effect${e.warn ? ' warn' : ''}">${icon('info')}<div><strong>${esc(e.title)}</strong><span>${esc(e.text)}</span></div></div>`).join('')}
    </section>
    <section class="card pad-lg"><h2 class="label">Zahlung</h2>
      <dl class="meta">
        <dt>Zahlungsdatum</dt><dd>${formatDate(entry.paidOn)}${entry.fiscalYear ? ` · Wirtschaftsjahr ${entry.fiscalYear}` : ''}</dd>
        ${entry.invoiceDate ? `<dt>Rechnungsdatum</dt><dd>${formatDate(entry.invoiceDate)}</dd>` : ''}
        <dt>Konto</dt><dd>${esc(entry.accountName)}</dd>
        <dt>Gegenpartei</dt><dd>${esc(entry.counterparty || '')}</dd>
        ${entry.originalAmount !== null ? `<dt>Originalbetrag</dt><dd class="num">${plainCents(entry.originalAmount)} ${esc(entry.currency)}</dd>` : ''}
        ${entry.reason && !entry.reversesId ? `<dt>Notiz</dt><dd>${esc(entry.reason)}</dd>` : ''}
        ${entry.postedAt ? `<dt>Festgeschrieben</dt><dd>${formatDateTime(entry.postedAt)} von ${esc(entry.postedBy ?? '')}</dd>` : ''}
      </dl>
    </section>
    ${canReverse ? `<details class="card"><summary style="cursor:pointer;font-weight:700">Stornieren</summary>
      <p class="muted" style="font-size:14px">Der Storno ist eine neue Buchung mit umgekehrten Beträgen und demselben Zahlungsdatum. Danach die richtige Buchung neu anlegen.</p>
      <form method="post" action="/buchungen/${id}/storno" class="stack" style="gap:12px"><div class="field"><label for="reason">Begründung</label><input id="reason" name="reason" required maxlength="500" placeholder="etwa: falscher Betrag"></div>
      <div><button class="btn btn-primary" data-confirm="Buchung stornieren?">Stornieren</button></div></form></details>` : ''}
  </div>
  <aside class="side stack">
    <section class="card"><h2 class="label" style="margin-bottom:12px">Beleg</h2>${docs}</section>
    <section class="card"><h2 class="label" style="margin-bottom:12px">Protokoll</h2>${await entryLog(ctx.env.DB, id)}</section>
  </aside>
</div>`
  return html(page({ title: entry.number ?? entry.text, active: 'entries', body, readOnly: ctx.readOnly }))
}

export async function postEntryAction(ctx: Ctx, id: number): Promise<Response> {
  await postEntry(ctx.env.DB, id, ctx.actor)
  return redirect(`/buchungen/${id}?hinweis=festgeschrieben`)
}

export async function discardEntryAction(ctx: Ctx, id: number): Promise<Response> {
  await discardDraft(ctx.env.DB, id, ctx.actor)
  return redirect(`/buchungen?hinweis=verworfen`)
}

export async function reverseEntryAction(ctx: Ctx, id: number): Promise<Response> {
  const form = await readForm(ctx.request)
  const stornoId = await reverseEntry(ctx.env.DB, id, field(form, 'reason'), ctx.actor)
  return redirect(`/buchungen/${stornoId}?hinweis=storniert`)
}

/** Live preview for the entry form: net, tax and the hint for every line, computed by the same code as on save. */
export async function previewAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const raw = readEntryForm(form)
  const [categories, regimes] = await Promise.all([loadCategories(ctx.env.DB), loadRegimes(ctx.env.DB)])
  const mode = regimeAt(regimes, raw.paidOn || ctx.today).mode
  const lines = raw.lines.map(line => {
    const effect = effectFor(categories, line, mode)
    return effect ? { net: formatCents(effect.net), tax: formatCents(effect.tax), gross: formatCents(effect.gross), title: effect.title, text: effect.text, warn: effect.warn } : null
  })
  return Response.json({ lines }, { headers: { 'cache-control': 'no-store' } })
}

