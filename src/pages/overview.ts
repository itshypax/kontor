import { loadAssets, totalAfa } from '../afa'
import { loadSettings, yearLimits } from '../catalog'
import type { Ctx } from '../context'
import { listDocuments } from '../documents'
import { listEntries } from '../entries'
import { computeEuer, contributions, POSITIONS } from '../euer'
import { loadYearFacts } from '../facts'
import { guard } from '../guard'
import { esc, html } from '../http'
import { formatCents } from '../money'
import { loadRegimes, modeLabel, regimeAt } from '../regime'
import { formatDate } from '../time'
import { vatForYear } from '../vat'
import { hint, icon, page } from '../views/layout'
import { legend, monthChart, segments, yearSwitch } from '../views/parts'

export async function overviewPage(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB
  const thisYear = Number(ctx.today.slice(0, 4))
  const year = Number(ctx.url.searchParams.get('jahr')) || thisYear
  const [facts, regimes, assets, settings, limits, unlinked, recent, drafts, vat] = await Promise.all([
    loadYearFacts(db, year), loadRegimes(db), loadAssets(db), loadSettings(db), yearLimits(db, year),
    listDocuments(db, { unlinked: true, limit: 50 }), listEntries(db, { limit: 6 }), listEntries(db, { status: 'draft' }), vatForYear(db, year, ctx.today)
  ])
  const euer = computeEuer(year, facts, regimes, totalAfa(assets, year))
  const regime = regimeAt(regimes, year === thisYear ? ctx.today : `${year}-12-31`)
  const income = Array(12).fill(0) as number[]
  const expense = Array(12).fill(0) as number[]
  for (const line of facts) {
    if (line.fiscalYear !== year) continue
    const m = Number(line.paidOn.slice(5, 7)) - 1
    for (const [key, value] of contributions(line, regimeAt(regimes, line.paidOn).mode)) {
      const position = POSITIONS.find(p => p.key === key)
      if (position?.sub) continue
      if (position?.side === 'income') income[m] = (income[m] ?? 0) + value
      else expense[m] = (expense[m] ?? 0) + value
    }
  }
  const tenDaysAgo = new Date(Date.parse(ctx.today) - 10 * 86400000).toISOString().slice(0, 10)
  const oldDrafts = drafts.filter(d => d.paidOn < tenDaysAgo).length
  const openVat = vat.filter(v => !v.filing || v.changed)
  const nextVat = openVat[0]

  let side: string
  if (regime.mode === 'small_business') {
    const g = guard(facts, year, ctx.today, limits, settings.guard_counts_abroad !== '0')
    const share = Math.round(g.turnover / limits.prevLimit * 100)
    side = `<section class="card orange stack" style="justify-content:space-between">
  <div><span class="label">Kleinunternehmergrenze</span><span class="num" style="display:block;margin-top:6px;font-size:64px;font-weight:500;letter-spacing:-.05em;line-height:1">${share} %</span></div>
  <div>${segments(g.turnover, g.projection, limits.prevLimit, `Umsatz ${formatCents(g.turnover)} von ${formatCents(limits.prevLimit)}, Hochrechnung ${formatCents(g.projection)}`)}
  <p style="margin:12px 0 0;font-size:14px;font-weight:600">${formatCents(g.turnover)} von ${formatCents(limits.prevLimit, { currency: false })} € · Hochrechnung ${formatCents(Math.round(g.projection / 1000) * 1000)}</p>
  ${g.level !== 'ok' ? `<p style="margin:8px 0 0;font-size:14px;font-weight:700">${esc(g.message)}${g.crossing ? ` <a href="/buchungen/${g.crossing.entryId}">Zur Buchung</a>` : ''}</p>` : ''}</div>
</section>`
  } else {
    side = `<section class="card orange stack" style="justify-content:space-between">
  <div><span class="label">${nextVat ? 'Voranmeldung ' + esc(nextVat.label) : 'Voranmeldung'}</span>
  <span class="num" style="display:block;margin-top:6px;font-size:56px;font-weight:500;letter-spacing:-.05em;line-height:1">${nextVat ? formatCents(nextVat.result.due) : 'erledigt'}</span>
  <span style="display:block;margin-top:6px;font-size:14px;font-weight:600">${nextVat ? (nextVat.result.due < 0 ? 'Erstattung vom Finanzamt' : 'an das Finanzamt zu zahlen') : 'Alle Zeiträume sind übermittelt.'}</span></div>
  ${nextVat ? `<div class="actions" style="justify-content:space-between"><strong>fällig am ${formatDate(nextVat.deadline)}</strong><a class="btn btn-dark" href="/auswertungen?jahr=${year}&zeitraum=${nextVat.period}#ustva">Ansehen</a></div>` : ''}
</section>`
  }

  const vatTile = nextVat
    ? `<a class="tile alert" href="/auswertungen?jahr=${year}&zeitraum=${nextVat.period}#ustva"><span class="big">${formatDate(nextVat.deadline).slice(0, 6)}</span><strong>${nextVat.changed ? 'Berichtigung ' : 'Voranmeldung '}${esc(nextVat.label)}</strong><small>${nextVat.changed ? 'Nach der Übermittlung hat sich etwas geändert' : 'Steuer ' + formatCents(nextVat.result.due)}</small></a>`
    : `<a class="tile" href="/auswertungen?jahr=${year}#ustva"><span class="big">0</span><strong>Voranmeldungen offen</strong><small>${regime.mode === 'small_business' ? 'nur bei Reverse Charge nötig' : 'alles übermittelt'}</small></a>`

  const recentList = recent.map(r => `<li>
  <span class="dot${r.total > 0 ? ' in' : ''}" aria-hidden="true">${icon(r.total > 0 ? 'in' : 'out')}</span>
  <span class="text"><a href="/buchungen/${r.id}">${esc(r.text)}</a><span>${formatDate(r.paidOn)}${r.counterparty ? ' · ' + esc(r.counterparty) : ''}</span></span>
  <span class="end"><span class="amount">${formatCents(r.total, { sign: true })}</span><small class="${r.status === 'draft' ? 'draft' : ''}">${r.status === 'draft' ? 'Entwurf' : r.reversesId ? 'Storno' : r.reversedById ? 'Storniert' : 'Festgeschrieben'}</small></span>
</li>`).join('')

  const years = [...new Set([thisYear - 1, thisYear, year])].sort()
  const body = `${hint(ctx.url)}
<div class="row">
  <section class="card pad-lg grow">
    <div class="card-head" style="margin-bottom:0"><span class="label">Gewinn ${year} · Stand ${formatDate(ctx.today)}</span>${yearSwitch('/', year, years)}</div>
    <span class="hero-number">${formatCents(euer.profit)}</span>
    <div class="figures">
      <div class="figure"><span>Einnahmen</span><strong>${formatCents(euer.income)}</strong></div>
      <div class="figure"><span>Ausgaben</span><strong>${formatCents(euer.expense)}</strong></div>
      <div class="figure"><span>Steuermodus</span><strong style="font-family:var(--sans);font-weight:600">${esc(modeLabel(regime).replace(' nach § 19 UStG', ''))}</strong></div>
    </div>
    ${euer.drafts ? `<p class="muted" style="margin:16px 0 0;font-size:13px">Enthält ${euer.drafts} ${euer.drafts === 1 ? 'Entwurf' : 'Entwürfe'}.</p>` : ''}
  </section>
  <div class="side">${side}</div>
</div>
<div class="grid">
  <a class="tile${oldDrafts ? ' alert' : ''}" href="/buchungen?status=draft"><span class="big">${drafts.length}</span><strong>${drafts.length === 1 ? 'Entwurf' : 'Entwürfe'} festschreiben</strong><small>${oldDrafts ? `${oldDrafts} älter als zehn Tage` : drafts.length ? 'alle aus den letzten zehn Tagen' : 'nichts offen'}</small></a>
  <a class="tile" href="/belege"><span class="big">${unlinked.length}</span><strong>Belege ohne Buchung</strong><small>${unlinked[0] ? 'zuletzt am ' + formatDate(unlinked[0].uploadedAt) : 'alles zugeordnet'}</small></a>
  ${vatTile}
</div>
<div class="row" style="margin-bottom:0">
  <section class="card grow">
    <div class="card-head"><h2 class="label">Je Monat</h2>${legend()}</div>
    ${monthChart(income, expense, year)}
  </section>
  <section class="card side">
    <div class="card-head" style="margin-bottom:8px"><h2 class="label">Zuletzt</h2><a href="/buchungen" style="font-size:13px;font-weight:600;text-decoration:none">Alle</a></div>
    ${recent.length ? `<ul class="recent">${recentList}</ul>` : `<p class="muted">Noch keine Buchungen. <a href="/belege">Ersten Beleg hochladen</a> oder <a href="/buchungen/neu">direkt buchen</a>.</p>`}
  </section>
</div>`
  return html(page({ title: 'Übersicht', active: 'overview', body, readOnly: ctx.readOnly }))
}
