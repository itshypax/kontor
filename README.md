# Kontor

Buchhaltung für EmergencyForge als Einzelunternehmen: Belege, Einnahmen und Ausgaben, Einnahmenüberschussrechnung, Umsatzsteuer-Voranmeldung und Exporte für Finanzamt, Prüfer oder Steuerberater. Ein Cloudflare Worker mit D1 für die Buchungen und R2 für die Belege, hinter Cloudflare Access.

Noch nicht ausgerollt. Wie das beim ersten Mal geht, steht unten.

## Lokal entwickeln

Voraussetzung: Bun 1.4 oder neuer.

```sh
bun install
bun test
bun run typecheck
bun run preview
```

Die Vorschau läuft unter `http://127.0.0.1:8789` mit dem echten Worker, einer Datenbank im Arbeitsspeicher und einem signierten Testnutzer. Sie startet mit Beispieldaten von Januar bis Oktober 2026. `POST /__fixtures/reset?scenario=empty` setzt sie auf einen leeren Stand zurück. Nach Codeänderungen den Server neu starten.

## Was es kann

- Belege hochladen (Foto, PDF, E-Rechnung als XML, CSV). Jeder Beleg bekommt eine fortlaufende Nummer `B-2026-0001` und wird unter seiner SHA-256-Prüfsumme abgelegt. Dieselbe Datei zweimal hochzuladen findet die vorhandene.
- Buchungen mit mehreren Positionen, Kategorie und Steuerschlüssel. Netto, Steuer und der Hinweis, was die Position in EÜR und Voranmeldung bewirkt, rechnet das Formular live mit derselben Logik wie beim Speichern.
- Entwurf, Festschreiben mit lückenloser Nummer je Jahr, Storno mit Begründung. Festgeschriebenes ändert sich nie mehr.
- Monatsabschluss mit Kontoabgleich. Ein abgeschlossener Monat nimmt nur noch Stornos an.
- Beide Umsatzsteuer-Modi: Kleinunternehmer nach § 19 UStG und Regelbesteuerung, jeweils ab einem Datum. Reverse Charge nach § 13b wird auch für Kleinunternehmer erkannt.
- Kleinunternehmer-Wächter mit Hochrechnung. Er nennt die Buchung, mit der die Grenze für das laufende Jahr überschritten wurde.
- EÜR nach den Positionen der Anlage EÜR, Voranmeldung mit Kennzahlen. Eine übermittelte Voranmeldung wird mit ihren Kennzahlen festgehalten. Ändert sich der Zeitraum danach, zeigt Kontor, dass eine Berichtigung fällig ist.
- Anlagenverzeichnis mit linearer Abschreibung, Computer und Software in einem Jahr, GWG nur als Verzeichnis.
- Exporte: Prüfer-Paket, EÜR als PDF, Gesamtsicherung. Dazu jede Nacht ein SQL-Dump nach R2.
- Rollen über `ACCESS_ROLES`: `admin` darf alles, `reader` sieht alles und darf exportieren.

## Schutz der Daten

Die Regeln stehen in der Datenbank selbst, nicht nur im Code. Trigger in `migrations/0001_init.sql` verhindern, dass festgeschriebene Buchungen, ihre Positionen und Belegverknüpfungen geändert werden, und dass Buchungen, Belege, übermittelte Voranmeldungen oder das Protokoll gelöscht werden. Ein Fehler in einer Route reicht deshalb nicht, um die Bücher umzuschreiben. Die Tests in `tests/schema.test.ts` prüfen das mit direktem SQL.

Jede Änderung schreibt im selben Batch eine Zeile ins Protokoll. Belege und Exporte liegen in R2 unter `belege/` und `exporte/` und werden dort per Bucket Lock gegen Löschen und Überschreiben gesperrt (siehe Ausrollen).

Hochgeladene Dateien werden nach ihrer Endung typisiert, nie nach der Angabe des Browsers, und mit `content-security-policy: sandbox` ausgeliefert. HTML und SVG werden abgelehnt.

## Werte, die sich jedes Jahr ändern

Grenzen, Zeilennummern der Anlage EÜR und Kennzahlen der Voranmeldung stehen in den Tabellen `year_config`, `euer_lines` und `ustva_fields` und lassen sich unter Einstellungen pflegen. Die Zeilennummern sind anfangs leer und erscheinen als `[Zeile]`. Die Kennzahlen (45, 46, 47, 52, 53, 66, 67, 81, 86) sind ein Startwert und müssen gegen den amtlichen Vordruck des Jahres geprüft werden, ebenso die Grenzen. Für ein neues Jahr übernimmt "Aus dem Vorjahr übernehmen" die Werte.

