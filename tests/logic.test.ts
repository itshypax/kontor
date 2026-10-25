import { describe, expect, test } from 'bun:test'
import { depreciation } from '../src/afa'
import { computeEuer, contributions } from '../src/euer'
import { guard } from '../src/guard'
import { formatCents, parseAmount, plainCents } from '../src/money'
import { regimeAt } from '../src/regime'
import { splitGross } from '../src/tax'
import { periodOf, periodRange, vatDeadline } from '../src/time'
import type { FieldMap } from '../src/ustva'
import { computeVatReturn } from '../src/ustva'
import type { LineFact, Regime } from '../src/types'

const SMALL: Regime = { validFrom: '2026-01-01', mode: 'small_business', filingPeriod: 'none', cashBasis: true }
const STANDARD: Regime = { validFrom: '2026-01-01', mode: 'standard', filingPeriod: 'month', cashBasis: true }

let id = 0
function line(over: Partial<LineFact>): LineFact {
  id++
  return {
    entryId: id, number: `2026-${String(id).padStart(4, '0')}`, status: 'posted', paidOn: '2026-10-10', invoiceDate: null, fiscalYear: 2026,
    text: 'x', counterparty: '', categoryId: 1, categoryName: 'x', kind: 'expense', position: 'edv', taxCode: 'DE19',
    net: 0, tax: 0, gross: 0, ...over
  }
}
function paid(gross: number, over: Partial<LineFact>): LineFact {
  const split = splitGross(gross, over.taxCode ?? 'DE19')
  return line({ ...split, ...over })
}

const FIELDS: FieldMap = new Map([
  ['income:DE19', { base: '81', tax: '', inputTax: '' }],
  ['income:ABROAD', { base: '45', tax: '', inputTax: '' }],
  ['expense:DE19', { base: '', tax: '', inputTax: '66' }],
  ['expense:RC_EU', { base: '46', tax: '47', inputTax: '67' }],
  ['expense:RC_OTHER', { base: '52', tax: '53', inputTax: '67' }]
])

describe('money', () => {
  test('reads German amounts', () => {
    expect(parseAmount('1.234,56')).toBe(123456)
    expect(parseAmount('4,31')).toBe(431)
    expect(parseAmount('12,5')).toBe(1250)
    expect(parseAmount('-29,99 €')).toBe(-2999)
    expect(parseAmount('−29,99')).toBe(-2999)
    expect(parseAmount('1.234')).toBe(123400)
    expect(parseAmount('4.31')).toBe(431)
    expect(parseAmount('25')).toBe(2500)
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('1,234,5')).toBeNull()
    expect(parseAmount('')).toBeNull()
  })

  test('formats cents', () => {
    expect(formatCents(859875)).toBe('8.598,75 €')
    expect(formatCents(-431)).toBe('−4,31 €')
    expect(formatCents(28640, { sign: true })).toBe('+286,40 €')
    expect(plainCents(-2999)).toBe('-29,99')
    expect(plainCents(5)).toBe('0,05')
  })
})

describe('tax', () => {
  test('splits gross by tax code', () => {
    expect(splitGross(2499, 'DE19')).toEqual({ net: 2100, tax: 399, gross: 2499 })
    expect(splitGross(1490, 'DE19')).toEqual({ net: 1252, tax: 238, gross: 1490 })
    expect(splitGross(1070, 'DE7')).toEqual({ net: 1000, tax: 70, gross: 1070 })
    expect(splitGross(431, 'RC_OTHER')).toEqual({ net: 431, tax: 82, gross: 431 })
    expect(splitGross(28640, 'ABROAD')).toEqual({ net: 28640, tax: 0, gross: 28640 })
  })

  test('a reversal splits to the exact negative of its original', () => {
    for (const gross of [2499, 1490, 37, 431]) {
      const a = splitGross(gross, 'DE19')
      const b = splitGross(-gross, 'DE19')
      expect(b).toEqual({ net: -a.net, tax: -a.tax, gross: -a.gross })
    }
  })
})

describe('EÜR', () => {
  test('a Kleinunternehmer books gross amounts and lists non-taxable income', () => {
    expect(contributions(paid(28640, { kind: 'income', taxCode: 'ABROAD' }), 'small_business')).toEqual([['income_small_business', 28640], ['income_small_business_not_taxable', 28640]])
    expect(contributions(paid(2499, { position: 'edv' }), 'small_business')).toEqual([['edv', 2499]])
    expect(contributions(paid(431, { taxCode: 'RC_OTHER' }), 'small_business')).toEqual([['edv', 431]])
  })

  test('standard taxation splits off input tax and output tax', () => {
    expect(contributions(paid(2499, { position: 'edv' }), 'standard')).toEqual([['edv', 2100], ['input_tax_paid', 399]])
    expect(contributions(paid(11900, { kind: 'income', taxCode: 'DE19' }), 'standard')).toEqual([['income_taxable', 10000], ['vat_received', 1900]])
    expect(contributions(paid(431, { taxCode: 'RC_EU' }), 'standard')).toEqual([['edv', 431]])
    expect(contributions(paid(119000, { kind: 'asset', position: 'asset' }), 'standard')).toEqual([['input_tax_paid', 19000]])
    expect(contributions(paid(5000, { kind: 'private', position: 'private', taxCode: 'NONE' }), 'standard')).toEqual([])
  })

  test('sums a year, ignores discarded drafts and cancels reversals', () => {
    const lines = [
      paid(28640, { kind: 'income', taxCode: 'ABROAD' }),
      paid(2499, { position: 'edv' }),
      paid(2999, { position: 'edv' }),
      paid(-2999, { position: 'edv' }),
      paid(1000, { position: 'edv', status: 'discarded' }),
      paid(3720, { position: 'edv', status: 'draft', number: null }),
      paid(1285, { kind: 'tax_payment', position: 'vat_paid', taxCode: 'NONE' }),
      paid(9999, { position: 'edv', fiscalYear: 2025, paidOn: '2025-12-30' })
    ]
    const result = computeEuer(2026, lines, [SMALL], 41200)
    expect(result.totals.get('edv')).toBe(2499 + 3720)
    expect(result.income).toBe(28640)
    expect(result.expense).toBe(2499 + 3720 + 1285 + 41200)
    expect(result.profit).toBe(28640 - 2499 - 3720 - 1285 - 41200)
    expect(result.drafts).toBe(1)
  })

  test('uses the regime in force on the payment date', () => {
    const switched: Regime = { ...STANDARD, validFrom: '2026-07-01' }
    const lines = [paid(11900, { kind: 'income', taxCode: 'DE19', paidOn: '2026-06-30' }), paid(11900, { kind: 'income', taxCode: 'DE19', paidOn: '2026-07-01' })]
    const result = computeEuer(2026, lines, [SMALL, switched], 0)
    expect(result.totals.get('income_small_business')).toBe(11900)
    expect(result.totals.get('income_taxable')).toBe(10000)
    expect(result.totals.get('vat_received')).toBe(1900)
    expect(regimeAt([SMALL, switched], '2026-06-30').mode).toBe('small_business')
  })
})

