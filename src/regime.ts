import type { Regime } from './types'

const FALLBACK: Regime = { validFrom: '0000-01-01', mode: 'small_business', filingPeriod: 'none', cashBasis: true }

/** The regime in force on a date. Regimes must be sorted by validFrom. */
export function regimeAt(regimes: Regime[], date: string): Regime {
  let current = regimes[0] ?? FALLBACK
  for (const regime of regimes) if (regime.validFrom <= date) current = regime
  return current
}

export async function loadRegimes(db: D1Database): Promise<Regime[]> {
  const { results } = await db.prepare('SELECT valid_from, mode, filing_period, cash_basis FROM tax_regimes ORDER BY valid_from')
    .all<{ valid_from: string; mode: Regime['mode']; filing_period: Regime['filingPeriod']; cash_basis: number }>()
  return results.map(r => ({ validFrom: r.valid_from, mode: r.mode, filingPeriod: r.filing_period, cashBasis: r.cash_basis === 1 }))
}

export function modeLabel(regime: Regime): string {
  return regime.mode === 'small_business' ? 'Kleinunternehmer nach § 19 UStG' : regime.cashBasis ? 'Regelbesteuerung mit Ist-Versteuerung' : 'Regelbesteuerung mit Soll-Versteuerung'
}
