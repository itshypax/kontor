const MINUS = '−'

/**
 * Reads an amount the way it is typed in Germany ("1.234,56", "12,5", "-4,31")
 * and returns cents. A lone dot is read as decimal point only when it is
 * followed by one or two digits, so "1.234" stays one thousand two hundred.
 */
export function parseAmount(input: string): number | null {
  let value = input.trim().replace(/\s|€/g, '').replace(MINUS, '-')
  if (!value) return null
  const negative = value.startsWith('-')
  if (negative || value.startsWith('+')) value = value.slice(1)
  if (value.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*,\d{0,2}$|^\d+,\d{0,2}$/.test(value)) return null
    value = value.replace(/\./g, '').replace(',', '.')
  } else if (/^\d+\.\d{1,2}$/.test(value)) {
    // decimal point as typed on an English keyboard
  } else if (/^\d{1,3}(\.\d{3})+$|^\d+$/.test(value)) {
    value = value.replace(/\./g, '')
  } else return null
  const [euros = '0', cents = ''] = value.split('.')
  const result = Number(euros) * 100 + Number((cents + '00').slice(0, 2))
  if (!Number.isSafeInteger(result)) return null
  return negative ? -result : result
}

/** "1.234,56 €", negative with a real minus sign. */
export function formatCents(cents: number, opts: { sign?: boolean; currency?: boolean } = {}): string {
  const abs = Math.abs(cents)
  const text = (abs / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const prefix = cents < 0 ? MINUS : opts.sign && cents > 0 ? '+' : ''
  return prefix + text + (opts.currency === false ? '' : ' €')
}

/** "1234,56" without thousands separator, for form fields and CSV. */
export function plainCents(cents: number): string {
  const abs = Math.abs(cents)
  return (cents < 0 ? '-' : '') + Math.floor(abs / 100) + ',' + String(abs % 100).padStart(2, '0')
}

/** Rounds half away from zero, like a calculator, for negative amounts too. */
export function roundHalf(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}

/** Whole euros toward zero, as the Voranmeldung wants its tax bases. */
export function wholeEuros(cents: number): number {
  return Math.trunc(cents / 100)
}