## Exporte

Das Prüfer-Paket ist ein ZIP mit allen Tabellen des Zeitraums als CSV (UTF-8, Semikolon, Dezimalkomma, Kopfzeile), einer `index.xml` nach dem Beschreibungsstandard der Finanzverwaltung (`gdpdu-01-09-2004.dtd`, nicht beigelegt), den Belegdateien, allen Fassungen der Verfahrensdokumentation und `pruefsummen.txt` mit SHA-256 je Datei. Das Paket wird im Arbeitsspeicher gebaut, deshalb ist bei etwa 90 MB Schluss. Für längere Zeiträume mehrere Pakete erzeugen.

Jeder Export wird mit Prüfsumme in der Tabelle `exports` verzeichnet. Prüfer-Paket und PDF liegen zusätzlich unter `exporte/` in R2. Die Gesamtsicherung wird nur ausgeliefert, nicht gespeichert, weil sie jeden Beleg noch einmal enthält.

## Sicherung und Wiederherstellung

Jede Nacht um 02:17 UTC schreibt der Worker `sicherungen/JJJJ-MM-TT.sql` nach R2. Die Gesamtsicherung unter Export enthält `daten.zip` (das Prüfer-Paket über alle Jahre) und `kontor.sql`. Sie gehört einmal im Monat außerhalb von Cloudflare abgelegt.

Wiederherstellen: eine leere D1-Datenbank anlegen, die Migrationen anwenden, dann `kontor.sql` einspielen. Buchungen entstehen dabei erst als Entwurf und werden nach ihren Positionen festgeschrieben, so lassen die Trigger das Einspielen zu. Die Belegdateien kommen aus `daten.zip/belege/` zurück nach R2 unter ihrem Schlüssel aus der Spalte `r2_key`.

## Ausrollen

Beim ersten Mal:

1. `bunx wrangler d1 create kontor` und die ausgegebene `database_id` in `wrangler.toml` eintragen.
2. `bunx wrangler r2 bucket create kontor-belege`
3. Sperren für 4.020 Tage (gut 11 Jahre, damit 10 Jahre ab Ende des Kalenderjahres sicher abgedeckt sind):
   `bunx wrangler r2 bucket lock add kontor-belege belege belege/ --retention-days 4020`
   `bunx wrangler r2 bucket lock add kontor-belege exporte exporte/ --retention-days 4020`
4. Nächtliche Sicherungen nach 30 Tagen aufräumen: `bunx wrangler r2 bucket lifecycle add kontor-belege sicherungen sicherungen/ --expire-days 30`
5. In Cloudflare Zero Trust eine Access-Anwendung für die Domain anlegen, nur mit der eigenen Adresse. Den AUD-Tag als Variable `ACCESS_AUD` am Worker im Dashboard eintragen (`keep_vars = true` erhält ihn bei jedem Deploy).
6. Die Domain als Route in `wrangler.toml` eintragen (`[[routes]]` mit `custom_domain = true`).
7. `bunx wrangler d1 migrations apply kontor --remote`, dann `bunx wrangler deploy`.

Zum Entwickeln gegen echtes R2 einen eigenen Bucket ohne Lock nehmen. Ein Test-Upload in den gesperrten Bucket bleibt 11 Jahre liegen.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `migrations/` | Schema mit Triggern, Standardwerte |
| `src/money.ts`, `src/tax.ts` | Beträge in Cent, Steuerschlüssel und ihre Wirkung |
| `src/euer.ts`, `src/ustva.ts`, `src/guard.ts`, `src/afa.ts` | EÜR, Voranmeldung, Kleinunternehmergrenze, Abschreibung |
| `src/entries.ts`, `src/documents.ts`, `src/periods.ts` | Buchungen, Belege, Monatsabschluss |
| `src/exports.ts` | Prüfer-Paket, PDF, SQL-Dump |
| `src/pages/`, `src/views/` | Seiten, HTML vom Server |
| `public/` | Stylesheet, ein kleines Skript, Schriften |
| `scripts/preview.ts` | lokale Vorschau mit Beispieldaten |

## Was es nicht kann

- Übermitteln an ELSTER. Dafür braucht es die ERiC-Bibliothek und eine Registrierung als Hersteller, ERiC läuft nicht im Worker. Kontor liefert die Werte zum Eintragen in Mein ELSTER.
- Kontoabruf von der Bank.
- Rechnungen an Kunden schreiben.
- Bilanz, Lohn, Gewerbesteuererklärung.

Keine Steuerberatung: Kategorien, Steuerschlüssel und die Einordnung von Tebex-Einnahmen einmal mit einem Steuerberater durchgehen.
