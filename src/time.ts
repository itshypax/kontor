/** Today's date in Berlin as YYYY-MM-DD. */
export function todayBerlin(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function isoSeconds(now = new Date()): string {
  return now.toISOString().slice(0, 19) + 'Z'
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/** "22.10.2026" */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

/** "22.10.2026, 09:14" in Berlin time. */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

export function monthName(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

function lastDay(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

/** A Voranmeldung period: "2026-10" for a month, "2026-Q4" for a quarter. */
export function periodRange(period: string): { from: string; to: string } | null {
  const month = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/)
  if (month) return { from: `${period}-01`, to: lastDay(Number(month[1]), Number(month[2])) }
  const quarter = period.match(/^(\d{4})-Q([1-4])$/)
  if (quarter) {
    const first = (Number(quarter[2]) - 1) * 3 + 1
    return { from: `${quarter[1]}-${String(first).padStart(2, '0')}-01`, to: lastDay(Number(quarter[1]), first + 2) }
  }
  return null
}

export function periodOf(date: string, filing: 'month' | 'quarter'): string {
  if (filing === 'month') return date.slice(0, 7)
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`
}

export function periodLabel(period: string): string {
  const quarter = period.match(/^(\d{4})-Q([1-4])$/)
  if (quarter) return `${quarter[2]}. Quartal ${quarter[1]}`
  return monthName(period)
}

/** Day of the year, 1 to 366. */
export function dayOfYear(date: string): number {
  const d = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  return Math.floor((d - Date.UTC(Number(date.slice(0, 4)), 0, 1)) / 86400000) + 1
}

export function daysInYear(year: number): number {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000
}

/** The 10th of the following month, the usual deadline of a Voranmeldung. */
export function vatDeadline(period: string): string {
  const range = periodRange(period)!
  const end = new Date(range.to + 'T00:00:00Z')
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 10)).toISOString().slice(0, 10)
}
