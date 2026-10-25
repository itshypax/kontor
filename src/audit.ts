import { isoSeconds } from './time'

/** An audit row as a statement, so it lands in the same batch as the change it describes. */
export function audit(db: D1Database, actor: string, action: string, subject: string, detail: unknown = ''): D1PreparedStatement {
  return db.prepare('INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(isoSeconds(), actor, action, subject, typeof detail === 'string' ? detail : JSON.stringify(detail))
}

export const ACTION_LABELS: Record<string, string> = {
  'document.upload': 'Beleg hochgeladen',
  'document.note': 'Beleg mit Vermerk versehen',
  'entry.create': 'Entwurf angelegt',
  'entry.update': 'Entwurf geändert',
  'entry.post': 'Buchung festgeschrieben',
  'entry.discard': 'Entwurf verworfen',
  'entry.reverse': 'Buchung storniert',
  'month.close': 'Monat abgeschlossen',
  'vat.filed': 'Voranmeldung als übermittelt vermerkt',
  'asset.create': 'Anlagegut angelegt',
  'asset.dispose': 'Abgang eingetragen',
  'export.create': 'Export erzeugt',
  'settings.update': 'Stammdaten geändert',
  'regime.create': 'Steuermodus eingetragen',
  'category.create': 'Kategorie angelegt',
  'category.update': 'Kategorie geändert',
  'account.create': 'Konto angelegt',
  'account.update': 'Konto geändert',
  'year.update': 'Jahrestabelle geändert',
  'procedure.create': 'Verfahrensdokumentation neu gefasst',
  'backup.nightly': 'Nächtliche Sicherung'
}
