import { esc } from '../http'

export type NavKey = 'overview' | 'documents' | 'entries' | 'reports' | 'export' | 'assets' | 'settings' | 'log' | 'more'

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  list: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  camera: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  in: 'M12 19V5M6 11l6-6 6 6',
  out: 'M12 5v14M6 13l6 6 6-6',
  dots: 'M5 12h.01M12 12h.01M19 12h.01'
}

export function icon(name: keyof typeof PATHS | string, label?: string): string {
  const aria = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'
  return `<svg class="icon" viewBox="0 0 24 24" ${aria}><path d="${PATHS[name] ?? ''}"/></svg>`
}

const NAV: Array<{ key: NavKey; href: string; label: string }> = [
  { key: 'overview', href: '/', label: 'Übersicht' },
  { key: 'documents', href: '/belege', label: 'Belege' },
  { key: 'entries', href: '/buchungen', label: 'Buchungen' },
  { key: 'reports', href: '/auswertungen', label: 'Auswertungen' },
  { key: 'export', href: '/export', label: 'Export' }
]

const MORE: Array<{ key: NavKey; href: string; label: string }> = [
  { key: 'assets', href: '/anlagen', label: 'Anlagen' },
  { key: 'settings', href: '/einstellungen', label: 'Einstellungen' },
  { key: 'log', href: '/protokoll', label: 'Protokoll' }
]

export const MORE_LINKS = [...NAV.slice(3), ...MORE]

export function page(opts: { title: string; active: NavKey; body: string; readOnly?: boolean }): string {
  const current = (key: NavKey) => (key === opts.active ? ' aria-current="page"' : '')
  const moreActive = MORE.some(m => m.key === opts.active)
  const dock: Array<{ key: NavKey; href: string; label: string }> = [NAV[0]!, NAV[1]!, NAV[2]!, { key: 'more', href: '/mehr', label: 'Mehr' }]
  const dockActive = (key: NavKey) => key === opts.active || (key === 'more' && !['overview', 'documents', 'entries'].includes(opts.active))
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(opts.title)} | Kontor</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="module" src="/app.js"></script>
</head>
<body>
<header class="wrap top">
  <a class="brand" href="/">Emergency<span>Forge</span> <small>Kontor</small></a>
  <nav class="pills" aria-label="Bereiche">
    ${NAV.map(n => `<a href="${n.href}"${current(n.key)}>${n.label}</a>`).join('')}
    <details class="more"><summary${moreActive ? ' style="color:var(--text)"' : ''}>${icon('dots')}<span class="sr">Mehr</span></summary>
      <div class="more-menu">${MORE.map(m => `<a href="${m.href}"${current(m.key)}>${m.label}</a>`).join('')}</div>
    </details>
  </nav>
  <div class="top-actions">${opts.readOnly ? '<span class="badge">Nur lesen</span>' : `<a class="btn btn-light" href="/belege">${icon('upload')}Beleg hochladen</a>`}</div>
</header>
<main class="wrap">
${opts.body}
</main>
<nav class="dock" aria-label="Bereiche">${dock.map(d => `<a href="${d.href}"${dockActive(d.key) ? ' aria-current="page"' : ''}>${d.label}</a>`).join('')}</nav>
</body>
</html>`
}

export function pageHead(title: string, lead = '', actions = '', back?: { href: string; label: string }): string {
  return `${back ? `<a class="back" href="${back.href}">${icon('back')}${esc(back.label)}</a>` : ''}
<div class="page-head"><div><h1>${esc(title)}</h1>${lead ? `<p>${lead}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`
}

export function notice(text: string, warn = false): string {
  return `<div class="notice${warn ? ' warn' : ''}" role="${warn ? 'alert' : 'status'}">${icon(warn ? 'info' : 'check')}<div>${text}</div></div>`
}

export function errorList(errors: string[]): string {
  if (!errors.length) return ''
  return notice(`<strong>Das ging nicht.</strong><ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`, true)
}

export const HINTS: Record<string, string> = {
  hochgeladen: 'Beleg gespeichert und gesperrt.',
  doppelt: 'Diesen Beleg gab es schon. Er ist unten geöffnet.',
  vermerkt: 'Vermerk gespeichert. Der Beleg bleibt erhalten.',
  entwurf: 'Entwurf gespeichert.',
  festgeschrieben: 'Buchung festgeschrieben. Sie lässt sich jetzt nur noch stornieren.',
  verworfen: 'Entwurf verworfen. Er bleibt im Protokoll.',
  storniert: 'Storno gebucht.',
  abgeschlossen: 'Monat abgeschlossen.',
  uebermittelt: 'Voranmeldung als übermittelt vermerkt.',
  gespeichert: 'Gespeichert.',
  anlage: 'Anlagegut eingetragen.',
  abgang: 'Abgang eingetragen.'
}

export function hint(url: URL): string {
  const key = url.searchParams.get('hinweis')
  return key && HINTS[key] ? notice(esc(HINTS[key])) : ''
}

export function errorPage(status: number, message: string, readOnly = false): string {
  return page({ title: 'Fehler', active: 'more', readOnly, body: `${pageHead(status === 404 ? 'Nicht gefunden' : 'Das ging nicht')}
${notice(esc(message), true)}
<p><a class="btn" href="/">Zur Übersicht</a></p>` })
}
