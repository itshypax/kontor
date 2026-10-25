import type { Ctx } from '../context'
import { esc, field, html, HttpError, readForm, redirect } from '../http'
import { formatCents, parseAmount, plainCents } from '../money'
import { closeMonth, monthSummary } from '../periods'
import { formatDateTime, isMonth, monthName } from '../time'
import { errorList, icon, notice, page, pageHead } from '../views/layout'

async function render(ctx: Ctx, month: string, errors: string[] = [], typed: Record<string, string> = {}, explanation = ''): Promise<Response> {
  const s = await monthSummary(ctx.env.DB, month)
  const rows = s.balances.map(b => {
    const value = typed[String(b.accountId)] ?? (b.bank !== null ? plainCents(b.bank) : '')
    return `<tr><td><span class="cell-main">${esc(b.name)}</span></td><td class="r num">${formatCents(b.booked)}</td>
<td class="r">${s.locked ? `<span class="num">${b.bank === null ? '' : formatCents(b.bank)}</span>` : `<label class="sr" for="b${b.accountId}">Kontostand ${esc(b.name)}</label><input id="b${b.accountId}" name="balance_${b.accountId}" class="num" inputmode="decimal" value="${esc(value)}" style="width:160px;text-align:right" required>`}</td>
<td class="r num">${b.difference === null ? '' : formatCents(b.difference)}</td></tr>`
  }).join('')
  const body = `${pageHead(monthName(month), s.locked ? `Abgeschlossen am ${formatDateTime(s.locked.at)} von ${esc(s.locked.by)}` : 'Kontoabgleich und Abschluss. Danach nimmt der Monat keine neuen Buchungen mehr an, Korrekturen gehen nur per Storno.', '', { href: `/buchungen?monat=${month}`, label: 'Buchungen' })}
${errorList(errors)}
${s.drafts && !s.locked ? notice(`<strong>${s.drafts} ${s.drafts === 1 ? 'Entwurf' : 'Entwürfe'} offen.</strong> Erst festschreiben oder verwerfen. <a href="/buchungen?monat=${month}&status=draft">Zu den Entwürfen</a>`, true) : ''}
<div class="grid">
  <div class="tile"><span class="label">Einnahmen</span><span class="big" style="font-size:30px">${formatCents(s.income)}</span></div>
  <div class="tile"><span class="label">Ausgaben</span><span class="big" style="font-size:30px">${formatCents(s.expense)}</span></div>
</div>
<form method="post" action="/monate/${month}" class="card flush">
  <div class="card-head"><div><h2>Kontoabgleich</h2><p class="sub">Kontostand laut Bank zum Monatsende eintragen. Eine Abweichung heißt meist, dass eine Buchung fehlt.</p></div></div>
  <div class="table-wrap"><table class="list"><thead><tr><th>Konto</th><th class="r">Laut Kontor</th><th class="r">Laut Bank</th><th class="r">Abweichung</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${s.locked || ctx.readOnly ? '' : `<div style="padding:20px 24px 24px" class="stack">
    <div class="field"><label for="explanation">Erklärung, falls es eine Abweichung gibt</label><textarea id="explanation" name="explanation" maxlength="500" style="min-height:80px">${esc(explanation)}</textarea></div>
    <div class="actions"><button class="btn btn-primary btn-lg"${s.drafts ? ' disabled' : ''} data-confirm="${esc(monthName(month))} abschließen? Danach sind nur noch Stornos möglich.">${icon('lock')}Monat abschließen</button></div>
  </div>`}
</form>`
  return html(page({ title: monthName(month), active: 'entries', body, readOnly: ctx.readOnly }), errors.length ? 400 : 200)
}

export async function monthPage(ctx: Ctx, month: string): Promise<Response> {
  if (!isMonth(month)) throw new HttpError(404, 'Diesen Monat gibt es nicht.')
  return render(ctx, month)
}

export async function closeMonthAction(ctx: Ctx, month: string): Promise<Response> {
  if (!isMonth(month)) throw new HttpError(404, 'Diesen Monat gibt es nicht.')
  const form = await readForm(ctx.request)
  const typed: Record<string, string> = {}
  const bank: Record<string, number> = {}
  const errors: string[] = []
  for (const [key, value] of form.entries()) {
    const match = key.match(/^balance_(\d+)$/)
    if (!match || typeof value !== 'string') continue
    typed[match[1]!] = value
    const cents = parseAmount(value)
    if (cents === null) errors.push('Ein Kontostand ist ungültig.')
    else bank[match[1]!] = cents
  }
  const explanation = field(form, 'explanation')
  if (errors.length) return render(ctx, month, errors, typed, explanation)
  try { await closeMonth(ctx.env.DB, month, bank, explanation, ctx.actor) }
  catch (error) {
    if (error instanceof HttpError && error.status < 500) return render(ctx, month, [error.message], typed, explanation)
    throw error
  }
  return redirect(`/buchungen?monat=${month}&hinweis=abgeschlossen`)
}
