-- Everything that has been posted is append-only. The triggers refuse to
-- change or delete it, so a bug in a route cannot rewrite the books. Drafts
-- stay editable until they are posted or discarded.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tax_regimes (
  id INTEGER PRIMARY KEY,
  valid_from TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('small_business', 'standard')),
  filing_period TEXT NOT NULL CHECK (filing_period IN ('month', 'quarter', 'none')),
  cash_basis INTEGER NOT NULL DEFAULT 1 CHECK (cash_basis IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TRIGGER tax_regimes_keep BEFORE DELETE ON tax_regimes
BEGIN SELECT RAISE(ABORT, 'Steuermodi werden nicht gelöscht, nur durch einen neuen ab einem Datum abgelöst.'); END;

CREATE TRIGGER tax_regimes_fixed BEFORE UPDATE ON tax_regimes
BEGIN SELECT RAISE(ABORT, 'Ein eingetragener Steuermodus ändert sich nicht mehr.'); END;

CREATE TABLE year_config (
  year INTEGER PRIMARY KEY,
  small_business_prev_limit INTEGER NOT NULL,
  small_business_limit INTEGER NOT NULL,
  gwg_limit INTEGER NOT NULL
);

-- Line numbers of the Anlage EÜR move every year, so they are data.
CREATE TABLE euer_lines (
  year INTEGER NOT NULL,
  position TEXT NOT NULL,
  line TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (year, position)
);

CREATE TABLE ustva_fields (
  year INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  tax_code TEXT NOT NULL,
  base_field TEXT NOT NULL DEFAULT '',
  tax_field TEXT NOT NULL DEFAULT '',
  input_tax_field TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (year, direction, tax_code)
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  reconcile INTEGER NOT NULL DEFAULT 1 CHECK (reconcile IN (0, 1)),
  opening_balance INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense', 'asset', 'tax_payment', 'tax_refund', 'private_in', 'private_out')),
  position TEXT NOT NULL,
  default_tax_code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'receipt', 'statement', 'einvoice', 'own', 'confirmation', 'other')),
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  mistaken INTEGER NOT NULL DEFAULT 0 CHECK (mistaken IN (0, 1)),
  note TEXT NOT NULL DEFAULT ''
);

CREATE TRIGGER documents_keep BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'Belege werden nie gelöscht.'); END;

CREATE TRIGGER documents_fixed BEFORE UPDATE ON documents
WHEN NEW.number IS NOT OLD.number OR NEW.sha256 IS NOT OLD.sha256 OR NEW.r2_key IS NOT OLD.r2_key
  OR NEW.filename IS NOT OLD.filename OR NEW.mime IS NOT OLD.mime OR NEW.size IS NOT OLD.size
  OR NEW.kind IS NOT OLD.kind OR NEW.uploaded_at IS NOT OLD.uploaded_at OR NEW.uploaded_by IS NOT OLD.uploaded_by
  OR (OLD.mistaken = 1 AND NEW.mistaken = 0)
BEGIN SELECT RAISE(ABORT, 'Ein Beleg bekommt höchstens einen Vermerk, sonst ändert sich nichts.'); END;

CREATE TABLE periods (
  month TEXT PRIMARY KEY,
  -- JSON: account id to the balance the bank showed at the end of the month
  balances TEXT NOT NULL DEFAULT '{}',
  locked_at TEXT,
  locked_by TEXT
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'discarded')),
  paid_on TEXT NOT NULL,
  invoice_date TEXT,
  fiscal_year INTEGER,
  text TEXT NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL DEFAULT 'EUR',
  original_amount INTEGER,
  reverses_id INTEGER UNIQUE REFERENCES entries(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  posted_at TEXT,
  posted_by TEXT,
  CHECK ((status = 'posted') = (number IS NOT NULL))
);

CREATE INDEX entries_paid_on ON entries(paid_on);
CREATE INDEX entries_status ON entries(status);

CREATE TABLE entry_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  tax_code TEXT NOT NULL,
  net INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  gross INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX entry_lines_entry ON entry_lines(entry_id);

