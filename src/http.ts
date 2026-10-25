export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function text(message: string, status = 200): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } })
}

export function methodDenied(request: Request, allowed: string[]): Response | null {
  const methods = allowed.includes('GET') ? [...allowed, 'HEAD'] : allowed
  if (methods.includes(request.method)) return null
  const response = text(`Erlaubte Methoden: ${methods.join(', ')}.`, 405)
  response.headers.set('allow', methods.join(', '))
  return response
}

/** Form bodies without files. Uploads go through readUpload. */
export async function readForm(request: Request, limit = 262144): Promise<FormData> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, 'Die Anfrage ist zu groß.')
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.byteLength > limit) throw new HttpError(413, 'Die Anfrage ist zu groß.')
  try { return await new Response(body, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData() }
  catch { throw new HttpError(400, 'Das Formular ließ sich nicht lesen.') }
}

export async function readUpload(request: Request, limit: number): Promise<FormData> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, `Die Datei ist zu groß, erlaubt sind ${Math.floor(limit / 1048576)} MB.`)
  try { return await request.formData() }
  catch { throw new HttpError(400, 'Die Datei ließ sich nicht lesen.') }
}

export function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export function fields(form: FormData, name: string): string[] {
  return form.getAll(name).map(v => (typeof v === 'string' ? v.trim() : ''))
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]!)
}

/**
 * The guards in the database abort with a German sentence. D1 wraps it as
 * "D1_ERROR: <sentence>: SQLITE_CONSTRAINT ...", bun:sqlite passes it with
 * the code on the error. Anything else is a real failure and gets null.
 */
export function guardMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
  if (!/SQLITE_CONSTRAINT/.test(message + ' ' + code)) return null
  const sentence = message.replace(/^.*D1_ERROR: /, '').replace(/:? *SQLITE_[A-Z_].*$/s, '').trim()
  return /^[A-ZÄÖÜ][^\n]{5,240}\.$/.test(sentence) ? sentence : null
}
