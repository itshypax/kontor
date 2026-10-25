import type { Ctx } from '../context'
import { DOC_KINDS, type DocumentKind, formatSize, getDocument, listDocuments, MAX_UPLOAD, noteDocument, storeDocument } from '../documents'
import { esc, field, html, HttpError, readForm, readUpload, redirect } from '../http'
import { formatDate, formatDateTime } from '../time'
import { hint, icon, page, pageHead } from '../views/layout'

function lockUntil(uploadedAt: string): string {
  const until = new Date(Date.parse(uploadedAt) + 4020 * 86400000)
  return until.toLocaleDateString('de-DE', { month: 'short', year: 'numeric', timeZone: 'Europe/Berlin' })
}

function docItem(d: Awaited<ReturnType<typeof listDocuments>>[number], action: string): string {
  return `<li>
  <span class="dot" aria-hidden="true" style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:var(--surface);color:var(--muted)">${icon('doc')}</span>
  <span class="text"><a href="/belege/${d.id}">${esc(d.filename)}</a><span><span class="num">${esc(d.number)}</span> · ${esc(DOC_KINDS[d.kind])} · ${formatDate(d.uploadedAt)}${d.mistaken ? ' · Vermerk: ' + esc(d.note) : ''}</span></span>
  ${action}
</li>`
}

export async function documentsPage(ctx: Ctx): Promise<Response> {
  const [unlinked, all] = await Promise.all([listDocuments(ctx.env.DB, { unlinked: true }), listDocuments(ctx.env.DB, { limit: 100 })])
  const kinds = Object.entries(DOC_KINDS).filter(([k]) => k !== 'own').map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('')
  const upload = ctx.readOnly ? '' : `<form method="post" action="/belege" enctype="multipart/form-data" class="stack" data-upload style="margin-bottom:24px">
  <div class="row" style="margin-bottom:0">
    <label class="upload-big grow"><span><strong>Beleg fotografieren</strong><small>wird sofort gespeichert und gesperrt</small></span><span class="circle" aria-hidden="true">${icon('camera')}</span>
      <input type="file" name="file" accept="image/*" capture="environment"></label>
    <div class="side card stack" style="gap:12px">
      <div class="field"><label for="file">Datei wählen</label><input id="file" type="file" name="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.xml,.csv"><small>PDF, Foto, E-Rechnung als XML oder CSV, bis 25 MB</small></div>
      <div class="field"><label for="kind">Art</label><select id="kind" name="kind">${kinds}</select></div>
      <button class="btn btn-light" type="submit">${icon('upload')}Hochladen</button>
    </div>
  </div>
</form>`
  const list = (items: typeof all, empty: string) => items.length ? `<ul class="doclist">${items.map(d => docItem(d, d.linked || d.mistaken || ctx.readOnly ? '' : `<a class="btn btn-sm" href="/buchungen/neu?beleg=${d.id}" style="color:var(--orange-text)">Buchen</a>`)).join('')}</ul>` : `<p class="muted">${empty}</p>`
  const body = `${pageHead('Belege', 'Jeder Beleg bekommt eine fortlaufende Nummer und eine Prüfsumme. Löschen und Überschreiben verhindert der Speicher.')}
${hint(ctx.url)}
${upload}
<div class="row">
  <section class="grow"><h2 class="label" style="margin-bottom:10px">Ohne Buchung · ${unlinked.length}</h2>${list(unlinked, 'Alle Belege sind einer Buchung zugeordnet.')}</section>
  <section class="side"><h2 class="label" style="margin-bottom:10px">Zuletzt hochgeladen</h2>${list(all.slice(0, 12), 'Noch keine Belege.')}</section>
</div>`
  return html(page({ title: 'Belege', active: 'documents', body, readOnly: ctx.readOnly }))
}

export async function uploadDocuments(ctx: Ctx): Promise<Response> {
  const form = await readUpload(ctx.request, MAX_UPLOAD * 4)
  const kindValue = field(form, 'kind')
  const kind = (Object.hasOwn(DOC_KINDS, kindValue) ? kindValue : 'invoice') as DocumentKind
  const files = form.getAll('file').filter((f): f is File => typeof f !== 'string' && f.size > 0)
  if (!files.length) throw new HttpError(400, 'Es wurde keine Datei ausgewählt.')
  const stored = []
  for (const file of files) stored.push(await storeDocument(ctx.env, file, kind, ctx.actor))
  if (stored.length === 1) return redirect(`/belege/${stored[0]!.id}?hinweis=${stored[0]!.duplicate ? 'doppelt' : 'hochgeladen'}`)
  return redirect('/belege?hinweis=hochgeladen')
}

