import { loadYearFacts } from './facts'
import { loadRegimes, regimeAt } from './regime'
import { periodLabel, periodOf, periodRange, vatDeadline } from './time'
import type { LineFact, Regime } from './types'
import { computeVatReturn, loadFieldMap, type VatReturn } from './ustva'

export type Filing = { period: string; filedAt: string; filedBy: string; documentId: number | null; snapshot: string }
export type VatPeriod = { period: string; label: string; deadline: string; result: VatReturn; filing: Filing | null; changed: boolean }

export function snapshotOf(result: VatReturn): string {
  return JSON.stringify({ fields: result.fields.map(f => [f.field, f.cents]), due: result.due })
}

/**
 * Every period of a year that needs a Voranmeldung or already has one. Under
 * standard taxation that is every period, for a Kleinunternehmer only the
 * months with reverse charge.
 */
export function vatPeriods(year: number, lastMonth: number, facts: LineFact[], regimes: Regime[], fields: Awaited<ReturnType<typeof loadFieldMap>>, filings: Filing[]): VatPeriod[] {
  const periods: string[] = []
  for (let m = 1; m <= lastMonth; m++) {
    const start = `${year}-${String(m).padStart(2, '0')}-01`
    const regime = regimeAt(regimes, start)
    const period = regime.mode === 'standard' ? periodOf(start, regime.filingPeriod === 'month' ? 'month' : 'quarter') : start.slice(0, 7)
    if (!periods.includes(period)) periods.push(period)
  }
  for (const filing of filings) if (filing.period.startsWith(String(year)) && !periods.includes(filing.period)) periods.push(filing.period)
  const out: VatPeriod[] = []
  for (const period of periods.sort()) {
    const range = periodRange(period)!
    const result = computeVatReturn(facts, regimes, fields, range.from, range.to)
    // Corrections are stored next to the first filing; the latest one counts.
    const filing = filings.filter(f => f.period === period).at(-1) ?? null
    if (!result.required && !filing) continue
    out.push({ period, label: periodLabel(period), deadline: vatDeadline(period), result, filing, changed: !!filing && filing.snapshot !== snapshotOf(result) })
  }
  return out
}

export async function loadFilings(db: D1Database): Promise<Filing[]> {
  const { results } = await db.prepare('SELECT period, filed_at, filed_by, document_id, snapshot FROM vat_filings ORDER BY period')
    .all<{ period: string; filed_at: string; filed_by: string; document_id: number | null; snapshot: string }>()
  return results.map(r => ({ period: r.period.split('#')[0]!, filedAt: r.filed_at, filedBy: r.filed_by, documentId: r.document_id, snapshot: r.snapshot }))
}

export async function vatForYear(db: D1Database, year: number, today: string): Promise<VatPeriod[]> {
  const lastMonth = Number(today.slice(0, 4)) > year ? 12 : Number(today.slice(0, 4)) < year ? 0 : Number(today.slice(5, 7))
  const [facts, regimes, fields, filings] = await Promise.all([loadYearFacts(db, year), loadRegimes(db), loadFieldMap(db, year), loadFilings(db)])
  return vatPeriods(year, lastMonth, facts, regimes, fields, filings)
}

