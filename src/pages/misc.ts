import { ACTION_LABELS } from '../audit'
import type { Ctx } from '../context'
import { esc, html } from '../http'
import { formatDateTime } from '../time'
import { MORE_LINKS, page, pageHead } from '../views/layout'

function subjectLink(subject: string): string {
  const [type, id] = subject.split(':')
  if (type === 'entry') return `<a href="/buchungen/${esc(id)}">Buchung ${esc(id)}</a>`
  if (type === 'document') return `<a href="/belege/${esc(id)}">Beleg ${esc(id)}</a>`
  if (type === 'month') return `<a href="/monate/${esc(id)}">${esc(id)}</a>`
  return esc(subject.startsWith('sha:') ? subject.slice(0, 16) + '…' : subject)
}

export async function logPage(ctx: Ctx): Promise<Response> {
  const before = Number(ctx.url.searchParams.get('vor')) || Number.MAX_SAFE_INTEGER
  const { results } = await ctx.env.DB.prepare('SELECT id, at, actor, action, subject, detail FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 200').bind(before)
    .all<{ id: number; at: string; actor: string; action: string; subject: string; detail: string }>()
  const rows = results.map(r => `<tr><td class="num muted" style="white-space:nowrap">${formatDateTime(r.at)}</td><td>${esc(ACTION_LABELS[r.action] ?? r.action)}</td><td>${subjectLink(r.subject)}</td><td class="muted">${esc(r.actor)}</td>
<td><details><summary class="muted" style="cursor:pointer;font-size:13px">Details</summary><pre class="num" style="white-space:pre-wrap;font-size:12px;max-width:520px;margin:8px 0 0">${esc(pretty(r.detail))}</pre></details></td></tr>`).join('')
  const last = results.at(-1)
  const body = `${pageHead('Protokoll', 'Jede Änderung mit Zeitpunkt und Person. Das Protokoll lässt sich weder ändern noch kürzen.')}
<section class="card flush">
  <div class="table-wrap"><table class="list" style="min-width:820px"><thead><tr><th>Zeitpunkt</th><th>Aktion</th><th>Betrifft</th><th>Wer</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">Noch keine Einträge.</td></tr>'}</tbody></table></div>
  ${results.length === 200 && last ? `<div class="table-foot"><span></span><a href="/protokoll?vor=${last.id}">Ältere Einträge</a></div>` : ''}
</section>`
  return html(page({ title: 'Protokoll', active: 'log', body, readOnly: ctx.readOnly }))
}

function pretty(detail: string): string {
  try { return JSON.stringify(JSON.parse(detail), null, 2) } catch { return detail }
}

export async function morePage(ctx: Ctx): Promise<Response> {
  const body = `${pageHead('Mehr')}
<ul class="doclist">${MORE_LINKS.map(l => `<li><span class="text"><a href="${l.href}">${esc(l.label)}</a></span></li>`).join('')}</ul>`
  return html(page({ title: 'Mehr', active: 'more', body, readOnly: ctx.readOnly }))
}
