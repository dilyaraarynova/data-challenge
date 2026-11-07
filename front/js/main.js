/* ---------------- routing: #<conversation_id> opens the card, #checklists the editor, empty hash the list ---------------- */
function route(){
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && RECORDS[id]) openDialogue(id);
  else if (id === 'checklists' && !canEditChecklists()) { toast('Чек-листы доступны только проверяющему'); location.replace('#'); }
  else if (id === 'checklists') { if (!$('viewCard').hidden && isFs()) setFullscreen(false); stopPlayback(); renderChecklists(); showView('checklists'); document.querySelector('main').scrollTop = 0; }
  else { if (!$('viewCard').hidden && isFs()) setFullscreen(false); stopPlayback(); renderList(); showView('list'); }
}
$('backBtn').onclick = () => { location.hash = ''; };
$('navDialogs').onclick = () => { location.hash = ''; };
$('navChecklists').onclick = () => { location.hash = 'checklists'; };
window.addEventListener('hashchange', route);
applyRoleAccess();
function fitGrid(){
  const main = document.querySelector('main'), grid = $('viewCard').querySelector('.grid');
  if ($('viewCard').hidden || matchMedia('(max-width:1100px)').matches) { grid.style.height = ''; return; }
  const offset = grid.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
  grid.style.height = Math.max(460, Math.floor(main.clientHeight - offset - pad)) + 'px';
}
new ResizeObserver(fitGrid).observe(document.querySelector('main'));
new ResizeObserver(fitGrid).observe($('top'));
new ResizeObserver(fitGrid).observe($('player'));
window.addEventListener('resize', () => { if (!$('viewCard').hidden && D && isVoice()) renderTrack(); });
/* ---------------- start: load everything from the server ---------------- */
async function boot(){
  try {
    const b = await API.bootstrap();
    CONFIG = b.config || {};
    setDialogues(b.dialogues);
    setSaved(b.checklist);
    EVALS = b.evaluations || {};
    REVIEWS = b.reviews || {};
    (b.jobs || []).forEach(trackJob);                 // judge runs still going after a page reload
  } catch (e) {
    document.querySelector('main').innerHTML = `<div class="boot-err"><h1>Нет связи с сервером</h1><p>${esc(e.message)}</p>
      <pre>python server.py</pre><p>Затем откройте <a href="http://127.0.0.1:8000">http://127.0.0.1:8000</a>.</p></div>`;
    return;
  }
  // host pages (e.g. a Dynamics 365 form) may pass the dialogue to open as ?id=… or ?data=…
  const qs = new URLSearchParams(location.search);
  const want = [].concat(window.CQA_CONFIG.openParam || []).map(k => qs.get(k)).find(v => v && RECORDS[v]);
  if (want && !location.hash) location.replace('#' + encodeURIComponent(want));
  route();
}
boot();
