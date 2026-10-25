import { roundHalf } from './money'
import type { CategoryKind, Mode, TaxCode } from './types'

export type TaxCodeInfo = { label: string; short: string; rate: number; included: boolean; reverseCharge: boolean }

export const TAX_CODES: Record<TaxCode, TaxCodeInfo> = {
  DE19: { label: '19 % deutsche Umsatzsteuer', short: '19 %', rate: 19, included: true, reverseCharge: false },
  DE7: { label: '7 % deutsche Umsatzsteuer', short: '7 %', rate: 7, included: true, reverseCharge: false },
  RC_EU: { label: 'Reverse Charge, Anbieter im EU-Ausland', short: 'Reverse Charge EU', rate: 19, included: false, reverseCharge: true },
  RC_OTHER: { label: 'Reverse Charge, Anbieter außerhalb der EU', short: 'Reverse Charge Drittland', rate: 19, included: false, reverseCharge: true },
  FOREIGN_VAT: { label: 'Ausländische Umsatzsteuer auf der Rechnung', short: 'Ausländische USt', rate: 0, included: false, reverseCharge: false },
  ABROAD: { label: 'Nicht steuerbar, Leistungsort im Ausland', short: 'Nicht steuerbar', rate: 0, included: false, reverseCharge: false },
  EXEMPT: { label: 'Steuerfrei', short: 'Steuerfrei', rate: 0, included: false, reverseCharge: false },
  NONE: { label: 'Keine Umsatzsteuer', short: 'Keine USt', rate: 0, included: false, reverseCharge: false }
}

export function isTaxCode(value: string): value is TaxCode {
  return Object.hasOwn(TAX_CODES, value)
}

/**
 * Splits what was actually paid into net and tax. For reverse charge the
 * invoice carries no tax: the paid amount is the net, and the tax is owed on
 * top of it to the tax office.
 */
export function splitGross(gross: number, code: TaxCode): { net: number; tax: number; gross: number } {
  const info = TAX_CODES[code]
  if (info.included) {
    const net = roundHalf(gross * 100 / (100 + info.rate))
    return { net, tax: gross - net, gross }
  }
  if (info.reverseCharge) return { net: gross, tax: roundHalf(gross * info.rate / 100), gross }
  return { net: gross, tax: 0, gross }
}

/** Whether a line needs a Voranmeldung even for a Kleinunternehmer. */
export function forcesVatReturn(kind: CategoryKind, code: TaxCode): boolean {
  return kind === 'expense' || kind === 'asset' ? TAX_CODES[code].reverseCharge : false
}

/** A short hint for the entry form on what a line does to EÜR and Voranmeldung. */
export function lineEffect(kind: CategoryKind, code: TaxCode, mode: Mode, amounts: { net: number; tax: number; gross: number }, fmt: (cents: number) => string): { title: string; text: string; warn: boolean } {
  const info = TAX_CODES[code]
  const { net, tax, gross } = amounts
  if (kind === 'private') return { title: 'Privat, nicht in der EÜR', text: 'Einlagen und Entnahmen ändern den Gewinn nicht.', warn: false }
  if (kind === 'tax_payment') return { title: 'In der EÜR: Ausgabe ' + fmt(gross), text: 'Zahlungen an das Finanzamt stehen in einer eigenen Zeile der Anlage EÜR.', warn: false }
  if (kind === 'tax_refund') return { title: 'In der EÜR: Einnahme ' + fmt(gross), text: 'Erstattungen des Finanzamts stehen in einer eigenen Zeile der Anlage EÜR.', warn: false }
  if (kind === 'asset') return { title: 'Anlagegut, nicht direkt in der EÜR', text: 'Die Ausgabe wirkt über die Abschreibung im Anlagenverzeichnis.', warn: false }
  if (kind === 'income') {
    if (code === 'ABROAD') return { title: 'In der EÜR: Einnahme ' + fmt(gross), text: 'In Deutschland nicht steuerbar, weil die Leistung im Ausland erbracht wird.', warn: false }
    if (mode === 'small_business' && info.included) return { title: 'Kleinunternehmer weisen keine Umsatzsteuer aus', text: 'Steht trotzdem Umsatzsteuer auf der Rechnung, wird sie geschuldet. Den Steuerschlüssel prüfen.', warn: true }
    if (mode === 'small_business') return { title: 'In der EÜR: Einnahme ' + fmt(gross), text: 'Als Kleinunternehmer ohne Umsatzsteuer.', warn: false }
    if (info.included) return { title: 'In der EÜR: Einnahme ' + fmt(net) + ' und Umsatzsteuer ' + fmt(tax), text: 'Die Umsatzsteuer geht in die Voranmeldung.', warn: false }
    return { title: 'In der EÜR: Einnahme ' + fmt(gross), text: 'Ohne Umsatzsteuer.', warn: false }
  }
  if (mode === 'small_business') {
    if (info.reverseCharge) return { title: 'Du schuldest ' + fmt(tax) + ' Umsatzsteuer', text: 'Reverse Charge gilt auch für Kleinunternehmer, ohne Vorsteuerabzug. Für den Zeitraum wird eine Voranmeldung fällig. In der EÜR: Ausgabe ' + fmt(gross) + ', die Zahlung ans Finanzamt später ebenfalls.', warn: true }
    if (info.included) return { title: 'In der EÜR: Ausgabe ' + fmt(gross), text: 'Die Vorsteuer von ' + fmt(tax) + ' ist als Kleinunternehmer nicht abziehbar und zählt zur Ausgabe.', warn: false }
    return { title: 'In der EÜR: Ausgabe ' + fmt(gross), text: 'Keine deutsche Umsatzsteuer.', warn: false }
  }
  if (info.reverseCharge) return { title: 'In der EÜR: Ausgabe ' + fmt(gross), text: 'In der Voranmeldung stehen ' + fmt(tax) + ' Steuer nach § 13b und ebenso viel Vorsteuer. Beides gleicht sich aus.', warn: false }
  if (info.included) return { title: 'In der EÜR: Ausgabe ' + fmt(net) + ' und Vorsteuer ' + fmt(tax), text: 'Die Vorsteuer geht in die Voranmeldung.', warn: false }
  if (code === 'FOREIGN_VAT') return { title: 'In der EÜR: Ausgabe ' + fmt(gross), text: 'Ausländische Umsatzsteuer ist keine deutsche Vorsteuer.', warn: false }
  return { title: 'In der EÜR: Ausgabe ' + fmt(gross), text: 'Keine Umsatzsteuer.', warn: false }
}
