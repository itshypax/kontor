import { audit } from './audit'
import { loadAccounts } from './catalog'
import { HttpError } from './http'
import { isoSeconds, periodRange } from './time'

export type AccountBalance = { accountId: number; name: string; booked: number; bank: number | null; difference: number | null }
export type MonthSummary = {
  month: string
  drafts: number
  income: number
  expense: number
  locked: { at: string; by: string } | null
  balances: AccountBalance[]
}

/** Booked balance of each reconciled account at the end of the month, next to what the bank said. */
export async function monthSummary(db: D1Database, month: string): Promise<MonthSummary> {
  const range = periodRange(month)
  if (!range) throw new HttpError(400, 'Ungültiger Monat.')
  const period = await db.prepare('SELECT balances, locked_at, locked_by FROM periods WHERE month = ?').bind(month)
    .first<{ balances: string; locked_at: string | null; locked_by: string | null }>()
  const bank = JSON.parse(period?.balances ?? '{}') as Record<string, number>
  const sums = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM entries WHERE status = 'draft' AND paid_on BETWEEN ?1 AND ?2) AS drafts,
      (SELECT COALESCE(SUM(l.gross), 0) FROM entry_lines l JOIN entries e ON e.id = l.entry_id JOIN categories c ON c.id = l.category_id
        WHERE e.status <> 'discarded' AND e.paid_on BETWEEN ?1 AND ?2 AND c.kind IN ('income', 'tax_refund')) AS income,
      (SELECT COALESCE(SUM(l.gross), 0) FROM entry_lines l JOIN entries e ON e.id = l.entry_id JOIN categories c ON c.id = l.category_id
        WHERE e.status <> 'discarded' AND e.paid_on BETWEEN ?1 AND ?2 AND c.kind IN ('expense', 'asset', 'tax_payment')) AS expense`)
    .bind(range.from, range.to).first<{ drafts: number; income: number; expense: number }>()
  const accounts = (await loadAccounts(db)).filter(a => a.reconcile)
  const balances: AccountBalance[] = []
  for (const account of accounts) {
    const row = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN c.kind IN ('income', 'tax_refund', 'private_in') THEN l.gross ELSE -l.gross END), 0) AS moved
      FROM entry_lines l JOIN entries e ON e.id = l.entry_id JOIN categories c ON c.id = l.category_id
      WHERE e.status <> 'discarded' AND e.account_id = ? AND e.paid_on <= ?`).bind(account.id, range.to).first<{ moved: number }>()
    const booked = account.openingBalance + (row?.moved ?? 0)
    const bankValue = bank[String(account.id)] ?? null
    balances.push({ accountId: account.id, name: account.name, booked, bank: bankValue, difference: bankValue === null ? null : bankValue - booked })
  }
  return {
    month, drafts: sums?.drafts ?? 0, income: sums?.income ?? 0, expense: sums?.expense ?? 0,
    locked: period?.locked_at ? { at: period.locked_at, by: period.locked_by ?? '' } : null, balances
  }
}

/**
 * Closing a month needs every draft in it posted or discarded and the bank
 * balances entered. A difference is allowed only when it is explained, and
 * the explanation goes into the audit log.
 */
export async function closeMonth(db: D1Database, month: string, bank: Record<string, number>, explanation: string, actor: string): Promise<void> {
  const summary = await monthSummary(db, month)
  if (summary.locked) throw new HttpError(409, 'Dieser Monat ist schon abgeschlossen.')
  if (summary.drafts) throw new HttpError(409, `Im Monat liegen noch ${summary.drafts} Entwürfe. Erst festschreiben oder verwerfen.`)
  const missing = summary.balances.filter(b => bank[String(b.accountId)] === undefined)
  if (missing.length) throw new HttpError(400, `Kontostand fehlt für: ${missing.map(m => m.name).join(', ')}.`)
  const differences = summary.balances.map(b => ({ name: b.name, difference: bank[String(b.accountId)]! - b.booked })).filter(d => d.difference !== 0)
  if (differences.length && !explanation) throw new HttpError(400, 'Kontostand und Buchungen weichen ab. Bitte die Abweichung erklären oder fehlende Buchungen nachtragen.')
  await db.batch([
    db.prepare(`INSERT INTO periods (month, balances, locked_at, locked_by) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(month) DO UPDATE SET balances = ?2, locked_at = ?3, locked_by = ?4`).bind(month, JSON.stringify(bank), isoSeconds(), actor),
    audit(db, actor, 'month.close', `month:${month}`, { bank, differences, explanation })
  ])
}

export async function lockedMonths(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT month FROM periods WHERE locked_at IS NOT NULL').all<{ month: string }>()
  return new Set(results.map(r => r.month))
}
