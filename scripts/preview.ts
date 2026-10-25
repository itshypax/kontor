import { loadAccounts, loadCategories } from '../src/catalog'
import { storeDocument } from '../src/documents'
import { createDraft, postEntry, readEntryForm, reverseEntry, validateEntry } from '../src/entries'
import { closeMonth, monthSummary } from '../src/periods'
import { periodRange } from '../src/time'
import { computeVatReturn, loadFieldMap } from '../src/ustva'
import { loadRegimes } from '../src/regime'
import { loadYearFacts } from '../src/facts'
import { snapshotOf } from '../src/vat'
import { startWorker, type Worker } from '../tests/worker'

// Local sample data only. Nothing here reaches Cloudflare or real books.
const ACTOR = 'josua@example.com'
let worker: Worker

async function entry(w: Worker, values: Record<string, string>, post = true, doc?: string): Promise<number> {
  const form = new FormData()
  for (const [k, v] of Object.entries({ account_id: '1', counterparty: '', reason: '', ...values })) form.append(k, v)
  if (doc) {
    const stored = await storeDocument(w.env, new File([`%PDF-1.4\n% ${doc}\n`], doc), 'invoice', ACTOR)
    form.append('document_id', String(stored.id))
  }
  const raw = readEntryForm(form)
  const { input, errors } = validateEntry(raw, await loadCategories(w.db), await loadAccounts(w.db))
  if (!input) throw new Error(errors.join(' '))
  const id = await createDraft(w.db, input, ACTOR)
  if (post) await postEntry(w.db, id, ACTOR)
  return id
}

