import type { CategoryKind, TaxCode } from './types'

export type Category = { id: number; name: string; kind: CategoryKind; position: string; defaultTaxCode: TaxCode; active: boolean; sort: number }
export type Account = { id: number; name: string; reconcile: boolean; openingBalance: number; active: boolean; sort: number }

export const KIND_LABELS: Record<CategoryKind, string> = {
  income: 'Einnahme',
  expense: 'Ausgabe',
  asset: 'Anlagegut',
  tax_payment: 'Zahlung an das Finanzamt',
  tax_refund: 'Erstattung vom Finanzamt',
  private_in: 'Privateinlage',
  private_out: 'Privatentnahme'
}

/** +1 when money comes in, -1 when it goes out. */
export function direction(kind: CategoryKind): 1 | -1 {
  return kind === 'income' || kind === 'tax_refund' || kind === 'private_in' ? 1 : -1
}

export async function loadCategories(db: D1Database): Promise<Category[]> {
  const { results } = await db.prepare('SELECT id, name, kind, position, default_tax_code, active, sort FROM categories ORDER BY sort, name')
    .all<{ id: number; name: string; kind: CategoryKind; position: string; default_tax_code: TaxCode; active: number; sort: number }>()
  return results.map(r => ({ id: r.id, name: r.name, kind: r.kind, position: r.position, defaultTaxCode: r.default_tax_code, active: r.active === 1, sort: r.sort }))
}

export async function loadAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare('SELECT id, name, reconcile, opening_balance, active, sort FROM accounts ORDER BY sort, name')
    .all<{ id: number; name: string; reconcile: number; opening_balance: number; active: number; sort: number }>()
  return results.map(r => ({ id: r.id, name: r.name, reconcile: r.reconcile === 1, openingBalance: r.opening_balance, active: r.active === 1, sort: r.sort }))
}

export async function loadSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  return Object.fromEntries(results.map(r => [r.key, r.value]))
}

export async function yearLimits(db: D1Database, year: number): Promise<{ prevLimit: number; limit: number; gwgLimit: number }> {
  const row = await db.prepare('SELECT small_business_prev_limit, small_business_limit, gwg_limit FROM year_config WHERE year <= ? ORDER BY year DESC LIMIT 1').bind(year)
    .first<{ small_business_prev_limit: number; small_business_limit: number; gwg_limit: number }>()
  return { prevLimit: row?.small_business_prev_limit ?? 2500000, limit: row?.small_business_limit ?? 10000000, gwgLimit: row?.gwg_limit ?? 80000 }
}
