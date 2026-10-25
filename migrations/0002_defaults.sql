-- Defaults for a new installation. Limits, Kennzahlen and categories are a
-- starting point to be checked against the official forms and with a tax
-- advisor, not a statement of the law.

INSERT INTO settings (key, value) VALUES
  ('business_name', 'EmergencyForge'),
  ('owner', ''),
  ('address', ''),
  ('tax_number', ''),
  ('vat_id', ''),
  ('tax_office', ''),
  ('guard_counts_abroad', '1');

INSERT INTO tax_regimes (valid_from, mode, filing_period, cash_basis, created_at)
VALUES ('2026-01-01', 'small_business', 'none', 1, '2026-01-01T00:00:00Z');

INSERT INTO year_config (year, small_business_prev_limit, small_business_limit, gwg_limit) VALUES
  (2026, 2500000, 10000000, 80000),
  (2027, 2500000, 10000000, 80000);

INSERT INTO euer_lines (year, position, line)
SELECT y.year, p.position, ''
FROM (SELECT 2026 AS year UNION ALL SELECT 2027) y,
  (SELECT 'income_small_business' AS position UNION ALL SELECT 'income_small_business_not_taxable'
   UNION ALL SELECT 'income_taxable' UNION ALL SELECT 'income_tax_free' UNION ALL SELECT 'vat_received'
   UNION ALL SELECT 'vat_refund' UNION ALL SELECT 'afa' UNION ALL SELECT 'gwg' UNION ALL SELECT 'telecom'
   UNION ALL SELECT 'travel' UNION ALL SELECT 'training' UNION ALL SELECT 'advice' UNION ALL SELECT 'rent_movables'
   UNION ALL SELECT 'fees' UNION ALL SELECT 'edv' UNION ALL SELECT 'tools' UNION ALL SELECT 'advertising'
   UNION ALL SELECT 'other' UNION ALL SELECT 'input_tax_paid' UNION ALL SELECT 'vat_paid') p;

INSERT INTO ustva_fields (year, direction, tax_code, base_field, tax_field, input_tax_field)
SELECT y.year, f.direction, f.tax_code, f.base_field, f.tax_field, f.input_tax_field
FROM (SELECT 2026 AS year UNION ALL SELECT 2027) y,
  (SELECT 'income' AS direction, 'DE19' AS tax_code, '81' AS base_field, '' AS tax_field, '' AS input_tax_field
   UNION ALL SELECT 'income', 'DE7', '86', '', ''
   UNION ALL SELECT 'income', 'ABROAD', '45', '', ''
   UNION ALL SELECT 'expense', 'DE19', '', '', '66'
   UNION ALL SELECT 'expense', 'DE7', '', '', '66'
   UNION ALL SELECT 'expense', 'RC_EU', '46', '47', '67'
   UNION ALL SELECT 'expense', 'RC_OTHER', '52', '53', '67') f;

INSERT INTO accounts (name, reconcile, sort) VALUES
  ('Geschäftskonto', 1, 0),
  ('PayPal', 1, 1),
  ('Tebex-Guthaben', 1, 2),
  ('privat bezahlt', 0, 3);

INSERT INTO categories (name, kind, position, default_tax_code, sort) VALUES
  ('Erlöse Tebex', 'income', 'income', 'ABROAD', 0),
  ('Erlöse sonstige', 'income', 'income', 'DE19', 1),
  ('Laufende EDV-Kosten', 'expense', 'edv', 'DE19', 10),
  ('Werbekosten', 'expense', 'advertising', 'DE19', 11),
  ('Geringwertige Wirtschaftsgüter', 'expense', 'gwg', 'DE19', 12),
  ('Arbeitsmittel', 'expense', 'tools', 'DE19', 13),
  ('Telekommunikation', 'expense', 'telecom', 'DE19', 14),
  ('Fortbildung', 'expense', 'training', 'DE19', 15),
  ('Reisekosten', 'expense', 'travel', 'DE19', 16),
  ('Beiträge und Gebühren', 'expense', 'fees', 'NONE', 17),
  ('Steuerberatung', 'expense', 'advice', 'DE19', 18),
  ('Bankgebühren', 'expense', 'other', 'EXEMPT', 19),
  ('Übrige Betriebsausgaben', 'expense', 'other', 'DE19', 20),
  ('Anlagegut', 'asset', 'asset', 'DE19', 30),
  ('Umsatzsteuer an das Finanzamt', 'tax_payment', 'vat_paid', 'NONE', 40),
  ('Erstattung vom Finanzamt', 'tax_refund', 'vat_refund', 'NONE', 41),
  ('Privateinlage', 'private_in', 'private', 'NONE', 50),
  ('Privatentnahme', 'private_out', 'private', 'NONE', 51);

INSERT INTO procedure_docs (version, valid_from, text, created_at, created_by) VALUES (1, '2026-01-01',
'# Verfahrensdokumentation

Gilt für die Buchführung von [NAME DES UNTERNEHMENS], Inhaber [NAME], ab dem 01.01.2026.

## Aufgabe und Zuständigkeit

Gewinnermittlung durch Einnahmenüberschussrechnung nach § 4 Abs. 3 EStG. Belege erfassen, buchen, festschreiben und archivieren macht der Inhaber selbst.

## System

Die Buchführung läuft in Kontor, einer eigenen Anwendung auf Cloudflare (Worker, Datenbank D1, Dateispeicher R2). Zugang nur über Cloudflare Access mit der Adresse des Inhabers. Jede Änderung steht mit Zeitpunkt und Person im Änderungsprotokoll.

## Belege

Papierbelege werden fotografiert, digitale Belege im Original hochgeladen, E-Rechnungen als XML. Beim Hochladen bekommt jeder Beleg eine fortlaufende Nummer und eine SHA-256-Prüfsumme. Der Dateispeicher verhindert Löschen und Überschreiben für 4.020 Tage. Papierbelege werden nach dem Fotografieren [AUFBEWAHRT / VERNICHTET].

## Buchen

Jede Zahlung wird zeitnah erfasst, spätestens zehn Tage nach Eingang oder Ausgang. Maßgeblich ist das Zahlungsdatum. Eine Buchung beginnt als Entwurf und wird festgeschrieben, spätestens bis Ende des Folgemonats oder vor der Voranmeldung. Festgeschriebene Buchungen ändern sich nicht mehr. Fehler werden durch Storno mit Begründung und eine neue Buchung korrigiert.

## Monatsabschluss

Der Kontostand laut Bank wird mit dem Stand in Kontor abgeglichen. Danach wird der Monat gesperrt.

## Aufbewahrung und Sicherung

Buchungsbelege acht Jahre, Aufzeichnungen zehn Jahre, jeweils ab Ende des Kalenderjahres. Jede Nacht wird die Datenbank in den Dateispeicher gesichert. Einmal im Monat lädt der Inhaber eine Gesamtsicherung herunter und legt sie außerhalb von Cloudflare ab.

## Datenzugriff

Für eine Außenprüfung erzeugt Kontor ein Prüfer-Paket: alle Buchungen als CSV mit Beschreibung nach dem Beschreibungsstandard der Finanzverwaltung, alle Belege und eine Prüfsumme je Datei. Auf Wunsch bekommt ein Prüfer einen Lesezugang.
', '2026-01-01T00:00:00Z', 'system');
