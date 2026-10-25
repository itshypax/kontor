import { audit } from './audit'
import type { Account, Category } from './catalog'
import { direction } from './catalog'
import { field, fields, HttpError } from './http'
import { parseAmount } from './money'
import { isTaxCode, splitGross } from './tax'
import { isDate, isoSeconds } from './time'
import type { CategoryKind, EntryStatus, TaxCode } from './types'

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF']

export type LineInput = { categoryId: number; taxCode: TaxCode; gross: number }
export type EntryInput = {
  paidOn: string
  invoiceDate: string | null
  fiscalYear: number | null
  text: string
  counterparty: string
  accountId: number
  currency: string
  originalAmount: number | null
  reason: string
  lines: LineInput[]
  documentIds: number[]
}

/** What the form sent, as typed, so a rejected form comes back filled in. */
export type EntryDraftForm = {
  paidOn: string
  invoiceDate: string
  fiscalYear: string
  text: string
  counterparty: string
  accountId: string
  currency: string
  originalAmount: string
  reason: string
  lines: Array<{ categoryId: string; taxCode: string; gross: string }>
  documentIds: string[]
}

export function readEntryForm(form: FormData): EntryDraftForm {
  const categories = fields(form, 'line_category')
  const taxCodes = fields(form, 'line_tax')
  const amounts = fields(form, 'line_gross')
  const lines: EntryDraftForm['lines'] = []
  for (let i = 0; i < Math.max(categories.length, amounts.length); i++) {
    // Radio groups are named per row, since several rows each need their own choice.
    const code = field(form, `line_tax_${i}`) || taxCodes[i] || ''
    lines.push({ categoryId: categories[i] ?? '', taxCode: code, gross: amounts[i] ?? '' })
  }
  return {
    paidOn: field(form, 'paid_on'), invoiceDate: field(form, 'invoice_date'), fiscalYear: field(form, 'fiscal_year'),
    text: field(form, 'text'), counterparty: field(form, 'counterparty'), accountId: field(form, 'account_id'),
    currency: field(form, 'currency') || 'EUR', originalAmount: field(form, 'original_amount'), reason: field(form, 'reason'),
    lines, documentIds: fields(form, 'document_id').filter(Boolean)
  }
}

export function validateEntry(raw: EntryDraftForm, categories: Category[], accounts: Account[], existingCategoryIds: number[] = []): { input: EntryInput | null; errors: string[] } {
  const errors: string[] = []
  if (!isDate(raw.paidOn)) errors.push('Das Zahlungsdatum fehlt oder ist ungültig.')
  if (raw.invoiceDate && !isDate(raw.invoiceDate)) errors.push('Das Rechnungsdatum ist ungültig.')
  let fiscalYear: number | null = null
  if (raw.fiscalYear) {
    fiscalYear = Number(raw.fiscalYear)
    const paidYear = Number(raw.paidOn.slice(0, 4))
    if (!Number.isInteger(fiscalYear) || Math.abs(fiscalYear - paidYear) > 1) errors.push('Ein abweichendes Wirtschaftsjahr darf nur ein Jahr vom Zahlungsjahr abweichen.')
  }
  if (!raw.text) errors.push('Der Buchungstext fehlt.')
  if (raw.text.length > 200 || raw.counterparty.length > 200) errors.push('Text und Gegenpartei dürfen höchstens 200 Zeichen haben.')
  const account = accounts.find(a => String(a.id) === raw.accountId)
  if (!account || !account.active) errors.push('Bitte ein aktives Konto wählen.')
  if (!CURRENCIES.includes(raw.currency)) errors.push('Unbekannte Währung.')
  let originalAmount: number | null = null
  if (raw.originalAmount) {
    originalAmount = parseAmount(raw.originalAmount)
    if (originalAmount === null) errors.push('Der Betrag in Originalwährung ist ungültig.')
  }
  if (raw.reason.length > 500) errors.push('Die Begründung darf höchstens 500 Zeichen haben.')
  const lines: LineInput[] = []
  raw.lines.forEach((line, i) => {
    if (!line.gross && !line.categoryId) return
    const label = raw.lines.length > 1 ? `Position ${i + 1}: ` : ''
    const category = categories.find(c => String(c.id) === line.categoryId)
    if (!category || (!category.active && !existingCategoryIds.includes(category.id))) errors.push(label + 'Bitte eine Kategorie wählen.')
    if (!isTaxCode(line.taxCode)) errors.push(label + 'Bitte einen Steuerschlüssel wählen.')
    const gross = parseAmount(line.gross)
    if (gross === null || gross === 0) errors.push(label + 'Der Betrag fehlt oder ist ungültig.')
    if (category && isTaxCode(line.taxCode) && gross) lines.push({ categoryId: category.id, taxCode: line.taxCode, gross })
  })
  if (!raw.lines.some(l => l.gross || l.categoryId)) errors.push('Mindestens eine Position mit Betrag fehlt.')
  const documentIds = [...new Set(raw.documentIds.map(Number))].filter(n => Number.isInteger(n) && n > 0)
  if (errors.length) return { input: null, errors }
  return {
    input: { paidOn: raw.paidOn, invoiceDate: raw.invoiceDate || null, fiscalYear, text: raw.text, counterparty: raw.counterparty, accountId: account!.id, currency: raw.currency, originalAmount, reason: raw.reason, lines, documentIds },
    errors
  }
}

