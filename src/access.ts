import type { Env } from './types'

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }

/** Base64url without padding, as used in JWTs, to bytes. */
function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}

type AccessPayload = {
  email?: unknown
  sub?: unknown
  iss?: unknown
  aud?: unknown
  exp?: unknown
  nbf?: unknown
}

export type Identity = { actor: string; role: 'reader' | 'editor' | 'admin' }
const identities = new WeakMap<Request, Identity>()
export function accessIdentity(request: Request): Identity { return identities.get(request) ?? { actor: 'unknown', role: 'reader' } }

// Cloudflare rotates the signing keys. An hour notices a rotation soon enough
// and saves fetching the keys on every request.
const CERTS_CACHE_TTL_MS = 60 * 60 * 1000
// One entry per certs URL, so two teams in one isolate never share keys.
const certsCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>()

/** Tests only: a test with new keys would otherwise see the cache of an earlier one. */
export function resetCertsCacheForTests(): void {
  certsCache.clear()
}

/**
 * Team keys, cached. A failed refresh never falls back to an expired entry,
 * so an outage of the endpoint cannot hide behind the cache. A fetcher passed
 * in for tests neither reads nor writes the cache, so planted keys cannot
 * outlive the test that planted them.
 */
async function getCerts(certsFetcher: typeof fetch | undefined, issuer: string): Promise<JsonWebKey[] | null> {
  const useCache = certsFetcher === undefined
  const fetcher = certsFetcher ?? fetch
  const certsUrl = `${issuer}/cdn-cgi/access/certs`

  if (useCache) {
    const cached = certsCache.get(certsUrl)
    if (cached && Date.now() - cached.fetchedAt < CERTS_CACHE_TTL_MS) return cached.keys
  }

  try {
    const response = await fetcher(certsUrl)
    if (!response.ok) throw new Error(`certs-endpoint antwortete mit ${response.status}`)
    const body = (await response.json()) as { keys?: JsonWebKey[] }
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('keine keys im certs-endpoint')
    if (useCache) certsCache.set(certsUrl, { keys: body.keys, fetchedAt: Date.now() })
    return body.keys
  } catch {
    return null
  }
}

/**
 * Checks the Access JWT against the team keys. Returns null when it passes,
 * otherwise the response to send. The signature is verified before anything
 * in the payload is read, because until then all of it may be made up. Every
 * failure, including missing configuration, denies.
 */
export async function requireAccess(
  request: Request,
  env: Env,
  certsFetcher?: typeof fetch
): Promise<Response | null> {
  // Unset values would otherwise match each other (undefined === undefined).
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return new Response('Access ist nicht korrekt konfiguriert.', { status: 503 })
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return new Response('Nicht angemeldet.', { status: 403 })

  const parts = token.split('.')
  if (parts.length !== 3) return new Response('Ungültig.', { status: 403 })
  const [rawHeader, rawPayload, rawSignature] = parts
  if (!rawHeader || !rawPayload || !rawSignature) {
    return new Response('Ungültig.', { status: 403 })
  }

  let signature: Uint8Array
  try {
    signature = base64UrlToBytes(rawSignature)
  } catch {
    return new Response('Ungültig.', { status: 403 })
  }

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`

  const keys = await getCerts(certsFetcher, issuer)
  if (!keys) return new Response('Access nicht erreichbar.', { status: 503 })

  const signedData = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  let verified = false
  for (const jwk of keys) {
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, ALGORITHM, false, ['verify'])
      if (await crypto.subtle.verify(ALGORITHM.name, key, signature, signedData)) {
        verified = true
        break
      }
    } catch {
      // unusable key, try the next one
    }
  }
  // The alg header is never read, so "alg: none" cannot get in.
  if (!verified) return new Response('Signatur stimmt nicht.', { status: 403 })

  let payload: AccessPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(rawPayload)))
  } catch {
    return new Response('Ungültig.', { status: 403 })
  }

  if (payload.iss !== issuer) return new Response('Falscher Aussteller.', { status: 403 })

  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(env.ACCESS_AUD)
    : payload.aud === env.ACCESS_AUD
  if (!audMatches) return new Response('Falsches Ziel.', { status: 403 })

  const now = Date.now()
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    return new Response('Abgelaufen.', { status: 403 })
  }
  if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now) {
    return new Response('Noch nicht gültig.', { status: 403 })
  }

  const actor = typeof payload.email === 'string' ? payload.email.toLowerCase() : typeof payload.sub === 'string' ? payload.sub : 'access-service'
  let role: Identity['role'] = 'admin'
  if (env.ACCESS_ROLES) {
    try { const roles = JSON.parse(env.ACCESS_ROLES); const assigned = Object.hasOwn(roles, actor) ? roles[actor] : 'reader'; role = ['reader','editor','admin'].includes(assigned) ? assigned : 'reader' }
    catch { return new Response('Rollen sind nicht korrekt konfiguriert.', { status: 503 }) }
  }
  identities.set(request, { actor, role })
  return null
}
