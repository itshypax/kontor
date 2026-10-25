import { wholeEuros } from './money'
import { regimeAt } from './regime'
import { TAX_CODES } from './tax'
import type { LineFact, Regime, TaxCode } from './types'

export type FieldMap = Map<string, { base: string; tax: string; inputTax: string }>

export async function loadFieldMap(db: D1Database, year: number): Promise<FieldMap> {
  const { results } = await db.prepare('SELECT direction, tax_code, base_field, tax_field, input_tax_field FROM ustva_fields WHERE year = ?').bind(year)
    .all<{ direction: string; tax_code: string; base_field: string; tax_field: string; input_tax_field: string }>()
  return new Map(results.map(r => [`${r.direction}:${r.tax_code}`, { base: r.base_field, tax: r.tax_field, inputTax: r.input_tax_field }]))
}

export const FIELD_LABELS: Record<string, string> = {
  '81': 'Steuerpflichtige Umsätze zu 19 %, Bemessungsgrundlage',
  '86': 'Steuerpflichtige Umsätze zu 7 %, Bemessungsgrundlage',
  '45': 'Nicht steuerbare Umsätze, Leistungsort im Ausland',
  '46': 'Sonstige Leistungen nach § 13b Abs. 1 aus dem EU-Ausland, Bemessungsgrundlage',
  '47': 'Steuer darauf',
  '52': 'Leistungen nach § 13b Abs. 2 Nr. 1, Bemessungsgrundlage',
  '53': 'Steuer darauf',
  '66': 'Vorsteuer aus Rechnungen anderer Unternehmer',
  '67': 'Vorsteuer aus Leistungen nach § 13b',
  '83': 'Verbleibende Vorauszahlung oder Überschuss'
}

/** Fields the form takes in whole euros. All others take cents. */
const WHOLE_EURO = new Set(['81', '86', '45', '46', '52'])
/** Tax the form calculates itself from a base in whole euros. */
const COMPUTED_RATE: Record<string, number> = { '81': 19, '86': 7 }

export type VatReturn = {
  /** Field to amount in cents. Whole-euro fields are already cut to full euros. */
  fields: Array<{ field: string; label: string; cents: number; wholeEuro: boolean }>
  due: number
  required: boolean
  drafts: number
  lines: number
}

/**
 * The Voranmeldung of one period. With Ist-Versteuerung both sides go by
 * payment date. A Kleinunternehmer only reports reverse charge, and only
 * when there was some.
 */
export function computeVatReturn(lines: LineFact[], regimes: Regime[], fields: FieldMap, from: string, to: string): VatReturn {
  const sums = new Map<string, number>()
  const add = (field: string, cents: number) => { if (field) sums.set(field, (sums.get(field) ?? 0) + cents) }
  let required = false
  let due = 0
  const drafts = new Set<number>()
  let count = 0
  for (const line of lines) {
    if (line.status === 'discarded') continue
    const regime = regimeAt(regimes, line.paidOn)
    const date = regime.cashBasis || line.kind !== 'income' ? line.paidOn : (line.invoiceDate ?? line.paidOn)
    if (date < from || date > to) continue
    const direction = line.kind === 'income' ? 'income' : line.kind === 'expense' || line.kind === 'asset' ? 'expense' : null
    if (!direction) continue
    const info = TAX_CODES[line.taxCode as TaxCode]
    const map = fields.get(`${direction}:${line.taxCode}`)
    if (regime.mode === 'small_business') {
      if (!(direction === 'expense' && info.reverseCharge) || !map) continue
      required = true
      add(map.base, line.net)
      add(map.tax, line.tax)
      due += line.tax
    } else {
      required = true
      if (!map) continue
      if (direction === 'income') {
        add(map.base, line.net)
        add(map.tax, line.tax)
        if (!COMPUTED_RATE[map.base]) due += line.tax
      } else {
        add(map.base, line.net)
        add(map.tax, line.tax)
        add(map.inputTax, line.tax)
        if (info.reverseCharge) due += line.tax
        due -= line.tax
      }
    }
    count++
    if (line.status === 'draft') drafts.add(line.entryId)
  }
  const out: VatReturn['fields'] = []
  for (const field of [...sums.keys()].sort((a, b) => Number(a) - Number(b))) {
    const raw = sums.get(field)!
    const wholeEuro = WHOLE_EURO.has(field)
    const cents = wholeEuro ? wholeEuros(raw) * 100 : raw
    out.push({ field, label: FIELD_LABELS[field] ?? 'Kennzahl ' + field, cents, wholeEuro })
    if (COMPUTED_RATE[field]) due += Math.round(cents * COMPUTED_RATE[field] / 100)
  }
  return { fields: out, due, required, drafts: drafts.size, lines: count }
}
