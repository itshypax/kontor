import { regimeAt } from './regime'
import { TAX_CODES } from './tax'
import type { LineFact, Mode, Regime } from './types'

export type Position = { key: string; label: string; side: 'income' | 'expense'; sub?: boolean }

/** In the order of the Anlage EÜR. Line numbers come from euer_lines per year. */
export const POSITIONS: Position[] = [
  { key: 'income_small_business', label: 'Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer', side: 'income' },
  { key: 'income_small_business_not_taxable', label: 'davon nicht steuerbare Umsätze', side: 'income', sub: true },
  { key: 'income_taxable', label: 'Umsatzsteuerpflichtige Betriebseinnahmen', side: 'income' },
  { key: 'income_tax_free', label: 'Umsatzsteuerfreie und nicht umsatzsteuerbare Betriebseinnahmen', side: 'income' },
  { key: 'vat_received', label: 'Vereinnahmte Umsatzsteuer', side: 'income' },
  { key: 'vat_refund', label: 'Vom Finanzamt erstattete Umsatzsteuer', side: 'income' },
  { key: 'afa', label: 'Absetzung für Abnutzung auf bewegliche Wirtschaftsgüter', side: 'expense' },
  { key: 'gwg', label: 'Aufwendungen für geringwertige Wirtschaftsgüter', side: 'expense' },
  { key: 'telecom', label: 'Aufwendungen für Telekommunikation', side: 'expense' },
  { key: 'travel', label: 'Übernachtungs- und Reisenebenkosten', side: 'expense' },
  { key: 'training', label: 'Fortbildungskosten', side: 'expense' },
  { key: 'advice', label: 'Kosten für Rechts- und Steuerberatung, Buchführung', side: 'expense' },
  { key: 'rent_movables', label: 'Miete und Leasing für bewegliche Wirtschaftsgüter', side: 'expense' },
  { key: 'fees', label: 'Beiträge, Gebühren, Abgaben und Versicherungen', side: 'expense' },
  { key: 'edv', label: 'Laufende EDV-Kosten', side: 'expense' },
  { key: 'tools', label: 'Arbeitsmittel und Werkzeuge', side: 'expense' },
  { key: 'advertising', label: 'Werbekosten', side: 'expense' },
  { key: 'other', label: 'Übrige unbeschränkt abziehbare Betriebsausgaben', side: 'expense' },
  { key: 'input_tax_paid', label: 'Gezahlte Vorsteuerbeträge', side: 'expense' },
  { key: 'vat_paid', label: 'An das Finanzamt gezahlte Umsatzsteuer', side: 'expense' }
]

/** Positions a category of kind "expense" may point to. */
export const EXPENSE_POSITIONS = POSITIONS.filter(p => p.side === 'expense' && !['afa', 'input_tax_paid', 'vat_paid'].includes(p.key))

export function positionLabel(key: string): string {
  return POSITIONS.find(p => p.key === key)?.label ?? key
}

/**
 * What one line adds to which position. Amounts keep their sign, so a
 * reversal cancels its original. Reverse charge leaves no trace in the EÜR
 * beyond the payment itself: the tax is owed and, for a Kleinunternehmer,
 * only shows up when it is paid to the tax office.
 */
export function contributions(line: Pick<LineFact, 'kind' | 'position' | 'taxCode' | 'net' | 'tax' | 'gross'>, mode: Mode): Array<[string, number]> {
  const info = TAX_CODES[line.taxCode]
  switch (line.kind) {
    case 'private_in':
    case 'private_out':
      return []
    case 'asset':
      // The cost goes in through depreciation, the input tax right away.
      return mode === 'standard' && info.included ? [['input_tax_paid', line.tax]] : []
    case 'tax_payment':
      return [['vat_paid', line.gross]]
    case 'tax_refund':
      return [['vat_refund', line.gross]]
    case 'income':
      if (mode === 'small_business') {
        const out: Array<[string, number]> = [['income_small_business', line.gross]]
        if (line.taxCode === 'ABROAD') out.push(['income_small_business_not_taxable', line.gross])
        return out
      }
      if (info.included) return [['income_taxable', line.net], ['vat_received', line.tax]]
      return [['income_tax_free', line.gross]]
    case 'expense':
      if (mode === 'standard' && info.included) return [[line.position, line.net], ['input_tax_paid', line.tax]]
      return [[line.position, line.gross]]
  }
}

export type EuerResult = {
  year: number
  totals: Map<string, number>
  income: number
  expense: number
  profit: number
  drafts: number
}

export function computeEuer(year: number, lines: LineFact[], regimes: Regime[], afa: number): EuerResult {
  const totals = new Map<string, number>()
  const drafts = new Set<number>()
  for (const line of lines) {
    if (line.fiscalYear !== year || line.status === 'discarded') continue
    if (line.status === 'draft') drafts.add(line.entryId)
    for (const [key, amount] of contributions(line, regimeAt(regimes, line.paidOn).mode)) totals.set(key, (totals.get(key) ?? 0) + amount)
  }
  if (afa) totals.set('afa', (totals.get('afa') ?? 0) + afa)
  let income = 0
  let expense = 0
  for (const position of POSITIONS) {
    if (position.sub) continue
    const value = totals.get(position.key) ?? 0
    if (position.side === 'income') income += value
    else expense += value
  }
  // Category positions outside the list would otherwise vanish from the sums.
  for (const [key, value] of totals) if (!POSITIONS.some(p => p.key === key)) expense += value
  return { year, totals, income, expense, profit: income - expense, drafts: drafts.size }
}
