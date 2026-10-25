import { afterEach, describe, expect, test } from 'bun:test'
import { strFromU8, unzipSync } from 'fflate'
import { nightlyBackup, sqlDump } from '../src/exports'
import { freshDb } from './db'
import { startWorker, type Worker } from './worker'

let w: Worker
afterEach(() => w?.stop())

async function upload(name = 'neroserv-oktober.pdf', content = '%PDF-1.4 neroserv'): Promise<number> {
  const res = await w.call('/belege', { files: [{ name, content }], form: { kind: 'invoice' } })
  expect(res.status).toBe(303)
  return Number(res.headers.get('location')!.match(/\/belege\/(\d+)/)![1])
}

async function book(form: Record<string, string | string[]>): Promise<number> {
  const res = await w.call('/buchungen', { form: { paid_on: '2026-10-18', text: 'Server Oktober', counterparty: 'neroserv', account_id: '1', line_category: '3', line_tax_0: 'DE19', line_gross: '24,99', then: 'save', ...form } })
  expect(res.status).toBe(303)
  return Number(res.headers.get('location')!.match(/\/buchungen\/(\d+)/)![1])
}

describe('access', () => {
  test('without a token nothing is shown, and writes need the own origin', async () => {
    w = await startWorker()
    expect((await w.call('/', { token: null })).status).toBe(403)
    expect((await w.call('/', { token: 'a.b.c' })).status).toBe(403)
    const res = await w.call('/einstellungen/stammdaten', { form: { business_name: 'x' }, origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect((await w.call('/einstellungen/stammdaten', { form: { business_name: 'x' }, origin: null })).status).toBe(403)
  })

  test('a reader sees everything and may export, but changes nothing', async () => {
    w = await startWorker({ roles: { 'josua@example.com': 'admin', 'pruefer@example.com': 'reader' } })
    const page = await (await w.call('/buchungen', { email: 'pruefer@example.com' })).text()
    expect(page).toContain('Nur lesen')
    expect(page).not.toContain('Neue Buchung</a>')
    const res = await w.call('/buchungen', { email: 'pruefer@example.com', form: { paid_on: '2026-10-18', text: 'x', account_id: '1', line_category: '3', line_tax_0: 'DE19', line_gross: '1' } })
    expect(res.status).toBe(403)
    expect((await w.call('/export/euer', { email: 'pruefer@example.com', form: { jahr: '2026' } })).status).toBe(200)
  })

  test('every page renders', async () => {
    w = await startWorker()
    for (const path of ['/', '/belege', '/buchungen', '/buchungen/neu', '/buchungen?status=draft', '/auswertungen', '/auswertungen?ansicht=kategorien', '/anlagen', '/export', '/einstellungen', '/einstellungen?jahr=2027', '/protokoll', '/mehr', '/monate/2026-09']) {
      const res = await w.call(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-security-policy'), path).toContain("default-src 'self'")
    }
    expect((await w.call('/gibts-nicht')).status).toBe(404)
    expect((await w.call('/buchungen/999')).status).toBe(404)
    expect((await w.call('/buchungen', { method: 'PUT' })).status).toBe(405)
  })
})

describe('documents', () => {
  test('upload, show, serve sandboxed and note', async () => {
    w = await startWorker()
    const id = await upload()
    const page = await (await w.call(`/belege/${id}`)).text()
    expect(page).toContain('neroserv-oktober.pdf')
    expect(page).toContain('Sperre')
    const file = await w.call(`/belege/${id}/datei`)
    expect(file.headers.get('content-type')).toBe('application/pdf')
    expect(file.headers.get('content-security-policy')).toContain('sandbox')
    expect(await file.text()).toBe('%PDF-1.4 neroserv')
    const again = await w.call('/belege', { files: [{ name: 'kopie.pdf', content: '%PDF-1.4 neroserv' }] })
    expect(again.headers.get('location')).toBe(`/belege/${id}?hinweis=doppelt`)
    expect((await w.call(`/belege/${id}/vermerk`, { form: { note: 'doppelt' } })).status).toBe(303)
    expect((await w.call('/belege', { files: [{ name: 'boese.html', content: '<script>' }] })).status).toBe(400)
  })
})

describe('entries', () => {
  test('book, post, reverse and close a month through the pages', async () => {
    w = await startWorker()
    const doc = await upload()
    const id = await book({ document_id: String(doc), paid_on: '2026-09-18' })
    let page = await (await w.call(`/buchungen/${id}`)).text()
    expect(page).toContain('Entwurf bearbeiten')
    expect(page).toContain('Vorsteuer von 3,99 €')

    const post = await w.call(`/buchungen/${id}/festschreiben`, { form: {} })
    expect(post.headers.get('location')).toBe(`/buchungen/${id}?hinweis=festgeschrieben`)
    page = await (await w.call(`/buchungen/${id}`)).text()
    expect(page).toContain('2026-0001')
    expect(page).toContain('Stornieren')
    expect((await w.call(`/buchungen/${id}`, { form: { paid_on: '2026-09-18', text: 'anders', account_id: '1', line_category: '3', line_tax_0: 'DE19', line_gross: '1' } })).status).toBe(409)

    const month = await w.call('/monate/2026-09', { form: { balance_1: '-24,99', balance_2: '0', balance_3: '0' } })
    expect(month.headers.get('location')).toContain('hinweis=abgeschlossen')
    const late = await w.call('/buchungen', { form: { paid_on: '2026-09-20', text: 'zu spät', account_id: '1', line_category: '3', line_tax_0: 'DE19', line_gross: '5', then: 'save' } })
    expect(late.status).toBe(400)
    expect(await late.text()).toContain('Dieser Monat ist abgeschlossen.')

    const storno = await w.call(`/buchungen/${id}/storno`, { form: { reason: 'falscher Betrag' } })
    expect(storno.status).toBe(303)
    const list = await (await w.call('/buchungen?monat=2026-09')).text()
    expect(list).toContain('Storno zu 2026-0001')
    expect(list).toContain('Storniert')
  })

  test('a rejected form comes back filled in, and lines can be added without script', async () => {
    w = await startWorker()
    const res = await w.call('/buchungen', { form: { paid_on: '2026-10-18', text: '', counterparty: 'neroserv', account_id: '1', line_category: '3', line_tax_0: 'DE19', line_gross: '24,99', then: 'save' } })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('Der Buchungstext fehlt.')
    expect(body).toContain('value="neroserv"')
    const more = await (await w.call('/buchungen', { form: { paid_on: '2026-10-18', text: 'x', account_id: '1', line_category: '3', line_tax_0: 'DE19', line_gross: '24,99', then: 'add_line' } })).text()
    expect(more).toContain('name="line_tax_1"')
  })

  test('posting right away and the live preview', async () => {
    w = await startWorker()
    const res = await w.call('/buchungen', { form: { paid_on: '2026-10-22', text: 'Workers Paid', account_id: '1', line_category: '3', line_tax_0: 'RC_OTHER', line_gross: '4,31', reason: 'Rechnung per Mail', then: 'post' } })
    expect(res.headers.get('location')).toContain('hinweis=festgeschrieben')
    const preview = await (await w.call('/buchungen/vorschau', { form: { paid_on: '2026-10-22', line_category: '3', line_tax_0: 'RC_OTHER', line_gross: '4,31' } })).json() as { lines: Array<{ tax: string; title: string; warn: boolean }> }
    expect(preview.lines[0]).toMatchObject({ tax: '0,82 €', title: 'Du schuldest 0,82 € Umsatzsteuer', warn: true })
  })
})

describe('reports and exports', () => {
  test('EÜR and Voranmeldung show booked figures, a filing is kept and later changes are flagged', async () => {
    w = await startWorker()
    await book({ text: 'Tebex KW 42', line_category: '1', line_tax_0: 'ABROAD', line_gross: '286,40', reason: 'x', then: 'post' })
    await book({ text: 'Cloudflare', line_tax_0: 'RC_OTHER', line_gross: '4,31', reason: 'x', then: 'post' })
    const page = await (await w.call('/auswertungen?jahr=2026&zeitraum=2026-10')).text()
    expect(page).toContain('286,40 €')
    expect(page).toContain('0,82 €')
    const filed = await w.call('/voranmeldung/2026-10', { form: {} })
    expect(filed.status).toBe(303)
    expect(await (await w.call('/auswertungen?jahr=2026&zeitraum=2026-10')).text()).toContain('Übermittelt am')
    const id = (await w.db.prepare("SELECT id FROM entries WHERE text = 'Cloudflare'").first<{ id: number }>())!.id
    await w.call(`/buchungen/${id}/storno`, { form: { reason: 'doppelt' } })
    expect(await (await w.call('/auswertungen?jahr=2026&zeitraum=2026-10')).text()).toContain('Berichtigung nötig')
  })

  test('the Prüfer-Paket holds tables, index.xml, documents and correct checksums', async () => {
    w = await startWorker()
    const doc = await upload()
    await book({ document_id: String(doc), then: 'post' })
    const res = await w.call('/export/pruefer', { form: { from: '2026-01-01', to: '2026-12-31', documents: '1', log: '1', procedure: '1' } })
    expect(res.status).toBe(200)
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['index.xml', 'buchungen.csv', 'positionen.csv', 'belege.csv', 'protokoll.csv', 'pruefsummen.txt', 'verfahrensdokumentation/fassung-1.md']))
    expect(Object.keys(files).some(f => f.startsWith('belege/B-'))).toBe(true)
    const index = strFromU8(files['index.xml']!)
    expect(index).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">')
    expect(index).toContain('<URL>positionen.csv</URL>')
    expect(strFromU8(files['positionen.csv']!)).toContain(';24,99')
    for (const line of strFromU8(files['pruefsummen.txt']!).trim().split('\n')) {
      const [sum, path] = line.split('  ')
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', files[path!]!))
      expect([...digest].map(b => b.toString(16).padStart(2, '0')).join('')).toBe(sum!)
    }
    const row = await w.db.prepare("SELECT r2_key FROM exports WHERE kind = 'pruefer'").first<{ r2_key: string }>()
    expect(w.bucket.objects.has(row!.r2_key)).toBe(true)
  })

  test('EÜR as PDF and the full backup', async () => {
    w = await startWorker()
    await book({ reason: 'x', then: 'post' })
    const pdf = await w.call('/export/euer', { form: { jahr: '2026' } })
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
    const backup = await w.call('/export/sicherung', { form: {} })
    const files = unzipSync(new Uint8Array(await backup.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['daten.zip', 'kontor.sql'])
    const row = await w.db.prepare("SELECT r2_key FROM exports WHERE kind = 'backup'").first<{ r2_key: string | null }>()
    expect(row?.r2_key).toBeNull()
  })

  test('the SQL dump restores into a fresh database despite the guards', async () => {
    w = await startWorker()
    const id = await book({ reason: 'x', then: 'post' })
    await w.call(`/buchungen/${id}/storno`, { form: { reason: 'falsch' } })
    await book({ text: 'Entwurf bleibt' })
    await w.call('/monate/2026-09', { form: { balance_1: '0', balance_2: '0', balance_3: '0' } })
    const dump = await sqlDump(w.db)
    const target = freshDb()
    await (target as unknown as { exec: (sql: string) => Promise<unknown> }).exec(dump)
    const count = await target.prepare("SELECT COUNT(*) AS n, SUM(status = 'posted') AS posted FROM entries").first<{ n: number; posted: number }>()
    expect(count).toEqual({ n: 3, posted: 2 })
    expect((await target.prepare('SELECT locked_at FROM periods WHERE month = ?').bind('2026-09').first<{ locked_at: string }>())?.locked_at).toBeTruthy()
    await nightlyBackup(w.env, new Date('2026-10-25T02:17:00Z'))
    expect(w.bucket.objects.has('sicherungen/2026-10-25.sql')).toBe(true)
  })
})