export async function documentPage(ctx: Ctx, id: number): Promise<Response> {
  const doc = await getDocument(ctx.env.DB, id)
  if (!doc) throw new HttpError(404, 'Diesen Beleg gibt es nicht.')
  const { results: entries } = await ctx.env.DB.prepare(`SELECT e.id, e.number, e.status, e.text, e.paid_on FROM entry_documents ed JOIN entries e ON e.id = ed.entry_id WHERE ed.document_id = ? ORDER BY e.id`)
    .bind(id).all<{ id: number; number: string | null; status: string; text: string; paid_on: string }>()
  const preview = doc.mime.startsWith('image/') && doc.mime !== 'image/heic' && doc.mime !== 'image/heif'
    ? `<img class="doc-preview" src="/belege/${doc.id}/datei" alt="Vorschau von ${esc(doc.filename)}">`
    : `<div class="doc-placeholder">${icon('doc')}&nbsp;${esc(doc.mime === 'application/pdf' ? 'PDF' : doc.mime)}</div>`
  const linked = entries.length
    ? `<ul class="doclist">${entries.map(e => `<li><span class="text"><a href="/buchungen/${e.id}">${esc(e.text)}</a><span class="num">${e.number ? esc(e.number) : e.status === 'discarded' ? 'verworfen' : 'Entwurf'} · ${formatDate(e.paid_on)}</span></span></li>`).join('')}</ul>`
    : '<p class="muted">Noch keiner Buchung zugeordnet.</p>'
  const actions = ctx.readOnly ? '' : `${!doc.mistaken ? `<a class="btn btn-primary" href="/buchungen/neu?beleg=${doc.id}">${icon('plus')}Buchen</a>` : ''}`
  const noteForm = ctx.readOnly || doc.mistaken ? '' : `<details class="card" style="margin-top:20px"><summary style="cursor:pointer;font-weight:600">Irrtümlich hochgeladen?</summary>
<p class="muted" style="font-size:14px">Belege bleiben gespeichert. Ein Vermerk nimmt ihn aus der Liste der offenen Belege.</p>
<form method="post" action="/belege/${doc.id}/vermerk" class="actions"><label class="sr" for="note">Vermerk</label><input id="note" name="note" placeholder="etwa: doppelt hochgeladen" required style="flex:1;min-width:220px"><button class="btn">Vermerk speichern</button></form></details>`
  const body = `${pageHead(doc.number, esc(doc.filename), actions, { href: '/belege', label: 'Belege' })}
${hint(ctx.url)}
<div class="row">
  <section class="card grow">${preview}
    <div class="actions" style="margin-top:14px"><a class="btn btn-sm" href="/belege/${doc.id}/datei" target="_blank" rel="noopener">Öffnen</a><a class="btn btn-sm" href="/belege/${doc.id}/datei?download=1">Herunterladen</a></div>
  </section>
  <aside class="side stack">
    <section class="card"><h2 class="label">Angaben</h2>
      <dl class="meta">
        <dt>Art</dt><dd>${esc(DOC_KINDS[doc.kind])}</dd>
        <dt>Größe</dt><dd>${formatSize(doc.size)}</dd>
        <dt>SHA-256</dt><dd class="num" style="font-size:12px">${esc(doc.sha256)}</dd>
        <dt>Hochgeladen</dt><dd>${formatDateTime(doc.uploadedAt)} von ${esc(doc.uploadedBy)}</dd>
        <dt>Sperre</dt><dd>bis ${lockUntil(doc.uploadedAt)}</dd>
        ${doc.mistaken ? `<dt>Vermerk</dt><dd>${esc(doc.note)}</dd>` : ''}
      </dl>
    </section>
    <section class="card"><h2 class="label" style="margin-bottom:12px">Buchungen</h2>${linked}</section>
  </aside>
</div>
${noteForm}`
  return html(page({ title: doc.number, active: 'documents', body, readOnly: ctx.readOnly }))
}

export async function documentFile(ctx: Ctx, id: number): Promise<Response> {
  const doc = await getDocument(ctx.env.DB, id)
  if (!doc) throw new HttpError(404, 'Diesen Beleg gibt es nicht.')
  const object = await ctx.env.FILES.get(doc.r2Key)
  if (!object) throw new HttpError(404, 'Die Datei fehlt im Speicher. Bitte die Sicherung prüfen.')
  const disposition = ctx.url.searchParams.has('download') ? 'attachment' : 'inline'
  return new Response(object.body, { headers: {
    'content-type': doc.mime,
    'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
    // Uploaded files never get to run anything in this origin.
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'cache-control': 'private, max-age=3600'
  } })
}

export async function noteDocumentAction(ctx: Ctx, id: number): Promise<Response> {
  const form = await readForm(ctx.request)
  await noteDocument(ctx.env.DB, id, field(form, 'note'), ctx.actor)
  return redirect(`/belege/${id}?hinweis=vermerkt`)
}
