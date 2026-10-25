import { zipSync, type Zippable } from 'fflate'
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib'
import { depreciation, loadAssets, METHOD_LABELS } from './afa'
import { audit } from './audit'
import { KIND_LABELS, loadSettings } from './catalog'
import { computeEuer, POSITIONS, positionLabel } from './euer'
import { loadYearFacts } from './facts'
import { HttpError } from './http'
import { formatCents, plainCents } from './money'
import { loadRegimes, modeLabel, regimeAt } from './regime'
import { TAX_CODES } from './tax'
import { formatDate, formatDateTime, isoSeconds, todayBerlin } from './time'
import type { Env, TaxCode } from './types'

const MAX_PACKAGE = 90 * 1048576

type Column = { name: string; type: 'text' | 'number' | 'amount' | 'date' }
type Table = { file: string; name: string; description: string; key: string; columns: Column[]; rows: unknown[][]; refs?: Array<[string, string]> }

function csvValue(value: unknown, type: Column['type']): string {
  if (value === null || value === undefined || value === '') return ''
  if (type === 'amount') return plainCents(Number(value))
  if (type === 'number') return String(value)
  if (type === 'date') return formatDate(String(value))
  return '"' + String(value).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"'
}

function csv(table: Table): Uint8Array {
  const lines = [table.columns.map(c => `"${c.name}"`).join(';'), ...table.rows.map(row => row.map((v, i) => csvValue(v, table.columns[i]!.type)).join(';'))]
  return new TextEncoder().encode(lines.join('\r\n') + '\r\n')
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Description of all tables after the Beschreibungsstandard of the tax administration (GDPdU). */
export function indexXml(tables: Table[], supplier: { name: string; location: string }, from: string, to: string): string {
  const column = (c: Column) => {
    const type = c.type === 'amount' ? '<Numeric><Accuracy>2</Accuracy></Numeric>' : c.type === 'number' ? '<Numeric/>' : c.type === 'date' ? '<Date><Format>DD.MM.YYYY</Format></Date>' : '<AlphaNumeric/>'
    return `<Name>${xml(c.name)}</Name>${type}`
  }
  const tableXml = (t: Table) => {
    const key = t.columns.find(c => c.name === t.key)!
    return `    <Table>
      <URL>${xml(t.file)}</URL>
      <Name>${xml(t.name)}</Name>
      <Description>${xml(t.description)}</Description>
      <Validity><Range><From>${formatDate(from)}</From><To>${formatDate(to)}</To></Range><Format>DD.MM.YYYY</Format></Validity>
      <UTF8/>
      <DecimalSymbol>,</DecimalSymbol>
      <DigitGroupingSymbol>.</DigitGroupingSymbol>
      <Range><From>2</From></Range>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter>
        <RecordDelimiter>&#13;&#10;</RecordDelimiter>
        <TextEncapsulator>"</TextEncapsulator>
        <VariablePrimaryKey>${column(key)}</VariablePrimaryKey>
${t.columns.filter(c => c !== key).map(c => `        <VariableColumn>${column(c)}</VariableColumn>`).join('\n')}
${(t.refs ?? []).map(([col, ref]) => `        <ForeignKey><Name>${xml(col)}</Name><References>${xml(ref)}</References></ForeignKey>`).join('\n')}
      </VariableLength>
    </Table>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier>
    <Name>${xml(supplier.name)}</Name>
    <Location>${xml(supplier.location)}</Location>
    <Comment>Export aus Kontor für den Zeitraum ${formatDate(from)} bis ${formatDate(to)}. Beträge in Euro.</Comment>
  </DataSupplier>
  <Media>
    <Name>Prüfer-Paket ${formatDate(from)} bis ${formatDate(to)}</Name>
${tables.map(tableXml).join('\n')}
  </Media>
</DataSet>
`
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
}

export type PackageOptions = { from: string; to: string; documents: boolean; log: boolean; procedure: boolean }

/** All tables of a period as CSV plus the documents, described by index.xml and covered by checksums. */
export async function buildPackage(env: Env, opts: PackageOptions): Promise<{ zip: Uint8Array; files: number; documents: number }> {
  const db = env.DB
  const { from, to } = opts
  const all = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all<T>()).results
  const entries = await all<Record<string, unknown>>(`SELECT e.*, a.name AS account_name, r.number AS reverses_number FROM entries e JOIN accounts a ON a.id = e.account_id
    LEFT JOIN entries r ON r.id = e.reverses_id WHERE e.paid_on BETWEEN ? AND ? ORDER BY e.paid_on, e.id`, from, to)
  const lines = await all<Record<string, unknown>>(`SELECT l.*, e.number, c.name AS category, c.kind, c.position FROM entry_lines l JOIN entries e ON e.id = l.entry_id JOIN categories c ON c.id = l.category_id
    WHERE e.paid_on BETWEEN ? AND ? ORDER BY e.paid_on, e.id, l.sort, l.id`, from, to)
  const docs = await all<Record<string, unknown>>(`SELECT d.*, (SELECT group_concat(COALESCE(e.number, 'Entwurf ' || e.id)) FROM entry_documents ed JOIN entries e ON e.id = ed.entry_id WHERE ed.document_id = d.id) AS entries
    FROM documents d WHERE substr(d.uploaded_at, 1, 10) BETWEEN ?1 AND ?2
    OR EXISTS (SELECT 1 FROM entry_documents ed JOIN entries e ON e.id = ed.entry_id WHERE ed.document_id = d.id AND e.paid_on BETWEEN ?1 AND ?2) ORDER BY d.id`, from, to)
  const links = await all<Record<string, unknown>>(`SELECT ed.entry_id, ed.document_id FROM entry_documents ed JOIN entries e ON e.id = ed.entry_id WHERE e.paid_on BETWEEN ? AND ? ORDER BY ed.entry_id, ed.document_id`, from, to)
  const accounts = await all<Record<string, unknown>>('SELECT * FROM accounts ORDER BY id')
  const categories = await all<Record<string, unknown>>('SELECT * FROM categories ORDER BY id')
  const assets = await all<Record<string, unknown>>('SELECT a.*, e.number FROM assets a LEFT JOIN entries e ON e.id = a.entry_id ORDER BY a.id')
  const regimes = await all<Record<string, unknown>>('SELECT * FROM tax_regimes ORDER BY valid_from')
  const filings = await all<Record<string, unknown>>('SELECT * FROM vat_filings ORDER BY period')
  const docPath = (d: Record<string, unknown>) => `belege/${d.number}_${safeName(String(d.filename))}`

  const tables: Table[] = [
    { file: 'buchungen.csv', name: 'Buchungen', description: 'Alle Buchungen des Zeitraums nach Zahlungsdatum, mit Status. Festgeschriebene Buchungen sind unveränderlich, Korrekturen sind Stornobuchungen.', key: 'id',
      columns: [['id', 'number'], ['nummer', 'text'], ['status', 'text'], ['zahlungsdatum', 'date'], ['rechnungsdatum', 'date'], ['wirtschaftsjahr', 'number'], ['text', 'text'], ['gegenpartei', 'text'], ['konto', 'text'], ['waehrung', 'text'], ['originalbetrag', 'amount'], ['storno_zu', 'text'], ['begruendung', 'text'], ['angelegt_am', 'text'], ['angelegt_von', 'text'], ['festgeschrieben_am', 'text'], ['festgeschrieben_von', 'text']].map(([name, type]) => ({ name: name!, type: type as Column['type'] })),
      rows: entries.map(e => [e.id, e.number, { draft: 'Entwurf', posted: 'festgeschrieben', discarded: 'verworfen' }[String(e.status)], e.paid_on, e.invoice_date, e.fiscal_year, e.text, e.counterparty, e.account_name, e.currency, e.original_amount, e.reverses_number, e.reason, e.created_at, e.created_by, e.posted_at, e.posted_by]) },
    { file: 'positionen.csv', name: 'Positionen', description: 'Positionen der Buchungen mit Kategorie, Steuerschlüssel, Netto, Steuer und Zahlbetrag. Bei Reverse Charge ist Steuer die geschuldete Steuer, nicht Teil des Zahlbetrags.', key: 'id',
      columns: [['id', 'number'], ['buchung_id', 'number'], ['buchungsnummer', 'text'], ['kategorie', 'text'], ['art', 'text'], ['euer_position', 'text'], ['steuerschluessel', 'text'], ['netto', 'amount'], ['steuer', 'amount'], ['zahlbetrag', 'amount']].map(([name, type]) => ({ name: name!, type: type as Column['type'] })),
      rows: lines.map(l => [l.id, l.entry_id, l.number, l.category, KIND_LABELS[l.kind as keyof typeof KIND_LABELS], l.kind === 'expense' ? positionLabel(String(l.position)) : '', TAX_CODES[l.tax_code as TaxCode]?.label ?? l.tax_code, l.net, l.tax, l.gross]),
      refs: [['buchung_id', 'Buchungen']] },
    { file: 'belege.csv', name: 'Belege', description: 'Alle Belege des Zeitraums mit Prüfsumme. Die Datei liegt im Paket unter dem angegebenen Pfad.', key: 'id',
      columns: [['id', 'number'], ['belegnummer', 'text'], ['dateiname', 'text'], ['datei_im_paket', 'text'], ['typ', 'text'], ['groesse_bytes', 'number'], ['sha256', 'text'], ['art', 'text'], ['hochgeladen_am', 'text'], ['hochgeladen_von', 'text'], ['vermerk', 'text'], ['buchungen', 'text']].map(([name, type]) => ({ name: name!, type: type as Column['type'] })),
      rows: docs.map(d => [d.id, d.number, d.filename, opts.documents ? docPath(d) : '', d.mime, d.size, d.sha256, d.kind, d.uploaded_at, d.uploaded_by, d.mistaken ? d.note : '', d.entries]) },
    { file: 'buchung_belege.csv', name: 'BuchungBelege', description: 'Zuordnung von Belegen zu Buchungen.', key: 'buchung_id',
      columns: [{ name: 'buchung_id', type: 'number' }, { name: 'beleg_id', type: 'number' }], rows: links.map(l => [l.entry_id, l.document_id]), refs: [['buchung_id', 'Buchungen'], ['beleg_id', 'Belege']] },
    { file: 'konten.csv', name: 'Konten', description: 'Zahlungswege mit Anfangsbestand.', key: 'id',
      columns: [{ name: 'id', type: 'number' }, { name: 'name', type: 'text' }, { name: 'abgleich', type: 'text' }, { name: 'anfangsbestand', type: 'amount' }, { name: 'aktiv', type: 'text' }],
      rows: accounts.map(a => [a.id, a.name, a.reconcile ? 'ja' : 'nein', a.opening_balance, a.active ? 'ja' : 'nein']) },
    { file: 'kategorien.csv', name: 'Kategorien', description: 'Kategorien mit Art und Position in der Anlage EÜR.', key: 'id',
      columns: [{ name: 'id', type: 'number' }, { name: 'name', type: 'text' }, { name: 'art', type: 'text' }, { name: 'euer_position', type: 'text' }, { name: 'steuerschluessel', type: 'text' }, { name: 'aktiv', type: 'text' }],
      rows: categories.map(c => [c.id, c.name, KIND_LABELS[c.kind as keyof typeof KIND_LABELS], c.kind === 'expense' ? positionLabel(String(c.position)) : '', c.default_tax_code, c.active ? 'ja' : 'nein']) },
    { file: 'anlagen.csv', name: 'Anlagen', description: 'Anlagenverzeichnis.', key: 'id',
      columns: [{ name: 'id', type: 'number' }, { name: 'bezeichnung', type: 'text' }, { name: 'angeschafft_am', type: 'date' }, { name: 'kosten', type: 'amount' }, { name: 'methode', type: 'text' }, { name: 'nutzungsdauer_monate', type: 'number' }, { name: 'buchungsnummer', type: 'text' }, { name: 'abgang_am', type: 'date' }],
      rows: assets.map(a => [a.id, a.name, a.acquired_on, a.cost, METHOD_LABELS[a.method as keyof typeof METHOD_LABELS], a.useful_life_months, a.number, a.disposed_on]) },
    { file: 'steuermodi.csv', name: 'Steuermodi', description: 'Umsatzsteuerliche Behandlung ab dem jeweiligen Datum.', key: 'gueltig_ab',
      columns: [{ name: 'gueltig_ab', type: 'date' }, { name: 'modus', type: 'text' }, { name: 'voranmeldung', type: 'text' }, { name: 'ist_versteuerung', type: 'text' }],
      rows: regimes.map(r => [r.valid_from, r.mode === 'small_business' ? 'Kleinunternehmer § 19 UStG' : 'Regelbesteuerung', r.filing_period, r.cash_basis ? 'ja' : 'nein']) },
    { file: 'voranmeldungen.csv', name: 'Voranmeldungen', description: 'Als übermittelt vermerkte Voranmeldungen mit den damals eingetragenen Kennzahlen in Cent.', key: 'zeitraum',
      columns: [{ name: 'zeitraum', type: 'text' }, { name: 'uebermittelt_am', type: 'text' }, { name: 'von', type: 'text' }, { name: 'kennzahlen', type: 'text' }],
      rows: filings.map(f => [f.period, f.filed_at, f.filed_by, f.snapshot]) }
  ]
  if (opts.log) {
    const log = await all<Record<string, unknown>>('SELECT * FROM audit_log WHERE substr(at, 1, 10) BETWEEN ? AND ? ORDER BY id', from, to)
    tables.push({ file: 'protokoll.csv', name: 'Protokoll', description: 'Änderungsprotokoll des Zeitraums.', key: 'id',
      columns: [{ name: 'id', type: 'number' }, { name: 'zeitpunkt', type: 'text' }, { name: 'person', type: 'text' }, { name: 'aktion', type: 'text' }, { name: 'betrifft', type: 'text' }, { name: 'details', type: 'text' }],
      rows: log.map(l => [l.id, l.at, l.actor, l.action, l.subject, l.detail]) })
  }

  const settings = await loadSettings(db)
  const files: Record<string, Uint8Array> = {}
  for (const table of tables) files[table.file] = csv(table)
  files['index.xml'] = new TextEncoder().encode(indexXml(tables, { name: settings.business_name || 'EmergencyForge', location: settings.address || '' }, from, to))
  if (opts.procedure) {
    const versions = await all<{ version: number; valid_from: string; text: string }>('SELECT version, valid_from, text FROM procedure_docs ORDER BY version')
    for (const v of versions) files[`verfahrensdokumentation/fassung-${v.version}.md`] = new TextEncoder().encode(`<!-- Fassung ${v.version}, gültig ab ${formatDate(v.valid_from)} -->\n\n${v.text}`)
  }
  let size = Object.values(files).reduce((s, f) => s + f.byteLength, 0)
  let documents = 0
  if (opts.documents) {
    for (const d of docs) {
      size += Number(d.size)
      if (size > MAX_PACKAGE) throw new HttpError(413, 'Das Paket würde zu groß. Bitte einen kürzeren Zeitraum wählen.')
      const object = await env.FILES.get(String(d.r2_key))
      if (!object) throw new HttpError(500, `Die Datei zu ${d.number} fehlt im Speicher.`)
      files[docPath(d)] = new Uint8Array(await object.arrayBuffer())
      documents++
    }
  }
  const sums: string[] = []
  for (const [path, bytes] of Object.entries(files)) sums.push(`${await sha256Hex(bytes)}  ${path}`)
  files['pruefsummen.txt'] = new TextEncoder().encode(sums.join('\n') + '\n')
  const zippable: Zippable = {}
  for (const [path, bytes] of Object.entries(files)) zippable[path] = path.startsWith('belege/') ? [bytes, { level: 0 }] : bytes
  return { zip: zipSync(zippable, { level: 6, mtime: new Date() }), files: Object.keys(files).length, documents }
}

/** Keeps a copy of what was handed out, under the same lock as the documents. */
export async function archiveExport(env: Env, kind: 'pruefer' | 'euer' | 'ustva' | 'backup', label: string, filename: string, bytes: Uint8Array, actor: string, keep = true): Promise<string> {
  const sha = await sha256Hex(bytes)
  const key = keep ? `exporte/${todayBerlin().slice(0, 4)}/${isoSeconds().replace(/[:]/g, '')}-${sha.slice(0, 12)}-${filename}` : null
  if (key) await env.FILES.put(key, bytes, { httpMetadata: { contentType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/zip' }, sha256: sha })
  await env.DB.batch([
    env.DB.prepare('INSERT INTO exports (kind, label, created_at, created_by, sha256, r2_key, size, filename) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(kind, label, isoSeconds(), actor, sha, key, bytes.byteLength, filename),
    audit(env.DB, actor, 'export.create', `export:${kind}`, { label, sha256: sha, size: bytes.byteLength })
  ])
  return sha
}

/**
 * Every table as INSERT statements. Restoring means: apply the migrations to
 * an empty database, then run this file. Entries go in as drafts and are
 * posted after their lines, because the guards only accept lines on drafts.
 */
export async function sqlDump(db: D1Database): Promise<string> {
  const quote = (v: unknown) => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
  const out = [`-- Kontor, Sicherung vom ${isoSeconds()}`, '-- Wiederherstellen: Migrationen auf eine leere Datenbank anwenden, dann diese Datei einspielen.', '']
  const rows = async (table: string) => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>()).results
  const insert = (table: string, row: Record<string, unknown>, verb = 'INSERT') => `${verb} INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(quote).join(', ')});`
  // The defaults the migrations put in are overwritten by what was saved.
  // REPLACE does not fire the delete guards while recursive triggers are off.
  for (const table of ['settings', 'tax_regimes', 'year_config', 'euer_lines', 'ustva_fields', 'accounts', 'categories', 'procedure_docs']) {
    for (const row of await rows(table)) out.push(insert(table, row, 'INSERT OR REPLACE'))
  }
  for (const row of await rows('documents')) out.push(insert('documents', row))
  const entries = await rows('entries')
  for (const row of entries) out.push(insert('entries', { ...row, status: 'draft', number: null, posted_at: null, posted_by: null }))
  for (const table of ['entry_lines', 'entry_documents']) for (const row of await rows(table)) out.push(insert(table, row))
  for (const row of entries) {
    if (row.status === 'draft') continue
    out.push(`UPDATE entries SET status = ${quote(row.status)}, number = ${quote(row.number)}, posted_at = ${quote(row.posted_at)}, posted_by = ${quote(row.posted_by)} WHERE id = ${quote(row.id)};`)
  }
  for (const table of ['periods', 'vat_filings', 'assets', 'exports', 'audit_log']) for (const row of await rows(table)) out.push(insert(table, row))
  return out.join('\n') + '\n'
}

export async function nightlyBackup(env: Env, now = new Date()): Promise<void> {
  const dump = await sqlDump(env.DB)
  await env.FILES.put(`sicherungen/${todayBerlin(now)}.sql`, dump, { httpMetadata: { contentType: 'application/sql' } })
}

export async function lastBackup(env: Env): Promise<string | null> {
  const list = await env.FILES.list({ prefix: 'sicherungen/' })
  const keys = list.objects.map(o => o.key).sort()
  return keys.at(-1)?.slice('sicherungen/'.length, -4) ?? null
}

const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')
function pdfText(value: string): string {
  return [...value.replace(/−/g, '-')].map(ch => (ch.charCodeAt(0) < 256 || WINANSI_EXTRA.has(ch) ? ch : '?')).join('')
}

/** The EÜR of a year as a PDF to type into Mein ELSTER, with categories and the asset register. */
export async function euerPdf(db: D1Database, year: number): Promise<Uint8Array> {
  const [facts, regimes, assets, settings, linesRes] = await Promise.all([loadYearFacts(db, year), loadRegimes(db), loadAssets(db), loadSettings(db), db.prepare('SELECT position, line FROM euer_lines WHERE year = ?').bind(year).all<{ position: string; line: string }>()])
  const afa = assets.reduce((s, a) => s + depreciation(a, year).afa, 0)
  const euer = computeEuer(year, facts, regimes, afa)
  const lineNo = new Map(linesRes.results.map(l => [l.position, l.line]))
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Einnahmenüberschussrechnung ${year}`)
  pdf.setCreator('Kontor')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let pageRef: PDFPage = pdf.addPage([595.28, 841.89])
  let y = 790
  const left = 56
  const right = 539
  const write = (text: string, x: number, opts: { size?: number; f?: PDFFont; color?: [number, number, number]; align?: 'right' } = {}) => {
    const size = opts.size ?? 10
    const f = opts.f ?? font
    const t = pdfText(text)
    const px = opts.align === 'right' ? x - f.widthOfTextAtSize(t, size) : x
    pageRef.drawText(t, { x: px, y, size, font: f, color: rgb(...(opts.color ?? [0.07, 0.07, 0.08])) })
  }
  const next = (gap = 16) => {
    y -= gap
    if (y < 60) { pageRef = pdf.addPage([595.28, 841.89]); y = 790 }
  }
  const rule = () => { pageRef.drawLine({ start: { x: left, y: y + 5 }, end: { x: right, y: y + 5 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.72) }) }

  write(`Einnahmenüberschussrechnung ${year}`, left, { size: 18, f: bold }); next(22)
  write([settings.business_name, settings.owner].filter(Boolean).join(', '), left); next(14)
  write([settings.tax_number ? `Steuernummer ${settings.tax_number}` : '', settings.tax_office].filter(Boolean).join(' · ') || 'Steuernummer und Finanzamt in den Einstellungen eintragen', left, { color: [0.4, 0.4, 0.45] }); next(14)
  write(`${modeLabel(regimeAt(regimes, `${year}-12-31`))} · erstellt am ${formatDateTime(isoSeconds())}`, left, { color: [0.4, 0.4, 0.45] }); next(14)
  if (euer.drafts) { write(`Achtung: enthält ${euer.drafts} nicht festgeschriebene Entwürfe.`, left, { f: bold, color: [0.76, 0.23, 0] }); next(14) }
  next(10)
  const section = (title: string) => { write(title.toUpperCase(), left, { size: 9, f: bold, color: [0.4, 0.4, 0.45] }); next(16) }
  const row = (key: string, label: string, sub = false) => {
    const value = euer.totals.get(key) ?? 0
    if (!value && sub) return
    write(lineNo.get(key) || '[Zeile]', left, { color: [0.45, 0.45, 0.5] })
    write(label, left + (sub ? 70 : 56))
    write(formatCents(value), right, { align: 'right' })
    next()
  }
  section('Betriebseinnahmen')
  for (const p of POSITIONS.filter(p => p.side === 'income' && (euer.totals.get(p.key) ?? 0) !== 0)) row(p.key, p.label, p.sub)
  rule(); write('Summe Betriebseinnahmen', left + 56, { f: bold }); write(formatCents(euer.income), right, { align: 'right', f: bold }); next(26)
  section('Betriebsausgaben')
  for (const p of POSITIONS.filter(p => p.side === 'expense' && (euer.totals.get(p.key) ?? 0) !== 0)) row(p.key, p.label)
  rule(); write('Summe Betriebsausgaben', left + 56, { f: bold }); write(formatCents(euer.expense), right, { align: 'right', f: bold }); next(26)
  rule(); write('Gewinn', left + 56, { size: 13, f: bold }); write(formatCents(euer.profit), right, { size: 13, f: bold, align: 'right' }); next(34)

  section('Nach Kategorien')
  const byCategory = new Map<string, number>()
  for (const l of facts) if (l.fiscalYear === year) byCategory.set(l.categoryName, (byCategory.get(l.categoryName) ?? 0) + l.gross)
  for (const [name, value] of byCategory) { write(name, left + 56); write(formatCents(value), right, { align: 'right' }); next(14) }
  next(20)
  if (assets.length) {
    section('Anlagenverzeichnis')
    for (const a of assets) {
      const d = depreciation(a, year)
      write(`${a.name}, angeschafft ${formatDate(a.acquiredOn)}, ${METHOD_LABELS[a.method]}`, left + 56)
      write(`AfA ${formatCents(d.afa)} · Rest ${formatCents(d.bookValueEnd)}`, right, { align: 'right' })
      next(14)
    }
    next(20)
  }
  write('Zeilennummern laut Jahrestabelle in Kontor. Vor der Übertragung mit dem amtlichen Vordruck abgleichen.', left, { size: 8, color: [0.45, 0.45, 0.5] })
  return pdf.save()
}
