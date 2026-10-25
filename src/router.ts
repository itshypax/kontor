import type { Ctx } from './context'
import { HttpError, methodDenied } from './http'
import { assetsPage, createAssetAction, disposeAssetAction } from './pages/assets'
import { documentFile, documentPage, documentsPage, noteDocumentAction, uploadDocuments } from './pages/documents'
import { createEntryAction, discardEntryAction, entriesPage, entryPage, newEntryPage, postEntryAction, previewAction, reverseEntryAction, updateEntryAction } from './pages/entries'
import { backupAction, euerPdfAction, exportFile, exportsPage, packageAction } from './pages/exports'
import { logPage, morePage } from './pages/misc'
import { closeMonthAction, monthPage } from './pages/months'
import { overviewPage } from './pages/overview'
import { fileVatAction, reportsPage } from './pages/reports'
import { addAccountAction, addCategoryAction, addRegimeAction, saveProcedureAction, saveSettingsAction, saveYearAction, settingsPage, updateAccountAction, updateCategoryAction } from './pages/settings'

type Handler = (ctx: Ctx, param: string) => Promise<Response>
type Route = { method: 'GET' | 'POST'; pattern: RegExp; handler: Handler; readerMayPost?: boolean }

const id = (fn: (ctx: Ctx, id: number) => Promise<Response>): Handler => (ctx, param) => fn(ctx, Number(param))

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/$/, handler: overviewPage },
  { method: 'GET', pattern: /^\/belege$/, handler: documentsPage },
  { method: 'POST', pattern: /^\/belege$/, handler: uploadDocuments },
  { method: 'GET', pattern: /^\/belege\/(\d+)$/, handler: id(documentPage) },
  { method: 'GET', pattern: /^\/belege\/(\d+)\/datei$/, handler: id(documentFile) },
  { method: 'POST', pattern: /^\/belege\/(\d+)\/vermerk$/, handler: id(noteDocumentAction) },
  { method: 'GET', pattern: /^\/buchungen$/, handler: entriesPage },
  { method: 'GET', pattern: /^\/buchungen\/neu$/, handler: newEntryPage },
  { method: 'POST', pattern: /^\/buchungen$/, handler: createEntryAction },
  { method: 'POST', pattern: /^\/buchungen\/vorschau$/, handler: previewAction, readerMayPost: true },
  { method: 'GET', pattern: /^\/buchungen\/(\d+)$/, handler: id(entryPage) },
  { method: 'POST', pattern: /^\/buchungen\/(\d+)$/, handler: id(updateEntryAction) },
  { method: 'POST', pattern: /^\/buchungen\/(\d+)\/festschreiben$/, handler: id(postEntryAction) },
  { method: 'POST', pattern: /^\/buchungen\/(\d+)\/verwerfen$/, handler: id(discardEntryAction) },
  { method: 'POST', pattern: /^\/buchungen\/(\d+)\/storno$/, handler: id(reverseEntryAction) },
  { method: 'GET', pattern: /^\/monate\/(\d{4}-\d{2})$/, handler: monthPage },
  { method: 'POST', pattern: /^\/monate\/(\d{4}-\d{2})$/, handler: closeMonthAction },
  { method: 'GET', pattern: /^\/auswertungen$/, handler: reportsPage },
  { method: 'POST', pattern: /^\/voranmeldung\/(\d{4}-(?:\d{2}|Q[1-4]))$/, handler: fileVatAction },
  { method: 'GET', pattern: /^\/anlagen$/, handler: assetsPage },
  { method: 'POST', pattern: /^\/anlagen$/, handler: createAssetAction },
  { method: 'POST', pattern: /^\/anlagen\/(\d+)\/abgang$/, handler: id(disposeAssetAction) },
  { method: 'GET', pattern: /^\/export$/, handler: exportsPage },
  { method: 'POST', pattern: /^\/export\/pruefer$/, handler: packageAction, readerMayPost: true },
  { method: 'POST', pattern: /^\/export\/euer$/, handler: euerPdfAction, readerMayPost: true },
  { method: 'POST', pattern: /^\/export\/sicherung$/, handler: backupAction },
  { method: 'GET', pattern: /^\/export\/(\d+)$/, handler: id(exportFile) },
  { method: 'GET', pattern: /^\/einstellungen$/, handler: settingsPage },
  { method: 'POST', pattern: /^\/einstellungen\/stammdaten$/, handler: saveSettingsAction },
  { method: 'POST', pattern: /^\/einstellungen\/steuermodus$/, handler: addRegimeAction },
  { method: 'POST', pattern: /^\/einstellungen\/kategorien$/, handler: addCategoryAction },
  { method: 'POST', pattern: /^\/einstellungen\/kategorien\/(\d+)$/, handler: id(updateCategoryAction) },
  { method: 'POST', pattern: /^\/einstellungen\/konten$/, handler: addAccountAction },
  { method: 'POST', pattern: /^\/einstellungen\/konten\/(\d+)$/, handler: id(updateAccountAction) },
  { method: 'POST', pattern: /^\/einstellungen\/jahr\/(\d{4})$/, handler: id(saveYearAction) },
  { method: 'POST', pattern: /^\/einstellungen\/verfahren$/, handler: saveProcedureAction },
  { method: 'GET', pattern: /^\/protokoll$/, handler: logPage },
  { method: 'GET', pattern: /^\/mehr$/, handler: morePage }
]

export async function route(ctx: Ctx): Promise<Response> {
  const path = ctx.url.pathname
  const matches = ROUTES.filter(r => r.pattern.test(path))
  if (!matches.length) throw new HttpError(404, 'Diese Seite gibt es nicht.')
  const method = ctx.request.method === 'HEAD' ? 'GET' : ctx.request.method
  const match = matches.find(r => r.method === method)
  if (!match) return methodDenied(ctx.request, matches.map(r => r.method))!
  if (method === 'POST' && ctx.readOnly && !match.readerMayPost) throw new HttpError(403, 'Mit Lesezugang lässt sich nichts ändern.')
  return match.handler(ctx, path.match(match.pattern)?.[1] ?? '')
}
