import { describe, expect, test } from 'bun:test'
import { freshDb } from './db'

async function draft(db: D1Database, paidOn = '2026-10-22'): Promise<number> {
  const row = await db.prepare(`INSERT INTO entries (paid_on, text, account_id, created_at, created_by)
    VALUES (?, 'Server', 1, '2026-10-22T09:00:00Z', 'test') RETURNING id`).bind(paidOn).first<{ id: number }>()
  await db.prepare(`INSERT INTO entry_lines (entry_id, category_id, tax_code, net, tax, gross) VALUES (?, 3, 'DE19', 2100, 399, 2499)`).bind(row!.id).run()
  return row!.id
}

async function post(db: D1Database, id: number, number = '2026-0001'): Promise<void> {
  await db.prepare(`UPDATE entries SET status = 'posted', number = ?, posted_at = '2026-10-22T10:00:00Z', posted_by = 'test' WHERE id = ?`).bind(number, id).run()
}

describe('schema guards', () => {
  test('a posted entry cannot be changed or deleted, not even by direct SQL', async () => {
    const db = freshDb()
    const id = await draft(db)
    await post(db, id)
    await expect(db.prepare(`UPDATE entries SET text = 'anders' WHERE id = ?`).bind(id).run()).rejects.toThrow('ändern sich nicht mehr')
    await expect(db.prepare('DELETE FROM entries WHERE id = ?').bind(id).run()).rejects.toThrow('nie gelöscht')
    await expect(db.prepare('UPDATE entry_lines SET gross = 1 WHERE entry_id = ?').bind(id).run()).rejects.toThrow()
    await expect(db.prepare('DELETE FROM entry_lines WHERE entry_id = ?').bind(id).run()).rejects.toThrow()
    await expect(db.prepare(`INSERT INTO entry_lines (entry_id, category_id, tax_code, net, tax, gross) VALUES (?, 3, 'DE19', 1, 0, 1)`).bind(id).run()).rejects.toThrow('nur an Entwürfen')
  })

  test('a draft stays editable, but even a draft is never deleted', async () => {
    const db = freshDb()
    const id = await draft(db)
    await db.prepare(`UPDATE entries SET text = 'Server Oktober' WHERE id = ?`).bind(id).run()
    await db.prepare('DELETE FROM entry_lines WHERE entry_id = ?').bind(id).run()
    await expect(db.prepare('DELETE FROM entries WHERE id = ?').bind(id).run()).rejects.toThrow('nie gelöscht')
  })

  test('posting needs at least one line and a number', async () => {
    const db = freshDb()
    const id = await draft(db)
    await db.prepare('DELETE FROM entry_lines WHERE entry_id = ?').bind(id).run()
    await expect(post(db, id)).rejects.toThrow('mindestens eine Position')
    const other = await draft(db)
    await expect(db.prepare(`UPDATE entries SET status = 'posted' WHERE id = ?`).bind(other).run()).rejects.toThrow()
  })

  test('documents are never deleted and only get a note', async () => {
    const db = freshDb()
    await db.prepare(`INSERT INTO documents (number, sha256, r2_key, filename, mime, size, kind, uploaded_at, uploaded_by)
      VALUES ('B-2026-0001', 'abc', 'belege/2026/abc', 'a.pdf', 'application/pdf', 10, 'invoice', '2026-10-22T09:00:00Z', 'test')`).run()
    await db.prepare(`UPDATE documents SET mistaken = 1, note = 'doppelt' WHERE number = 'B-2026-0001'`).run()
    await expect(db.prepare(`UPDATE documents SET mistaken = 0 WHERE number = 'B-2026-0001'`).run()).rejects.toThrow()
    await expect(db.prepare(`UPDATE documents SET filename = 'b.pdf' WHERE number = 'B-2026-0001'`).run()).rejects.toThrow()
    await expect(db.prepare(`DELETE FROM documents`).run()).rejects.toThrow('nie gelöscht')
  })

  test('a closed month takes no new entries except reversals, and stays closed', async () => {
    const db = freshDb()
    const id = await draft(db, '2026-09-30')
    await expect(db.prepare(`INSERT INTO periods (month, locked_at, locked_by) VALUES ('2026-09', 'x', 'test')`).run()).rejects.toThrow('noch Entwürfe')
    await post(db, id)
    await db.prepare(`INSERT INTO periods (month, locked_at, locked_by) VALUES ('2026-09', 'x', 'test')`).run()
    await expect(draft(db, '2026-09-15')).rejects.toThrow('abgeschlossen')
    const later = await draft(db, '2026-10-01')
    await expect(db.prepare(`UPDATE entries SET paid_on = '2026-09-02' WHERE id = ?`).bind(later).run()).rejects.toThrow('abgeschlossen')
    await db.prepare(`INSERT INTO entries (paid_on, text, account_id, reverses_id, reason, created_at, created_by)
      VALUES ('2026-09-30', 'Storno', 1, ?, 'falscher Betrag', 'x', 'test')`).bind(id).run()
    await expect(db.prepare(`UPDATE periods SET locked_at = NULL WHERE month = '2026-09'`).run()).rejects.toThrow('bleibt abgeschlossen')
  })

  test('an entry can be reversed only once', async () => {
    const db = freshDb()
    const id = await draft(db)
    await post(db, id)
    const insert = () => db.prepare(`INSERT INTO entries (paid_on, text, account_id, reverses_id, created_at, created_by) VALUES ('2026-10-22', 'Storno', 1, ?, 'x', 'test')`).bind(id).run()
    await insert()
    await expect(insert()).rejects.toThrow()
  })

  test('the audit log and filed returns are append-only', async () => {
    const db = freshDb()
    await db.prepare(`INSERT INTO audit_log (at, actor, action) VALUES ('x', 'test', 'a')`).run()
    await expect(db.prepare(`UPDATE audit_log SET action = 'b'`).run()).rejects.toThrow()
    await expect(db.prepare(`DELETE FROM audit_log`).run()).rejects.toThrow()
    await db.prepare(`INSERT INTO vat_filings (period, filed_at, filed_by, snapshot) VALUES ('2026-10', 'x', 'test', '{}')`).run()
    await expect(db.prepare(`DELETE FROM vat_filings`).run()).rejects.toThrow()
  })

  test('a category in use keeps its EÜR position', async () => {
    const db = freshDb()
    const id = await draft(db)
    await db.prepare(`UPDATE categories SET position = 'other' WHERE id = 3`).run()
    await db.prepare(`UPDATE categories SET position = 'edv' WHERE id = 3`).run()
    await post(db, id)
    await db.prepare(`UPDATE categories SET name = 'EDV' WHERE id = 3`).run()
    await expect(db.prepare(`UPDATE categories SET position = 'other' WHERE id = 3`).run()).rejects.toThrow('schon verwendet')
  })
})
