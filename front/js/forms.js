/* ---------------- forms without real submission ----------------
   Sandboxed frames (preview, some Dynamics hosts) block form submission, which breaks method="dialog" and
   submit handlers. Every form button and Enter-in-input fires a synthetic submit event instead; for
   method="dialog" the dialog is closed with the button's value unless a handler called preventDefault(). */
function fakeSubmit(form, btn){
  const ev = new SubmitEvent('submit', {cancelable: true, submitter: btn || null});
  form.dispatchEvent(ev);
  const dlg = form.closest('dialog');
  if (!ev.defaultPrevented && form.getAttribute('method') === 'dialog' && dlg?.open) dlg.close(btn?.value || '');
}
document.addEventListener('click', e => {
  const btn = e.target.closest('form button'); if (!btn || btn.type !== 'submit') return;
  e.preventDefault(); fakeSubmit(btn.form, btn);
}, true);
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing || !(e.target instanceof HTMLInputElement) || !e.target.form) return;
  e.preventDefault();
  const form = e.target.form, btn = form.querySelector('button[type="submit"]:not([value="cancel"]), button:not([type]):not([value="cancel"])');
  fakeSubmit(form, btn);
}, true);

/* ---------------- generic confirm ---------------- */
function ask(title, html, okLabel, danger){
  return new Promise(res => {
    const d = $('askDlg');
    $('askTitle').textContent = title; $('askBody').innerHTML = html;
    $('askOk').textContent = okLabel; $('askOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    d.returnValue = '';
    d.onclose = () => res(d.returnValue === 'ok' ? d : null);
    d.showModal();
  });
}
