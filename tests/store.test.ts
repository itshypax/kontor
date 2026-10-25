import { describe, expect, test } from 'bun:test'
import { loadAccounts, loadCategories } from '../src/catalog'
import { storeDocument } from '../src/documents'
import { createDraft, discardDraft, getEntry, listEntries, postEntry, readEntryForm, reverseEntry, updateDraft, validateEntry } from '../src/entries'
import { closeMonth, monthSummary } from '../src/periods'
import type { Env } from '../src/types'
import { freshDb } from './db'
import { MemoryBucket } from './r2'

function env(): Env {
  return { DB: freshDb(), FILES: new MemoryBucket() as unknown as R2Bucket, ACCESS_TEAM_DOMAIN: 'x', ACCESS_AUD: 'y' }
}

function form(values: Record<string, string | string[]>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) for (const v of [value].flat()) data.append(key, v)
  return data
}

async function input(db: D1Database, over: Record<string, string | string[]> = {}) {
  const raw = readEntryForm(form({ paid_on: '2026-10-18', text: 'Server Oktober', counterparty: 'neroserv', account_id: '1', line_category: '3', line_tax_0: 'DE19', line_gross: '24,99', ...over }))
  const result = validateEntry(raw, await loadCategories(db), await loadAccounts(db))
  if (!result.input) throw new Error(result.errors.join(' '))
  return result.input
}

describe('documents', () => {
  test('stores a file once under its checksum and numbers it', async () => {
    const e = env()
    const file = new File(['%PDF-1.4 rechnung'], 'rechnung.pdf')
    const first = await storeDocument(e, file, 'invoice', 'josua@example.com')
    expect(first).toEqual({ id: 1, number: expect.stringMatching(/^B-\d{4}-0001$/), duplicate: false })
    const again = await storeDocument(e, new File(['%PDF-1.4 rechnung'], 'kopie.pdf'), 'invoice', 'josua@example.com')
    expect(again.duplicate).toBe(true)
    const second = await storeDocument(e, new File(['<Invoice/>'], 'e-rechnung.xml'), 'invoice', 'josua@example.com')
    expect(second.number).toMatch(/-0002$/)
    const row = await e.DB.prepare('SELECT kind, mime FROM documents WHERE id = ?').bind(second.id).first<{ kind: string; mime: string }>()
    expect(row).toEqual({ kind: 'einvoice', mime: 'application/xml' })
  })

  test('refuses files that could run in the browser', async () => {
    await expect(storeDocument(env(), new File(['<script>'], 'x.html'), 'invoice', 'a')).rejects.toThrow('Erlaubt sind')
    await expect(storeDocument(env(), new File(['<svg/>'], 'x.svg'), 'invoice', 'a')).rejects.toThrow('Erlaubt sind')
  })
})