function lineStatements(db: D1Database, entryId: number | null, input: EntryInput): D1PreparedStatement[] {
  // A new entry is the last one inserted in this batch; the batch is one transaction.
  const target = entryId === null ? '(SELECT MAX(id) FROM entries)' : '?'
  const out: D1PreparedStatement[] = []
  input.lines.forEach((line, i) => {
    const { net, tax, gross } = splitGross(line.gross, line.taxCode)
    const values = [line.categoryId, line.taxCode, net, tax, gross, i]
    out.push(db.prepare(`INSERT INTO entry_lines (entry_id, category_id, tax_code, net, tax, gross, sort) VALUES (${target}, ?, ?, ?, ?, ?, ?)`)
      .bind(...(entryId === null ? values : [entryId, ...values])))
  })
  for (const documentId of input.documentIds) {
    out.push(db.prepare(`INSERT OR IGNORE INTO entry_documents (entry_id, document_id) SELECT ${target}, id FROM documents WHERE id = ?`)
      .bind(...(entryId === null ? [documentId] : [entryId, documentId])))
  }
  return out
}

export async function createDraft(db: D1Database, input: EntryInput, actor: string): Promise<number> {
  const results = await db.batch([
    db.prepare(`INSERT INTO entries (paid_on, invoice_date, fiscal_year, text, counterparty, account_id, currency, original_amount, reason, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.paidOn, input.invoiceDate, input.fiscalYear, input.text, input.counterparty, input.accountId, input.currency, input.originalAmount, input.reason, isoSeconds(), actor),
    ...lineStatements(db, null, input),
    db.prepare(`INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?, ?, 'entry.create', 'entry:' || (SELECT MAX(id) FROM entries), ?)`)
      .bind(isoSeconds(), actor, JSON.stringify(input))
  ])
  return Number((results[0] as D1Result).meta.last_row_id)
}

export async function updateDraft(db: D1Database, id: number, input: EntryInput, actor: string): Promise<void> {
  const before = await getEntry(db, id)
  if (!before) throw new HttpError(404, 'Diese Buchung gibt es nicht.')
  if (before.status !== 'draft') throw new HttpError(409, 'Nur Entwürfe lassen sich ändern.')
  await db.batch([
    db.prepare(`UPDATE entries SET paid_on = ?, invoice_date = ?, fiscal_year = ?, text = ?, counterparty = ?, account_id = ?, currency = ?, original_amount = ?, reason = ?
      WHERE id = ? AND status = 'draft'`)
      .bind(input.paidOn, input.invoiceDate, input.fiscalYear, input.text, input.counterparty, input.accountId, input.currency, input.originalAmount, input.reason, id),
    db.prepare('DELETE FROM entry_lines WHERE entry_id = ?').bind(id),
    db.prepare('DELETE FROM entry_documents WHERE entry_id = ?').bind(id),
    ...lineStatements(db, id, input),
    audit(db, actor, 'entry.update', `entry:${id}`, { before: snapshot(before), after: input })
  ])
}

function nextNumber(year: number): { sql: string; binds: string[] } {
  return {
    sql: `(SELECT ?1 || '-' || printf('%04d', COALESCE(MAX(CAST(substr(number, 6) AS INTEGER)), 0) + 1) FROM entries WHERE number LIKE ?1 || '-%')`,
    binds: [String(year)]
  }
}

export async function postEntry(db: D1Database, id: number, actor: string): Promise<string> {
  const entry = await getEntry(db, id)
  if (!entry) throw new HttpError(404, 'Diese Buchung gibt es nicht.')
  if (entry.status !== 'draft') throw new HttpError(409, 'Diese Buchung ist schon festgeschrieben oder verworfen.')
  if (!entry.lines.length) throw new HttpError(400, 'Eine Buchung braucht mindestens eine Position.')
  if (!entry.documents.length && !entry.reason) throw new HttpError(400, 'Ohne Beleg braucht die Buchung eine Begründung, sie dient dann als Eigenbeleg.')
  const year = entry.fiscalYear ?? Number(entry.paidOn.slice(0, 4))
  const number = nextNumber(year)
  await db.batch([
    db.prepare(`UPDATE entries SET status = 'posted', number = ${number.sql}, posted_at = ?2, posted_by = ?3 WHERE id = ?4 AND status = 'draft'`)
      .bind(...number.binds, isoSeconds(), actor, id),
    db.prepare(`INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?, ?, 'entry.post', ?, (SELECT number FROM entries WHERE id = ?))`)
      .bind(isoSeconds(), actor, `entry:${id}`, id)
  ])
  const row = await db.prepare('SELECT number FROM entries WHERE id = ?').bind(id).first<{ number: string }>()
  return row!.number
}

export async function discardDraft(db: D1Database, id: number, actor: string): Promise<void> {
  const entry = await getEntry(db, id)
  if (!entry) throw new HttpError(404, 'Diese Buchung gibt es nicht.')
  if (entry.status !== 'draft') throw new HttpError(409, 'Nur Entwürfe lassen sich verwerfen. Festgeschriebenes wird storniert.')
  await db.batch([
    db.prepare(`UPDATE entries SET status = 'discarded' WHERE id = ? AND status = 'draft'`).bind(id),
    audit(db, actor, 'entry.discard', `entry:${id}`, snapshot(entry))
  ])
}

/**
 * A reversal is a new posted entry with every line negated, the same payment
 * date and the same documents. It is built as a draft and posted in one
 * transaction, so the guards on lines apply to it as to anything else.
 */
export async function reverseEntry(db: D1Database, id: number, reason: string, actor: string): Promise<number> {
  if (!reason) throw new HttpError(400, 'Bitte begründen, warum storniert wird.')
  const entry = await getEntry(db, id)
  if (!entry) throw new HttpError(404, 'Diese Buchung gibt es nicht.')
  if (entry.status !== 'posted') throw new HttpError(409, 'Nur festgeschriebene Buchungen werden storniert. Einen Entwurf einfach verwerfen.')
  if (entry.reversesId) throw new HttpError(409, 'Ein Storno wird nicht storniert. Buche den Vorgang stattdessen neu.')
  if (entry.reversedById) throw new HttpError(409, 'Diese Buchung ist schon storniert.')
  const year = entry.fiscalYear ?? Number(entry.paidOn.slice(0, 4))
  const number = nextNumber(year)
  const target = '(SELECT id FROM entries WHERE reverses_id = ?)'
  await db.batch([
    db.prepare(`INSERT INTO entries (paid_on, invoice_date, fiscal_year, text, counterparty, account_id, currency, original_amount, reverses_id, reason, created_at, created_by)
      SELECT paid_on, invoice_date, fiscal_year, 'Storno zu ' || number || ': ' || text, counterparty, account_id, currency, -original_amount, id, ?, ?, ? FROM entries WHERE id = ?`)
      .bind(reason.slice(0, 500), isoSeconds(), actor, id),
    db.prepare(`INSERT INTO entry_lines (entry_id, category_id, tax_code, net, tax, gross, sort) SELECT ${target}, category_id, tax_code, -net, -tax, -gross, sort FROM entry_lines WHERE entry_id = ?`).bind(id, id),
    db.prepare(`INSERT INTO entry_documents (entry_id, document_id) SELECT ${target}, document_id FROM entry_documents WHERE entry_id = ?`).bind(id, id),
    db.prepare(`UPDATE entries SET status = 'posted', number = ${number.sql}, posted_at = ?2, posted_by = ?3 WHERE reverses_id = ?4`).bind(...number.binds, isoSeconds(), actor, id),
    audit(db, actor, 'entry.reverse', `entry:${id}`, { reason })
  ])
  const row = await db.prepare('SELECT id FROM entries WHERE reverses_id = ?').bind(id).first<{ id: number }>()
  return row!.id
}

export type EntryLine = { categoryId: number; categoryName: string; kind: CategoryKind; position: string; taxCode: TaxCode; net: number; tax: number; gross: number }
export type EntryView = {
  id: number
  number: string | null
  status: EntryStatus
  paidOn: string
  invoiceDate: string | null
  fiscalYear: number | null
  text: string
  counterparty: string
  accountId: number
  accountName: string
  currency: string
  originalAmount: number | null
  reversesId: number | null
  reversesNumber: string | null
  reversedById: number | null
  reversedByNumber: string | null
  reason: string
  createdAt: string
  createdBy: string
  postedAt: string | null
  postedBy: string | null
  lines: EntryLine[]
  documents: Array<{ id: number; number: string; filename: string; mime: string }>
  total: number
}

function snapshot(entry: EntryView) {
  return { paidOn: entry.paidOn, text: entry.text, counterparty: entry.counterparty, accountId: entry.accountId, reason: entry.reason, lines: entry.lines.map(l => ({ categoryId: l.categoryId, taxCode: l.taxCode, gross: l.gross })), documents: entry.documents.map(d => d.id) }
}

export async function getEntry(db: D1Database, id: number): Promise<EntryView | null> {
  const row = await db.prepare(`SELECT e.*, a.name AS account_name, r.number AS reverses_number, rb.id AS reversed_by_id, rb.number AS reversed_by_number
    FROM entries e JOIN accounts a ON a.id = e.account_id LEFT JOIN entries r ON r.id = e.reverses_id LEFT JOIN entries rb ON rb.reverses_id = e.id
    WHERE e.id = ?`).bind(id).first<Record<string, unknown>>()
  if (!row) return null
  const { results: lines } = await db.prepare(`SELECT l.category_id AS categoryId, c.name AS categoryName, c.kind, c.position, l.tax_code AS taxCode, l.net, l.tax, l.gross
    FROM entry_lines l JOIN categories c ON c.id = l.category_id WHERE l.entry_id = ? ORDER BY l.sort, l.id`).bind(id).all<EntryLine>()
  const { results: documents } = await db.prepare(`SELECT d.id, d.number, d.filename, d.mime FROM entry_documents ed JOIN documents d ON d.id = ed.document_id WHERE ed.entry_id = ? ORDER BY d.id`)
    .bind(id).all<{ id: number; number: string; filename: string; mime: string }>()
  return {
    id: row.id as number, number: row.number as string | null, status: row.status as EntryStatus, paidOn: row.paid_on as string,
    invoiceDate: row.invoice_date as string | null, fiscalYear: row.fiscal_year as number | null, text: row.text as string,
    counterparty: row.counterparty as string, accountId: row.account_id as number, accountName: row.account_name as string,
    currency: row.currency as string, originalAmount: row.original_amount as number | null,
    reversesId: row.reverses_id as number | null, reversesNumber: row.reverses_number as string | null,
    reversedById: row.reversed_by_id as number | null, reversedByNumber: row.reversed_by_number as string | null,
    reason: row.reason as string, createdAt: row.created_at as string, createdBy: row.created_by as string,
    postedAt: row.posted_at as string | null, postedBy: row.posted_by as string | null,
    lines, documents, total: lines.reduce((sum, l) => sum + direction(l.kind) * l.gross, 0)
  }
}

export type EntryRow = {
  id: number
  number: string | null
  status: EntryStatus
  paidOn: string
  text: string
  counterparty: string
  accountName: string
  categories: string
  taxCodes: string
  documents: string
  total: number
  inflow: number
  outflow: number
  hasReason: number
  reversesId: number | null
  reversedById: number | null
}

export type EntryFilter = { from?: string; to?: string; status?: 'draft' | 'posted' | 'storno' | 'all'; q?: string; limit?: number }

export async function listEntries(db: D1Database, filter: EntryFilter = {}): Promise<EntryRow[]> {
  const where = ["e.status <> 'discarded'"]
  const binds: unknown[] = []
  if (filter.from) { where.push('e.paid_on >= ?'); binds.push(filter.from) }
  if (filter.to) { where.push('e.paid_on <= ?'); binds.push(filter.to) }
  if (filter.status === 'draft') where.push("e.status = 'draft'")
  if (filter.status === 'posted') where.push("e.status = 'posted' AND e.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.reverses_id = e.id)")
  if (filter.status === 'storno') where.push('(e.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM entries x WHERE x.reverses_id = e.id))')
  if (filter.q) {
    where.push('(e.text LIKE ? OR e.counterparty LIKE ? OR e.number LIKE ?)')
    const like = `%${filter.q.replace(/[%_]/g, '')}%`
    binds.push(like, like, like)
  }
  const { results } = await db.prepare(`SELECT e.id, e.number, e.status, e.paid_on AS paidOn, e.text, e.counterparty, a.name AS accountName,
      (SELECT group_concat(DISTINCT c.name) FROM entry_lines l JOIN categories c ON c.id = l.category_id WHERE l.entry_id = e.id) AS categories,
      (SELECT group_concat(DISTINCT l.tax_code) FROM entry_lines l WHERE l.entry_id = e.id) AS taxCodes,
      (SELECT group_concat(d.number) FROM entry_documents ed JOIN documents d ON d.id = ed.document_id WHERE ed.entry_id = e.id) AS documents,
      COALESCE((SELECT SUM(CASE WHEN c.kind IN ('income', 'tax_refund', 'private_in') THEN l.gross ELSE -l.gross END) FROM entry_lines l JOIN categories c ON c.id = l.category_id WHERE l.entry_id = e.id), 0) AS total,
      COALESCE((SELECT SUM(l.gross) FROM entry_lines l JOIN categories c ON c.id = l.category_id WHERE l.entry_id = e.id AND c.kind IN ('income', 'tax_refund')), 0) AS inflow,
      COALESCE((SELECT SUM(l.gross) FROM entry_lines l JOIN categories c ON c.id = l.category_id WHERE l.entry_id = e.id AND c.kind IN ('expense', 'asset', 'tax_payment')), 0) AS outflow,
      e.reason <> '' AS hasReason,
      e.reverses_id AS reversesId, (SELECT x.id FROM entries x WHERE x.reverses_id = e.id) AS reversedById
    FROM entries e JOIN accounts a ON a.id = e.account_id
    WHERE ${where.join(' AND ')} ORDER BY e.paid_on DESC, e.id DESC LIMIT ?`).bind(...binds, filter.limit ?? 500).all<EntryRow>()
  return results
}
