import { accessIdentity, requireAccess } from './access'
import { nightlyBackup } from './exports'
import { guardMessage, HttpError, html, text } from './http'
import { route } from './router'
import { todayBerlin } from './time'
import type { Env } from './types'
import { errorPage } from './views/layout'

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(self), geolocation=(), microphone=()'
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

/**
 * Access only keeps strangers out. A form on another site could still post
 * here with the cookie of a signed-in browser, so writes must come from here.
 */
function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin
}

async function handle(request: Request, env: Env): Promise<Response> {
  const denied = await requireAccess(request, env)
  if (denied) return denied
  const identity = accessIdentity(request)
  const readOnly = identity.role === 'reader'
  if (request.method === 'POST' && !sameOrigin(request)) return text('Fremde Herkunft.', 403)
  const ctx = { env, request, url: new URL(request.url), actor: identity.actor, readOnly, today: todayBerlin() }
  try {
    return await route(ctx)
  } catch (error) {
    if (error instanceof HttpError) return html(errorPage(error.status, error.message, readOnly), error.status)
    const guard = guardMessage(error)
    if (guard) return html(errorPage(409, guard, readOnly), 409)
    console.error('Anfrage fehlgeschlagen:', error)
    return html(errorPage(500, 'Da ist etwas schiefgegangen. Bitte erneut versuchen, das Protokoll zeigt, was gespeichert wurde.', readOnly), 500)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handle(request, env)
    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v)
    if (!headers.has('content-security-policy')) headers.set('content-security-policy', CSP)
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await nightlyBackup(env, new Date(controller.scheduledTime))
  }
} satisfies ExportedHandler<Env>
