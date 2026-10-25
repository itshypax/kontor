import { depreciation, loadAssets, METHOD_LABELS, type Asset } from '../afa'
import { audit } from '../audit'
import type { Ctx } from '../context'
import { esc, field, html, HttpError, readForm, redirect } from '../http'
import { formatCents, parseAmount } from '../money'
import { formatDate, isDate, isoSeconds } from '../time'
import { errorList, hint, page, pageHead } from '../views/layout'

async function render(ctx: Ctx, errors: string[] = [], typed: Record<string, string> = {}): Promise<Response> {
  const year = Number(ctx.url.searchParams.get('jahr')) || Number(ctx.today.slice(0, 4))
  const assets = await loadAssets(ctx.env.DB)
  const rows = assets.map(a => {
    const d = depreciation(a, year)
    return `<tr><td><span class="cell-main">${esc(a.name)}</span><span class="cell-sub">${esc(METHOD_LABELS[a.method])}${a.method === 'linear' ? `, ${a.usefulLifeMonths} Monate` : ''}</span></td>
<td class="num muted">${formatDate(a.acquiredOn)}</td><td class="r num">${formatCents(a.cost)}</td><td class="r num">${formatCents(d.afa)}</td><td class="r num">${formatCents(d.bookValueEnd)}</td>
<td>${a.disposedOn ? `Abgang ${formatDate(a.disposedOn)}` : ctx.readOnly ? '' : `<form method="post" action="/anlagen/${a.id}/abgang" class="actions"><label class="sr" for="d${a.id}">Abgang am</label><input id="d${a.id}" type="date" name="disposed_on" required style="min-height:36px"><button class="btn btn-sm" data-confirm="Abgang eintragen? Das lässt sich nicht zurücknehmen.">Abgang</button></form>`}</td></tr>`
  }).join('')
  const v = (k: string, d = '') => esc(typed[k] ?? d)
  const methods = (Object.keys(METHOD_LABELS) as Asset['method'][]).map(m => `<option value="${m}"${(typed.method ?? 'digital_one_year') === m ? ' selected' : ''}>${esc(METHOD_LABELS[m])}</option>`).join('')
  const form = ctx.readOnly ? '' : `<form method="post" action="/anlagen" class="card pad-lg side stack" style="gap:14px">
  <h2>Anlagegut eintragen</h2>
  <p class="muted" style="margin:0;font-size:14px">Den Kauf als Buchung mit der Kategorie "Anlagegut" erfassen, dann hier mit Kosten und Nutzungsdauer eintragen. Geringwertige Wirtschaftsgüter laufen direkt als Ausgabe und stehen hier nur im Verzeichnis.</p>
  <div class="field"><label for="name">Bezeichnung</label><input id="name" name="name" required maxlength="200" value="${v('name')}"></div>
  <div class="field"><label for="acquired_on">Angeschafft am</label><input id="acquired_on" name="acquired_on" type="date" required value="${v('acquired_on')}"></div>
  <div class="field"><label for="cost">Anschaffungskosten</label><input id="cost" name="cost" class="num" inputmode="decimal" required value="${v('cost')}"><small>netto bei Regelbesteuerung, brutto als Kleinunternehmer</small></div>
  <div class="field"><label for="method">Abschreibung</label><select id="method" name="method">${methods}</select></div>
  <div class="field"><label for="months">Nutzungsdauer in Monaten</label><input id="months" name="useful_life_months" type="number" min="1" max="600" value="${v('useful_life_months', '36')}"><small>nur bei linearer Abschreibung</small></div>
  <div class="field"><label for="entry">Buchungsnummer (optional)</label><input id="entry" name="entry_number" class="num" placeholder="2026-0042" value="${v('entry_number')}"></div>
  <div><button class="btn btn-primary">Eintragen</button></div>
</form>`
  const body = `${pageHead('Anlagen', `Anlagenverzeichnis mit Abschreibung ${year}`)}
${hint(ctx.url)}${errorList(errors)}
<div class="row">
  <section class="card flush grow">
    ${assets.length ? `<div class="table-wrap"><table class="list" style="min-width:760px"><thead><tr><th>Anlagegut</th><th>Angeschafft</th><th class="r">Kosten</th><th class="r">AfA ${year}</th><th class="r">Restwert</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted" style="padding:24px;margin:0">Noch keine Anlagegüter.</p>'}
  </section>
  ${form}
</div>`
  return html(page({ title: 'Anlagen', active: 'assets', body, readOnly: ctx.readOnly }), errors.length ? 400 : 200)
}

export const assetsPage = (ctx: Ctx) => render(ctx)

export async function createAssetAction(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.request)
  const typed = Object.fromEntries(['name', 'acquired_on', 'cost', 'method', 'useful_life_months', 'entry_number'].map(k => [k, field(form, k)]))
  const errors: string[] = []
  if (!typed.name) errors.push('Die Bezeichnung fehlt.')
  if (!isDate(typed.acquired_on!)) errors.push('Das Anschaffungsdatum fehlt oder ist ungültig.')
  const cost = parseAmount(typed.cost!)
  if (cost === null || cost <= 0) errors.push('Die Anschaffungskosten fehlen oder sind ungültig.')
  if (!Object.hasOwn(METHOD_LABELS, typed.method!)) errors.push('Bitte eine Abschreibung wählen.')
  const months = Number(typed.useful_life_months) || 0
  if (typed.method === 'linear' && (months < 1 || months > 600)) errors.push('Die Nutzungsdauer fehlt.')
  let entryId: number | null = null
  if (typed.entry_number) {
    const entry = await ctx.env.DB.prepare('SELECT id FROM entries WHERE number = ?').bind(typed.entry_number).first<{ id: number }>()
    if (!entry) errors.push('Diese Buchungsnummer gibt es nicht.')
    entryId = entry?.id ?? null
  }
  if (errors.length) return render(ctx, errors, typed)
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO assets (name, acquired_on, cost, method, useful_life_months, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(typed.name, typed.acquired_on, cost, typed.method, typed.method === 'linear' ? months : 0, entryId, isoSeconds()),
    audit(ctx.env.DB, ctx.actor, 'asset.create', 'asset', { ...typed, cost })
  ])
  return redirect('/anlagen?hinweis=anlage')
}

export async function disposeAssetAction(ctx: Ctx, id: number): Promise<Response> {
  const form = await readForm(ctx.request)
  const date = field(form, 'disposed_on')
  if (!isDate(date)) throw new HttpError(400, 'Das Abgangsdatum ist ungültig.')
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE assets SET disposed_on = ? WHERE id = ? AND disposed_on IS NULL').bind(date, id),
    audit(ctx.env.DB, ctx.actor, 'asset.dispose', `asset:${id}`, { date })
  ])
  return redirect('/anlagen?hinweis=abgang')
}
