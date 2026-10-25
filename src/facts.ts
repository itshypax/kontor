import type { LineFact } from './types'

const SELECT = `SELECT e.id AS entryId, e.number, e.status, e.paid_on AS paidOn, e.invoice_date AS invoiceDate,
  COALESCE(e.fiscal_year, CAST(substr(e.paid_on, 1, 4) AS INTEGER)) AS fiscalYear, e.text, e.counterparty,
  c.id AS categoryId, c.name AS categoryName, c.kind, c.position, l.tax_code AS taxCode, l.net, l.tax, l.gross
  FROM entry_lines l JOIN entries e ON e.id = l.entry_id JOIN categories c ON c.id = l.category_id
  WHERE e.status <> 'discarded'`

/** All lines paid between two dates, plus those assigned to a fiscal year in that range. */
export async function loadFacts(db: D1Database, from: string, to: string): Promise<LineFact[]> {
  const { results } = await db.prepare(`${SELECT} AND ((e.paid_on BETWEEN ? AND ?) OR e.fiscal_year BETWEEN ? AND ?) ORDER BY e.paid_on, e.id, l.sort, l.id`)
    .bind(from, to, Number(from.slice(0, 4)), Number(to.slice(0, 4))).all<LineFact>()
  return results
}

export async function loadYearFacts(db: D1Database, year: number): Promise<LineFact[]> {
  return loadFacts(db, `${year - 1}-01-01`, `${year}-12-31`)
}
