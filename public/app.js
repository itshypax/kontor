// Small enhancements. Every page works without this file.

document.addEventListener('click', event => {
  const button = event.target.closest('[data-confirm]')
  if (button && !window.confirm(button.dataset.confirm)) event.preventDefault()
  const more = document.querySelector('details.more[open]')
  if (more && !more.contains(event.target)) more.removeAttribute('open')
})

for (const form of document.querySelectorAll('form[data-autosubmit]')) {
  form.addEventListener('change', event => { if (event.target.matches('select')) form.requestSubmit() })
}

for (const form of document.querySelectorAll('form[data-upload]')) {
  const camera = form.querySelector('input[capture]')
  camera?.addEventListener('change', () => { if (camera.files.length) form.requestSubmit() })
}

const entryForm = document.querySelector('form[data-entry-form]')
if (entryForm) {
  const lines = entryForm.querySelector('[data-lines]')
  const addButton = entryForm.querySelector('[data-add-line]')
  let timer = null
  let pending = null

  const renumber = () => {
    lines.querySelectorAll('[data-line]').forEach((line, i) => {
      for (const radio of line.querySelectorAll('input[type=radio]')) radio.name = `line_tax_${i}`
      const gross = line.querySelector('input[name=line_gross]')
      gross.id = `gross-${i}`
      line.querySelector('label.label').htmlFor = gross.id
      const select = line.querySelector('select[data-category]')
      select.id = `cat-${i}`
      select.previousElementSibling.htmlFor = select.id
    })
  }

  const refresh = async () => {
    pending?.abort()
    pending = new AbortController()
    try {
      const response = await fetch('/buchungen/vorschau', { method: 'POST', body: new FormData(entryForm), signal: pending.signal })
      if (!response.ok) return
      const { lines: effects } = await response.json()
      lines.querySelectorAll('[data-line]').forEach((line, i) => {
        const effect = effects[i]
        const values = line.querySelectorAll('[data-split] strong')
        values[0].textContent = effect ? effect.net : '0,00 €'
        values[1].textContent = effect ? effect.tax : '0,00 €'
        values[2].textContent = effect ? effect.gross : '0,00 €'
        const box = line.querySelector('[data-effect]')
        box.hidden = !effect
        if (effect) {
          box.classList.toggle('warn', effect.warn)
          box.querySelector('strong').textContent = effect.title
          box.querySelector('span').textContent = effect.text
        }
      })
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(error)
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 250) }

  entryForm.addEventListener('input', schedule)
  entryForm.addEventListener('change', event => {
    // A new category brings its usual tax code, unless one was chosen by hand.
    const select = event.target.closest('select[data-category]')
    if (select) {
      const line = select.closest('[data-line]')
      const tax = select.selectedOptions[0]?.dataset.tax
      if (tax && !line.dataset.taxTouched) {
        const radio = line.querySelector(`input[type=radio][value="${tax}"]`)
        if (radio) radio.checked = true
      }
    }
    if (event.target.matches('input[type=radio]')) event.target.closest('[data-line]').dataset.taxTouched = '1'
    schedule()
  })

  addButton?.addEventListener('click', event => {
    event.preventDefault()
    const template = lines.querySelector('[data-line]')
    const copy = template.cloneNode(true)
    copy.querySelector('input[name=line_gross]').value = ''
    copy.querySelector('select[data-category]').value = ''
    for (const radio of copy.querySelectorAll('input[type=radio]')) radio.checked = false
    delete copy.dataset.taxTouched
    copy.querySelector('[data-effect]').hidden = true
    const head = copy.querySelector('.card-head')
    if (!head.querySelector('[data-remove-line]')) head.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-sm btn-ghost" data-remove-line>Entfernen</button>')
    addButton.parentElement.before(copy)
    renumber()
    copy.querySelector('label.label').textContent = `Position ${lines.querySelectorAll('[data-line]').length}, Betrag`
    copy.querySelector('input[name=line_gross]').focus()
  })

  lines.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-line]')
    if (!remove) return
    remove.closest('[data-line]').remove()
    renumber()
    schedule()
  })
}
