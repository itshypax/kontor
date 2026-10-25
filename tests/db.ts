import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A fresh in-memory database with all migrations applied. D1 is SQLite, so
 * bun:sqlite runs the same SQL and the same triggers.
 */
export function freshDb(): D1Database {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  const dir = join(import.meta.dir, '../migrations')
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    // Without trim() sqlite.exec swallows an error in the last statement
    // when a newline follows its semicolon.
    sqlite.exec(readFileSync(join(dir, file), 'utf8').trim())
  }
  return wrap(sqlite)
}

function wrap(sqlite: Database): D1Database {
  const statement = (sql: string, binds: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    first: async <T>(column?: string) => {
      const row = sqlite.query(sql).get(...(binds as never[])) as Record<string, unknown> | null
      if (row && column) return (row[column] ?? null) as T
      return (row as T | null) ?? null
    },
    all: async <T>() => ({ results: sqlite.query(sql).all(...(binds as never[])) as T[] }),
    raw: async <T>() => sqlite.query(sql).values(...(binds as never[])) as T[],
    run: async () => {
      const result = sqlite.query(sql).run(...(binds as never[]))
      return { success: true, meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } }
    }
  })

  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results = []
      sqlite.exec('BEGIN')
      try {
        for (const stmt of statements) results.push(await stmt.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    exec: async (sql: string) => { sqlite.exec(sql); return { count: 0, duration: 0 } }
  } as unknown as D1Database
}
