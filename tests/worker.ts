import { resetCertsCacheForTests } from '../src/access'
import worker from '../src/index'
import type { Env } from '../src/types'
import { freshDb } from './db'
import { MemoryBucket } from './r2'

/**
 * The whole worker as Cloudflare calls it: real fetch handler, real database
 * with its triggers, a really signed Access token. Only the network is stubbed.
 */

export const ORIGIN = 'https://kontor.example'
const TEAM_DOMAIN = 'kontor-test.cloudflareaccess.com'
const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`
const AUD = 'kontor-aud'

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let pair: Promise<CryptoKeyPair> | null = null
function keyPair(): Promise<CryptoKeyPair> {
  pair ??= crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
  return pair
}

export async function accessToken(payload: Record<string, unknown> = {}): Promise<string> {
  const { privateKey } = await keyPair()
  const enc = (v: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(v)))
  const header = enc({ alg: 'RS256', typ: 'JWT' })
  const body = enc({ iss: `https://${TEAM_DOMAIN}`, aud: AUD, email: 'josua@example.com', exp: Math.floor(Date.now() / 1000) + 3600, nbf: Math.floor(Date.now() / 1000) - 60, ...payload })
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${header}.${body}`))
  return `${header}.${body}.${base64Url(new Uint8Array(signature))}`
}

export type CallOpts = {
  method?: string
  form?: Record<string, string | string[]>
  files?: Array<{ name: string; content: string | Uint8Array; field?: string }>
  origin?: string | null
  token?: string | null
  email?: string
}

export type Worker = { db: D1Database; env: Env; bucket: MemoryBucket; call: (path: string, opts?: CallOpts) => Promise<Response>; stop: () => void }

export async function startWorker(opts: { roles?: Record<string, string> } = {}): Promise<Worker> {
  const db = freshDb()
  const bucket = new MemoryBucket()
  const env: Env = { DB: db, FILES: bucket as unknown as R2Bucket, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD, ...(opts.roles ? { ACCESS_ROLES: JSON.stringify(opts.roles) } : {}) }
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== CERTS_URL) return new Response('nicht im Test', { status: 599 })
    const { publicKey } = await keyPair()
    return Response.json({ keys: [await crypto.subtle.exportKey('jwk', publicKey)] })
  }) as typeof fetch
  resetCertsCacheForTests()

  async function call(path: string, c: CallOpts = {}): Promise<Response> {
    const headers = new Headers()
    const token = c.token === undefined ? await accessToken(c.email ? { email: c.email } : {}) : c.token
    if (token) headers.set('cf-access-jwt-assertion', token)
    let body: BodyInit | undefined
    if (c.form || c.files) {
      const data = new FormData()
      for (const [k, v] of Object.entries(c.form ?? {})) for (const value of [v].flat()) data.append(k, value)
      for (const f of c.files ?? []) data.append(f.field ?? 'file', new File([f.content], f.name))
      body = data
    }
    const method = c.method ?? (body ? 'POST' : 'GET')
    if (method === 'POST' && c.origin !== null) headers.set('origin', c.origin ?? ORIGIN)
    return worker.fetch(new Request(ORIGIN + path, { method, headers, body }), env)
  }

  return { db, env, bucket, call, stop: () => { globalThis.fetch = original } }
}