CREATE TABLE entry_documents (
  entry_id INTEGER NOT NULL REFERENCES entries(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  PRIMARY KEY (entry_id, document_id)
);

CREATE INDEX entry_documents_document ON entry_documents(document_id);

CREATE TRIGGER entries_keep BEFORE DELETE ON entries
BEGIN SELECT RAISE(ABORT, 'Buchungen werden nie gelöscht.'); END;

CREATE TRIGGER entries_fixed BEFORE UPDATE ON entries
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene oder verworfene Buchungen ändern sich nicht mehr.'); END;

CREATE TRIGGER entries_post_needs_lines BEFORE UPDATE OF status ON entries
WHEN NEW.status = 'posted' AND NOT EXISTS (SELECT 1 FROM entry_lines WHERE entry_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Eine Buchung braucht mindestens eine Position.'); END;

-- A reversal keeps the payment date of what it reverses, even in a closed
-- month: that is the only way to correct a month after it was closed.
CREATE TRIGGER entries_closed_month_insert BEFORE INSERT ON entries
WHEN NEW.reverses_id IS NULL
  AND EXISTS (SELECT 1 FROM periods WHERE month = substr(NEW.paid_on, 1, 7) AND locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Dieser Monat ist abgeschlossen.'); END;

CREATE TRIGGER entries_closed_month_update BEFORE UPDATE OF paid_on ON entries
WHEN EXISTS (SELECT 1 FROM periods WHERE month = substr(NEW.paid_on, 1, 7) AND locked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Dieser Monat ist abgeschlossen.'); END;

CREATE TRIGGER entry_lines_insert BEFORE INSERT ON entry_lines
WHEN (SELECT status FROM entries WHERE id = NEW.entry_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'Positionen gibt es nur an Entwürfen.'); END;

CREATE TRIGGER entry_lines_update BEFORE UPDATE ON entry_lines
WHEN (SELECT status FROM entries WHERE id = OLD.entry_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'Positionen einer festgeschriebenen Buchung ändern sich nicht mehr.'); END;

CREATE TRIGGER entry_lines_delete BEFORE DELETE ON entry_lines
WHEN (SELECT status FROM entries WHERE id = OLD.entry_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'Positionen einer festgeschriebenen Buchung ändern sich nicht mehr.'); END;

CREATE TRIGGER entry_documents_delete BEFORE DELETE ON entry_documents
WHEN (SELECT status FROM entries WHERE id = OLD.entry_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'Belege einer festgeschriebenen Buchung bleiben verknüpft.'); END;

CREATE TRIGGER entry_documents_update BEFORE UPDATE ON entry_documents
BEGIN SELECT RAISE(ABORT, 'Verknüpfungen ändern sich nicht.'); END;

-- Moving a category to another EÜR position would silently move posted
-- amounts between lines of a year that may already be filed.
CREATE TRIGGER categories_fixed BEFORE UPDATE OF kind, position ON categories
WHEN (NEW.kind IS NOT OLD.kind OR NEW.position IS NOT OLD.position)
  AND EXISTS (SELECT 1 FROM entry_lines l JOIN entries e ON e.id = l.entry_id WHERE l.category_id = OLD.id AND e.status = 'posted')
BEGIN SELECT RAISE(ABORT, 'Die Kategorie wird schon verwendet. Lege für die neue Zuordnung eine neue Kategorie an.'); END;

CREATE TRIGGER categories_keep BEFORE DELETE ON categories
BEGIN SELECT RAISE(ABORT, 'Kategorien werden nicht gelöscht, nur deaktiviert.'); END;

CREATE TRIGGER accounts_keep BEFORE DELETE ON accounts
BEGIN SELECT RAISE(ABORT, 'Konten werden nicht gelöscht, nur deaktiviert.'); END;

CREATE TRIGGER periods_lock_insert BEFORE INSERT ON periods
WHEN NEW.locked_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM entries WHERE status = 'draft' AND substr(paid_on, 1, 7) = NEW.month)
BEGIN SELECT RAISE(ABORT, 'Im Monat liegen noch Entwürfe.'); END;

CREATE TRIGGER periods_lock_update BEFORE UPDATE ON periods
WHEN NEW.locked_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM entries WHERE status = 'draft' AND substr(paid_on, 1, 7) = NEW.month)
BEGIN SELECT RAISE(ABORT, 'Im Monat liegen noch Entwürfe.'); END;

CREATE TRIGGER periods_stay_locked BEFORE UPDATE ON periods
WHEN OLD.locked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Ein abgeschlossener Monat bleibt abgeschlossen.'); END;

CREATE TRIGGER periods_keep BEFORE DELETE ON periods
BEGIN SELECT RAISE(ABORT, 'Monate werden nicht gelöscht.'); END;

-- The snapshot is what was typed into ELSTER. Comparing it with the current
-- figures shows when a later reversal calls for a corrected return.
CREATE TABLE vat_filings (
  period TEXT PRIMARY KEY,
  filed_at TEXT NOT NULL,
  filed_by TEXT NOT NULL,
  document_id INTEGER REFERENCES documents(id),
  snapshot TEXT NOT NULL
);

CREATE TRIGGER vat_filings_keep BEFORE DELETE ON vat_filings
BEGIN SELECT RAISE(ABORT, 'Eine Voranmeldung bleibt als übermittelt vermerkt.'); END;

CREATE TRIGGER vat_filings_fixed BEFORE UPDATE ON vat_filings
BEGIN SELECT RAISE(ABORT, 'Eine Voranmeldung bleibt als übermittelt vermerkt.'); END;

CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  acquired_on TEXT NOT NULL,
  cost INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('gwg', 'linear', 'digital_one_year')),
  useful_life_months INTEGER NOT NULL DEFAULT 0,
  entry_id INTEGER REFERENCES entries(id),
  disposed_on TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER assets_keep BEFORE DELETE ON assets
BEGIN SELECT RAISE(ABORT, 'Anlagegüter werden nicht gelöscht. Ein Abgang wird mit Datum vermerkt.'); END;

CREATE TRIGGER assets_fixed BEFORE UPDATE ON assets
WHEN NEW.name IS NOT OLD.name OR NEW.acquired_on IS NOT OLD.acquired_on OR NEW.cost IS NOT OLD.cost
  OR NEW.method IS NOT OLD.method OR NEW.useful_life_months IS NOT OLD.useful_life_months
  OR NEW.entry_id IS NOT OLD.entry_id OR OLD.disposed_on IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'An einem Anlagegut lässt sich nur noch der Abgang eintragen.'); END;