async function seed(w: Worker): Promise<void> {
  const income = [31240, 48810, 65590, 59025, 81270, 103455, 96830, 121580, 140215, 111860]
  for (let m = 1; m <= 10; m++) {
    const month = String(m).padStart(2, '0')
    const weeks = m === 10 ? [3, 10, 17, 24] : [5, 12, 19, 26]
    const shares = [0.22, 0.27, 0.25, 0.26]
    let left = income[m - 1]!
    for (let i = 0; i < 4; i++) {
      const amount = i === 3 ? left : Math.round(income[m - 1]! * shares[i]!)
      left -= amount
      const kw = Math.ceil((Date.UTC(2026, m - 1, weeks[i]!) - Date.UTC(2026, 0, 1)) / 604800000) + 1
      const draft = m === 10 && i === 3
      await entry(w, { paid_on: `2026-${month}-${String(weeks[i]).padStart(2, '0')}`, text: `Tebex Auszahlung KW ${kw}`, counterparty: 'Tebex Limited', line_category: '1', line_tax_0: 'ABROAD', line_gross: (amount / 100).toFixed(2).replace('.', ','), account_id: '1' }, !draft, `tebex-payout-kw${kw}.pdf`)
    }
    await entry(w, { paid_on: `2026-${month}-18`, text: 'Server ' + ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober'][m - 1], counterparty: 'neroserv', line_category: '3', line_tax_0: 'DE19', line_gross: '24,99' }, true, `neroserv-2026-${month}.pdf`)
    await entry(w, { paid_on: `2026-${month}-22`, text: 'Workers Paid', counterparty: 'Cloudflare, Inc.', line_category: '3', line_tax_0: 'RC_OTHER', line_gross: '4,31', currency: 'USD', original_amount: '5,00' }, m !== 10, `cloudflare-invoice-2026-${month}.pdf`)
    await entry(w, { paid_on: `2026-${month}-08`, text: 'Kontoführung', counterparty: 'Bank', line_category: '12', line_tax_0: 'EXEMPT', line_gross: '6,90' }, true, `kontoauszug-2026-${month}.pdf`)
    if (m > 1) await entry(w, { paid_on: `2026-${month}-09`, text: 'Umsatzsteuer Reverse Charge Vormonat', counterparty: 'Finanzamt', line_category: '15', line_tax_0: 'NONE', line_gross: m === 6 ? '23,32' : '0,82', reason: 'Lastschrift laut Kontoauszug' })
  }
  await entry(w, { paid_on: '2026-01-14', text: 'Gewerbeanmeldung', counterparty: 'Stadt', line_category: '10', line_tax_0: 'NONE', line_gross: '26,00' }, true, 'gewerbeanmeldung-gebuehr.pdf')
  await entry(w, { paid_on: '2026-05-12', text: 'Anzeigen für den Script-Launch', counterparty: 'Meta Platforms Ireland', line_category: '4', line_tax_0: 'RC_EU', line_gross: '118,40' }, true, 'meta-ads-mai.pdf')
  await entry(w, { paid_on: '2026-08-04', text: 'Monitor für Tests', counterparty: 'Elektronikmarkt', line_category: '5', line_tax_0: 'DE19', line_gross: '412,00' }, true, 'kassenbon-monitor.pdf')
  await entry(w, { paid_on: '2026-10-20', text: 'Domain emergencyforge.de', counterparty: 'INWX GmbH', line_category: '3', line_tax_0: 'DE19', line_gross: '14,90' }, true, 'inwx-rechnung.pdf')
  await entry(w, { paid_on: '2026-10-12', text: 'Lizenz Oktober', counterparty: 'JetBrains s.r.o.', line_category: '3', line_tax_0: 'DE19', line_gross: '37,20' }, false)
  const wrong = await entry(w, { paid_on: '2026-10-05', text: 'Server Oktober doppelt', counterparty: 'neroserv', line_category: '3', line_tax_0: 'DE19', line_gross: '29,99' }, true, 'neroserv-2026-10-alt.pdf')
  await reverseEntry(w.db, wrong, 'falscher Betrag und doppelt erfasst', ACTOR)
  await storeDocument(w.env, new File(['%PDF-1.4 kassenbon'], 'IMG_2041.pdf'), 'receipt', ACTOR)
  await storeDocument(w.env, new File(['%PDF-1.4 rechnung'], 'invoice-2026-10.pdf'), 'invoice', ACTOR)

  const facts = await loadYearFacts(w.db, 2026)
  const regimes = await loadRegimes(w.db)
  const fields = await loadFieldMap(w.db, 2026)
  for (let m = 1; m <= 9; m++) {
    const month = `2026-${String(m).padStart(2, '0')}`
    const range = periodRange(month)!
    const result = computeVatReturn(facts, regimes, fields, range.from, range.to)
    await w.db.prepare('INSERT INTO vat_filings (period, filed_at, filed_by, snapshot) VALUES (?, ?, ?, ?)').bind(month, `2026-${String(m + 1).padStart(2, '0')}-09T18:00:00Z`, ACTOR, snapshotOf(result)).run()
    if (m <= 8) {
      const s = await monthSummary(w.db, month)
      await closeMonth(w.db, month, Object.fromEntries(s.balances.map(b => [String(b.accountId), b.booked])), '', ACTOR)
    }
  }
}

async function reset(empty = false) {
  worker?.stop()
  worker = await startWorker()
  if (!empty) await seed(worker)
}

await reset()
const TYPES: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
Bun.serve({
  hostname: '127.0.0.1',
  port: 8789,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__fixtures/reset' && request.method === 'POST') {
      await reset(url.searchParams.get('scenario') === 'empty')
      return Response.json({ ok: true })
    }
    const ext = url.pathname.match(/\.[a-z0-9]+$/)?.[0] ?? ''
    if (TYPES[ext] && !url.pathname.includes('..')) {
      const file = Bun.file(`public${url.pathname}`)
      if (await file.exists()) return new Response(file, { headers: { 'content-type': TYPES[ext]! } })
    }
    const body = request.method === 'POST' ? await request.formData() : null
    const form: Record<string, string[]> = {}
    const files: Array<{ name: string; content: Uint8Array; field: string }> = []
    if (body) for (const [key, value] of body.entries()) {
      if (typeof value === 'string') (form[key] ??= []).push(value)
      else if (value.size) files.push({ name: value.name, content: new Uint8Array(await value.arrayBuffer()), field: key })
    }
    const response = await worker.call(url.pathname + url.search, { method: request.method, ...(body ? { form, files } : {}) })
    // The harness uses a fixed origin; redirects must stay on the preview host.
    const location = response.headers.get('location')
    if (location?.startsWith('https://kontor.example')) {
      const headers = new Headers(response.headers)
      headers.set('location', location.slice('https://kontor.example'.length))
      return new Response(response.body, { status: response.status, headers })
    }
    return response
  }
})
console.log('Vorschau: http://127.0.0.1:8789 (Beispieldaten nur im Arbeitsspeicher)')
