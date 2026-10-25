/**
 * Enough of R2 for tests and the preview. Like a bucket with a lock, it
 * refuses to overwrite or delete an object under belege/ or exporte/.
 */
export class MemoryBucket {
  objects = new Map<string, { body: Uint8Array; contentType: string; customMetadata: Record<string, string>; uploaded: Date }>()

  async head(key: string) {
    const object = this.objects.get(key)
    return object ? { key, size: object.body.byteLength, httpMetadata: { contentType: object.contentType }, customMetadata: object.customMetadata, uploaded: object.uploaded } : null
  }

  async get(key: string) {
    const object = this.objects.get(key)
    if (!object) return null
    const body = object.body
    return {
      key, size: body.byteLength, httpMetadata: { contentType: object.contentType }, customMetadata: object.customMetadata, uploaded: object.uploaded,
      body: new Response(body).body, arrayBuffer: async () => body.slice().buffer, text: async () => new TextDecoder().decode(body),
      writeHttpMetadata: (headers: Headers) => headers.set('content-type', object.contentType)
    }
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {}) {
    if (this.objects.has(key) && /^(belege|exporte)\//.test(key)) throw new Error('Object is locked')
    const body = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value)
    this.objects.set(key, { body, contentType: opts.httpMetadata?.contentType ?? 'application/octet-stream', customMetadata: opts.customMetadata ?? {}, uploaded: new Date() })
    return { key, size: body.byteLength }
  }

  async delete(key: string) {
    if (/^(belege|exporte)\//.test(key)) throw new Error('Object is locked')
    this.objects.delete(key)
  }

  async list(opts: { prefix?: string } = {}) {
    return { objects: [...this.objects.keys()].filter(k => k.startsWith(opts.prefix ?? '')).map(key => ({ key, size: this.objects.get(key)!.body.byteLength })), truncated: false }
  }
}