CREATE TABLE procedure_docs (
  version INTEGER PRIMARY KEY,
  valid_from TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TRIGGER procedure_docs_keep BEFORE DELETE ON procedure_docs
BEGIN SELECT RAISE(ABORT, 'Frühere Fassungen der Verfahrensdokumentation bleiben erhalten.'); END;

CREATE TRIGGER procedure_docs_fixed BEFORE UPDATE ON procedure_docs
BEGIN SELECT RAISE(ABORT, 'Frühere Fassungen der Verfahrensdokumentation bleiben erhalten.'); END;

CREATE TABLE exports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pruefer', 'euer', 'ustva', 'backup')),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  -- NULL for full backups: they are handed out, not kept, since they repeat every document.
  r2_key TEXT UNIQUE,
  size INTEGER NOT NULL,
  filename TEXT NOT NULL
);

CREATE TRIGGER exports_keep BEFORE DELETE ON exports
BEGIN SELECT RAISE(ABORT, 'Exporte bleiben verzeichnet.'); END;

CREATE TRIGGER exports_fixed BEFORE UPDATE ON exports
BEGIN SELECT RAISE(ABORT, 'Exporte bleiben verzeichnet.'); END;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TRIGGER audit_log_keep BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'Das Protokoll wird nie gekürzt.'); END;

CREATE TRIGGER audit_log_fixed BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'Das Protokoll wird nie geändert.'); END;