describe('entries', () => {
  test('validation names what is missing', async () => {
    const db = freshDb()
    const raw = readEntryForm(form({ paid_on: '2026-02-30', text: '', account_id: '99', line_category: '3', line_tax_0: 'XX', line_gross: 'abc' }))
    const result = validateEntry(raw, await loadCategories(db), await loadAccounts(db))
    expect(result.input).toBeNull()
    expect(result.errors).toEqual(expect.arrayContaining(['Das Zahlungsdatum fehlt oder ist ungültig.', 'Der Buchungstext fehlt.', 'Bitte ein aktives Konto wählen.', 'Bitte einen Steuerschlüssel wählen.', 'Der Betrag fehlt oder ist ungültig.']))
  })

  test('draft, edit, post with a gapless number, reverse', async () => {
    const e = env()
    const doc = await storeDocument(e, new File(['%PDF neroserv'], 'neroserv.pdf'), 'invoice', 'josua')
    const id = await createDraft(e.DB, await input(e.DB, { line_gross: '29,99', document_id: String(doc.id) }), 'josua')
    let entry = await getEntry(e.DB, id)
    expect(entry?.lines[0]).toMatchObject({ net: 2520, tax: 479, gross: 2999 })
    await updateDraft(e.DB, id, await input(e.DB, { document_id: String(doc.id) }), 'josua')
    entry = await getEntry(e.DB, id)
    expect(entry?.lines).toHaveLength(1)
    expect(entry?.lines[0]?.gross).toBe(2499)
    expect(entry?.total).toBe(-2499)
    expect(await postEntry(e.DB, id, 'josua')).toBe('2026-0001')
    await expect(updateDraft(e.DB, id, await input(e.DB), 'josua')).rejects.toThrow('Nur Entwürfe')

    const other = await createDraft(e.DB, await input(e.DB, { text: 'Domain', line_gross: '14,90', reason: 'Rechnung kommt per Post' }), 'josua')
    expect(await postEntry(e.DB, other, 'josua')).toBe('2026-0002')

    const stornoId = await reverseEntry(e.DB, id, 'falscher Betrag', 'josua')
    const storno = await getEntry(e.DB, stornoId)
    expect(storno).toMatchObject({ number: '2026-0003', status: 'posted', reversesId: id, total: 2499, paidOn: '2026-10-18' })
    expect(storno?.documents.map(d => d.id)).toEqual([doc.id])
    expect((await getEntry(e.DB, id))?.reversedById).toBe(stornoId)
    await expect(reverseEntry(e.DB, id, 'nochmal', 'josua')).rejects.toThrow('schon storniert')
    await expect(reverseEntry(e.DB, stornoId, 'zurück', 'josua')).rejects.toThrow('nicht storniert')

    const { results } = await e.DB.prepare('SELECT action FROM audit_log ORDER BY id').all<{ action: string }>()
    expect(results.map(r => r.action)).toEqual(['document.upload', 'entry.create', 'entry.update', 'entry.post', 'entry.create', 'entry.post', 'entry.reverse'])
  })

  test('posting without a document needs a reason', async () => {
    const db = freshDb()
    const id = await createDraft(db, await input(db), 'josua')
    await expect(postEntry(db, id, 'josua')).rejects.toThrow('Begründung')
  })

  test('lists with filters and leaves discarded drafts out', async () => {
    const db = freshDb()
    const a = await createDraft(db, await input(db, { reason: 'x' }), 'josua')
    await postEntry(db, a, 'josua')
    const b = await createDraft(db, await input(db, { text: 'Tebex Auszahlung', line_category: '1', line_tax_0: 'ABROAD', line_gross: '286,40' }), 'josua')
    const c = await createDraft(db, await input(db, { text: 'Verworfen' }), 'josua')
    await discardDraft(db, c, 'josua')
    const all = await listEntries(db)
    expect(all.map(r => r.id).sort()).toEqual([a, b])
    expect((await listEntries(db, { status: 'draft' })).map(r => r.id)).toEqual([b])
    expect((await listEntries(db, { q: 'tebex' }))[0]?.total).toBe(28640)
  })
})

describe('months', () => {
  test('closing needs posted entries and matching or explained balances', async () => {
    const db = freshDb()
    const id = await createDraft(db, await input(db, { reason: 'x', paid_on: '2026-09-18' }), 'josua')
    await expect(closeMonth(db, '2026-09', { 1: -2499, 2: 0, 3: 0 }, '', 'josua')).rejects.toThrow('Entwürfe')
    await postEntry(db, id, 'josua')
    const summary = await monthSummary(db, '2026-09')
    expect(summary.balances.find(b => b.accountId === 1)?.booked).toBe(-2499)
    await expect(closeMonth(db, '2026-09', { 1: -2499 }, '', 'josua')).rejects.toThrow('Kontostand fehlt')
    await expect(closeMonth(db, '2026-09', { 1: -2000, 2: 0, 3: 0 }, '', 'josua')).rejects.toThrow('weichen ab')
    await closeMonth(db, '2026-09', { 1: -2499, 2: 0, 3: 0 }, '', 'josua')
    expect((await monthSummary(db, '2026-09')).locked?.by).toBe('josua')
    await expect(createDraft(db, await input(db, { paid_on: '2026-09-20' }), 'josua')).rejects.toThrow('abgeschlossen')
    await reverseEntry(db, id, 'Korrektur nach Abschluss', 'josua')
  })
})
