import { dayOfYear, daysInYear } from './time'
import type { LineFact } from './types'

export type GuardLimits = { prevLimit: number; limit: number }

export type GuardResult = {
  turnover: number
  prevTurnover: number
  projection: number
  limits: GuardLimits
  /** Share of the previous-year limit, 0 to 1 and beyond. */
  share: number
  level: 'ok' | 'watch' | 'over_prev' | 'over_limit'
  message: string
  /** The entry that pushed the year over the hard limit, if any. */
  crossing: { entryId: number; number: string | null; paidOn: string } | null
}

/**
 * Turnover against § 19 UStG. Whether income from Tebex, which is not
 * taxable in Germany, counts towards the limit is for a tax advisor to say,
 * so it is a setting. By default it counts, which errs on the safe side.
 */
export function guard(lines: LineFact[], year: number, today: string, limits: GuardLimits, countAbroad: boolean): GuardResult {
  const counted = (line: LineFact) => line.kind === 'income' && line.status !== 'discarded' && (countAbroad || line.taxCode !== 'ABROAD')
  const ordered = lines.filter(l => counted(l) && Number(l.paidOn.slice(0, 4)) === year).sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.entryId - b.entryId)
  let turnover = 0
  let crossing: GuardResult['crossing'] = null
  for (const line of ordered) {
    turnover += line.gross
    if (!crossing && turnover > limits.limit) crossing = { entryId: line.entryId, number: line.number, paidOn: line.paidOn }
  }
  const prevTurnover = lines.filter(l => counted(l) && Number(l.paidOn.slice(0, 4)) === year - 1).reduce((sum, l) => sum + l.gross, 0)
  const current = Number(today.slice(0, 4)) === year
  const projection = current ? Math.round(turnover / dayOfYear(today) * daysInYear(year)) : turnover
  const share = limits.prevLimit ? projection / limits.prevLimit : 0
  let level: GuardResult['level'] = 'ok'
  let message = 'Umsatz und Hochrechnung liegen deutlich unter der Grenze.'
  if (turnover > limits.limit) {
    level = 'over_limit'
    message = 'Die Grenze für das laufende Jahr ist überschritten. Ab der markierten Buchung gilt die Regelbesteuerung: Steuermodus ab diesem Datum umstellen.'
  } else if (prevTurnover > limits.prevLimit) {
    level = 'over_prev'
    message = 'Der Vorjahresumsatz liegt über der Grenze. In diesem Jahr gilt die Kleinunternehmerregelung nicht.'
  } else if (turnover > limits.prevLimit) {
    level = 'over_prev'
    message = 'Der Umsatz liegt über der Vorjahresgrenze. Ab dem 1. Januar gilt die Regelbesteuerung.'
  } else if (share >= 0.8 || turnover >= limits.limit * 0.8) {
    level = 'watch'
    message = 'Die Hochrechnung kommt an die Grenze heran. Im nächsten Jahr gilt dann womöglich die Regelbesteuerung.'
  }
  return { turnover, prevTurnover, projection, limits, share, level, message, crossing }
}