describe('Voranmeldung', () => {
  test('a Kleinunternehmer only reports reverse charge', () => {
    const lines = [paid(431, { taxCode: 'RC_OTHER' }), paid(2499, {}), paid(28640, { kind: 'income', taxCode: 'ABROAD' })]
    const result = computeVatReturn(lines, [SMALL], FIELDS, '2026-10-01', '2026-10-31')
    expect(result.required).toBe(true)
    expect(result.fields.map(f => [f.field, f.cents])).toEqual([['52', 400], ['53', 82]])
    expect(result.due).toBe(82)
    expect(computeVatReturn([paid(2499, {})], [SMALL], FIELDS, '2026-10-01', '2026-10-31').required).toBe(false)
  })

  test('standard taxation nets output tax, reverse charge and input tax', () => {
    const lines = [
      paid(111860, { kind: 'income', taxCode: 'ABROAD' }),
      paid(11900, { kind: 'income', taxCode: 'DE19' }),
      paid(431, { taxCode: 'RC_OTHER' }),
      paid(1490, {}),
      paid(2499, {}),
      paid(3720, { status: 'draft', number: null }),
      paid(5000, { paidOn: '2026-11-01' })
    ]
    const result = computeVatReturn(lines, [STANDARD], FIELDS, '2026-10-01', '2026-10-31')
    const byField = Object.fromEntries(result.fields.map(f => [f.field, f.cents]))
    expect(byField).toEqual({ '45': 111800, '52': 400, '53': 82, '66': 238 + 399 + 594, '67': 82, '81': 10000 })
    expect(result.due).toBe(1900 + 82 - 82 - (238 + 399 + 594))
    expect(result.drafts).toBe(1)
  })
})

describe('Kleinunternehmer guard', () => {
  const limits = { prevLimit: 2500000, limit: 10000000 }
  test('projects the year and flags the entry that crosses the hard limit', () => {
    const lines = [paid(859875, { kind: 'income', taxCode: 'ABROAD', paidOn: '2026-10-20' })]
    const result = guard(lines, 2026, '2026-10-25', limits, true)
    expect(result.turnover).toBe(859875)
    expect(result.projection).toBe(Math.round(859875 / 298 * 365))
    expect(result.level).toBe('ok')
    expect(guard(lines, 2026, '2026-10-25', limits, false).turnover).toBe(0)
    const big = [paid(6000000, { kind: 'income', taxCode: 'NONE', paidOn: '2026-03-01' }), paid(5000000, { kind: 'income', taxCode: 'NONE', paidOn: '2026-04-01' })]
    const over = guard(big, 2026, '2026-10-25', limits, true)
    expect(over.level).toBe('over_limit')
    expect(over.crossing?.paidOn).toBe('2026-04-01')
  })
})

describe('depreciation', () => {
  test('linear by month, digital in one year, GWG only listed', () => {
    const base = { id: 1, name: 'Server', cost: 360000, usefulLifeMonths: 36, disposedOn: null }
    expect(depreciation({ ...base, method: 'linear', acquiredOn: '2026-10-15' }, 2026)).toEqual({ afa: 30000, bookValueEnd: 330000 })
    expect(depreciation({ ...base, method: 'linear', acquiredOn: '2026-10-15' }, 2029)).toEqual({ afa: 90000, bookValueEnd: 0 })
    expect(depreciation({ ...base, method: 'linear', acquiredOn: '2026-10-15', disposedOn: '2027-06-01' }, 2027)).toEqual({ afa: 330000, bookValueEnd: 0 })
    expect(depreciation({ ...base, method: 'digital_one_year', acquiredOn: '2026-08-01' }, 2026).afa).toBe(360000)
    expect(depreciation({ ...base, method: 'digital_one_year', acquiredOn: '2026-08-01' }, 2027).afa).toBe(0)
    expect(depreciation({ ...base, method: 'gwg', acquiredOn: '2026-08-01' }, 2026).afa).toBe(0)
  })
})

describe('periods', () => {
  test('months and quarters', () => {
    expect(periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(periodRange('2026-Q4')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(periodOf('2026-11-03', 'quarter')).toBe('2026-Q4')
    expect(vatDeadline('2026-10')).toBe('2026-11-10')
    expect(vatDeadline('2026-Q4')).toBe('2027-01-10')
  })
})
