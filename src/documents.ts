import { audit } from './audit'
import { HttpError } from './http'
import { todayBerlin } from './time'
import type { Env } from './types'

export type DocumentKind = 'invoice' | 'receipt' | 'statement' | 'einvoice' | 'own' | 'confirmation' | 'other'

export const DOC_KINDS: Record<DocumentKind, string> = {
  invoice: 'Rechnung',
  receipt: 'Quittung oder Kassenbon',
  statement: 'Kontoauszug oder Bericht',
  einvoice: 'E-Rechnung (XML)',
  own: 'Eigenbeleg',
  confirmation: 'Bestätigung vom Finanzamt',
  other: 'Sonstiges'
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  xml: 'application/xml',
  csv: 'text/csv'
}

export const MAX_UPLOAD = 25 * 1048576

export type DocumentRow = {
  id: number
  number: string
  sha256: string
  r2Key: string
  filename: string
  mime: string
  size: number
  kind: DocumentKind
  uploadedAt: string
  uploadedBy: string
  mistaken: boolean
  note: string
  linked: number
}

/**
 * Picks the type from the file name, never from what the browser claims, so
 * nothing that could run as HTML or script ever gets stored.
 */
export function documentType(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  return TYPES[ext] ?? null
}

export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  return base.replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'beleg'
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Stores a file under its SHA-256. The same file uploaded twice is found
 * again instead of stored twice. With a bucket lock an object can never be
 * overwritten, so an object left behind by a failed insert is reused.
 */
export async function storeDocument(env: Env, file: File, kind: DocumentKind, actor: string): Promise<{ id: number; number: string; duplicate: boolean }> {
  const filename = cleanFilename(file.name)
  const mime = documentType(filename)
  if (!mime) throw new HttpError(400, 'Erlaubt sind PDF, Fotos (JPG, PNG, WebP, HEIC), E-Rechnungen als XML und CSV.')
  if (file.size === 0) throw new HttpError(400, 'Die Datei ist leer.')
  if (file.size > MAX_UPLOAD) throw new HttpError(413, 'Die Datei ist zu groß, erlaubt sind 25 MB.')
  const bytes = await file.arrayBuffer()
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes))
  const existing = await env.DB.prepare('SELECT id, number FROM documents WHERE sha256 = ?').bind(sha256).first<{ id: number; number: string }>()
  if (existing) return { ...existing, duplicate: true }
  const year = todayBerlin().slice(0, 4)
  const key = `belege/${year}/${sha256}`
  if (!(await env.FILES.head(key))) {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime }, customMetadata: { filename, sha256 }, sha256 })
  }
  const uploadedAt = new Date().toISOString().slice(0, 19) + 'Z'
  const effectiveKind: DocumentKind = mime === 'application/xml' && kind === 'invoice' ? 'einvoice' : kind
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO documents (number, sha256, r2_key, filename, mime, size, kind, uploaded_at, uploaded_by)
      VALUES ((SELECT 'B-' || ?1 || '-' || printf('%04d', COALESCE(MAX(CAST(substr(number, 8) AS INTEGER)), 0) + 1) FROM documents WHERE number LIKE 'B-' || ?1 || '-%'),
      ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(year, sha256, key, filename, mime, file.size, effectiveKind, uploadedAt, actor),
    audit(env.DB, actor, 'document.upload', `sha:${sha256}`, { filename, size: file.size, kind: effectiveKind })
  ])
  const row = await env.DB.prepare('SELECT id, number FROM documents WHERE sha256 = ?').bind(sha256).first<{ id: number; number: string }>()
  return { ...row!, duplicate: false }
}

const SELECT = `SELECT d.id, d.number, d.sha256, d.r2_key AS r2Key, d.filename, d.mime, d.size, d.kind, d.uploaded_at AS uploadedAt,
  d.uploaded_by AS uploadedBy, d.mistaken, d.note,
  (SELECT COUNT(*) FROM entry_documents ed JOIN entries e ON e.id = ed.entry_id WHERE ed.document_id = d.id AND e.status <> 'discarded') AS linked
  FROM documents d`

type Raw = Omit<DocumentRow, 'mistaken'> & { mistaken: number }
const map = (r: Raw): DocumentRow => ({ ...r, mistaken: r.mistaken === 1 })

export async function listDocuments(db: D1Database, opts: { unlinked?: boolean; limit?: number } = {}): Promise<DocumentRow[]> {
  const where = opts.unlinked ? ` WHERE d.mistaken = 0 AND NOT EXISTS (SELECT 1 FROM entry_documents ed JOIN entries e ON e.id = ed.entry_id WHERE ed.document_id = d.id AND e.status <> 'discarded')` : ''
  const { results } = await db.prepare(`${SELECT}${where} ORDER BY d.id DESC LIMIT ?`).bind(opts.limit ?? 200).all<Raw>()
  return results.map(map)
}

export async function getDocument(db: D1Database, id: number): Promise<DocumentRow | null> {
  const row = await db.prepare(`${SELECT} WHERE d.id = ?`).bind(id).first<Raw>()
  return row ? map(row) : null
}

export async function noteDocument(db: D1Database, id: number, note: string, actor: string): Promise<void> {
  if (!note) throw new HttpError(400, 'Bitte einen Vermerk eintragen, etwa "doppelt hochgeladen".')
  const doc = await getDocument(db, id)
  if (!doc) throw new HttpError(404, 'Diesen Beleg gibt es nicht.')
  await db.batch([
    db.prepare('UPDATE documents SET mistaken = 1, note = ? WHERE id = ?').bind(note.slice(0, 500), id),
    audit(db, actor, 'document.note', `document:${id}`, { note })
  ])
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`
}
