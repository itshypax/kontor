import { esc } from '../http'
import { formatCents } from '../money'
import { MONTHS_SHORT } from '../time'
import { icon } from './layout'

export function amount(cents: number, opts: { strike?: boolean } = {}): string {
  const cls = ['amount', cents > 0 ? 'in' : '', opts.strike ? 'strike' : ''].filter(Boolean).join(' ')
  return `<span class="${cls}">${formatCents(cents, { sign: true })}</span>`
}

export type StatusInfo = { status: 'draft' | 'posted' | 'discarded'; reversesId: number | null; reversedById: number | null }

export function statusBadge(e: StatusInfo): string {
  if (e.status === 'draft') return '<span class="badge draft">Entwurf</span>'
  if (e.status === 'discarded') return '<span class="badge reversed">Verworfen</span>'
  if (e.reversesId) return '<span class="badge storno">Storno</span>'
  if (e.reversedById) return '<span class="badge reversed">Storniert</span>'
  return `<span class="badge">${icon('lock')}Festgeschrieben</span>`
}

/** 25 fields, each a 25th of the limit, filled up to the turnover and shaded up to the projection. */
export function segments(turnover: number, projection: number, limit: number, label: string): string {
  const step = limit / 25
  const cells: string[] = []
  for (let i = 0; i < 25; i++) {
    const start = i * step
    const filled = Math.max(0, Math.min(1, (turnover - start) / step))
    if (filled >= 1) cells.push('<span class="full"></span>')
    else if (filled > 0) cells.push(`<span style="background:linear-gradient(90deg,var(--on-orange) ${Math.round(filled * 100)}%,rgba(17,17,19,.32) ${Math.round(filled * 100)}%)"></span>`)
    else if (projection > start) cells.push('<span class="projected"></span>')
    else cells.push('<span></span>')
  }
  return `<div class="segments" role="img" aria-label="${esc(label)}">${cells.join('')}</div>`
}

/** Monthly bars, income next to expense, on one shared scale with a rounded top. */
export function monthChart(income: number[], expense: number[], year: number): string {
  const max = Math.max(...income, ...expense, 1)
  const magnitude = 10 ** Math.floor(Math.log10(max / 100))
  const top = Math.ceil(max / 100 / magnitude / 5) * 5 * magnitude * 100 || 100
  const names = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
  const bars = MONTHS_SHORT.map((_, i) => {
    const tip = `${names[i]} ${year}: Einnahmen ${formatCents(income[i] ?? 0)}, Ausgaben ${formatCents(expense[i] ?? 0)}`
    const h = (v: number) => `${Math.max(0, (v / top) * 100).toFixed(1)}%`
    return `<div class="month" title="${esc(tip)}"><div class="bar in" style="height:${h(income[i] ?? 0)}"></div><div class="bar out" style="height:${h(expense[i] ?? 0)}"></div></div>`
  }).join('')
  const rows = MONTHS_SHORT.map((m, i) => `<tr><td>${m}</td><td class="r num">${formatCents(income[i] ?? 0)}</td><td class="r num">${formatCents(expense[i] ?? 0)}</td></tr>`).join('')
  return `<div class="chart" role="img" aria-label="Einnahmen und Ausgaben je Monat ${year}, Skala bis ${esc(formatCents(top))}">
  <div class="gridline" style="top:0"></div><div class="gridline" style="top:33.3%"></div><div class="gridline" style="top:66.6%"></div>${bars}</div>
<div class="chart-labels" aria-hidden="true">${MONTHS_SHORT.map(m => `<span>${m}</span>`).join('')}</div>
<details style="margin-top:12px"><summary class="muted" style="cursor:pointer;font-size:13px">Als Tabelle</summary>
<table class="list" style="margin-top:8px"><thead><tr><th>Monat</th><th class="r">Einnahmen</th><th class="r">Ausgaben</th></tr></thead><tbody>${rows}</tbody></table></details>`
}

export function legend(): string {
  return '<div class="legend"><span><i style="background:var(--income)"></i>Einnahmen</span><span><i style="background:var(--expense)"></i>Ausgaben</span></div>'
}

export function yearSwitch(path: string, year: number, years: number[], extra = ''): string {
  const options = years.map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`).join('')
  return `<form method="get" action="${path}" class="actions" data-autosubmit>${extra}<label class="sr" for="jahr">Jahr</label><select id="jahr" name="jahr">${options}</select><noscript><button class="btn btn-sm">Zeigen</button></noscript></form>`
}
