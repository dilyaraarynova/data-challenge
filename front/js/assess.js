/* ---------------- assessment: judge.py runs on the server ----------------
   «Оценить диалог» and «Оценить выбранные» start a job (POST /api/evaluate). The server runs judge.py for every
   (dialogue, enabled criterion) pair with the saved checklist and writes each finished dialogue to
   judge_results.json. Here the job is polled; finished dialogues are reloaded as they arrive. */
const RUNNING = {};                       // conversation_id -> {job, state, done, total}
const POLL_MS = 1500;

function trackJob(job){
  Object.entries(job.dialogues).forEach(([id, d]) => {
    if (d.state === 'queued' || d.state === 'running') RUNNING[id] = {job: job.id, ...d};
  });
  refreshViews();
  setTimeout(() => pollJob(job.id), POLL_MS);
}
async function pollJob(jobId){
  let job;
  try { job = await API.job(jobId); }
  catch (e) { toast('Не удалось узнать ход оценки: ' + e.message); setTimeout(() => pollJob(jobId), POLL_MS * 4); return; }
  const finished = [];
  Object.entries(job.dialogues).forEach(([id, d]) => {
    if (d.state === 'queued' || d.state === 'running') RUNNING[id] = {job: job.id, ...d};
    else if (RUNNING[id]?.job === job.id) { delete RUNNING[id]; finished.push([id, d.state]); }
  });
  if (finished.length) {
    try { EVALS = await API.evaluations(); } catch (e) { toast(e.message); }
    finished.forEach(([id]) => { delete stores[id]; delete REVIEWS[id]; });   // old appeals belong to the replaced evaluation
    const open = decodeURIComponent(location.hash.slice(1));
    if (finished.some(([id]) => id === open)) {
      const st = finished.find(([id]) => id === open)[1];
      toast(st === 'error' ? 'Оценка готова, но часть критериев не оценена: модель вернула ошибку' : `Диалог оценён по чек-листу v${job.checklist_version}`);
      openDialogue(open);
    }
  }
  if (job.status === 'running') { refreshViews(); setTimeout(() => pollJob(jobId), POLL_MS); return; }
  const n = Object.keys(job.dialogues).length;
  if (job.status === 'error') toast('Оценка прервана: ' + (job.fatal || 'ошибка сервера'));
  else if (n > 1) toast(`Оценено диалогов: ${n}${job.errors.length ? `, ошибок модели: ${job.errors.length}` : ''}`);
  Object.keys(RUNNING).forEach(id => { if (RUNNING[id].job === job.id) delete RUNNING[id]; });
  refreshViews();
}
/* re-render whatever is on screen so progress and new scores show up */
function refreshViews(){
  if (!$('viewList').hidden) renderList();
  else if (!$('viewCard').hidden && D) { renderRows(); renderDetail(); }
}
async function startAssessment(ids){
  try {
    const job = await API.evaluate(ids);
    trackJob(job);
    return job;
  } catch (e) { toast(e.message); return null; }
}
async function runAssessment(id, btn){
  if (btn) { btn.disabled = true; btn.textContent = 'Запускаем…'; }
  const job = await startAssessment([id]);
  if (!job && btn) { btn.disabled = false; btn.textContent = 'Оценить диалог'; }
  else if (job) toast(`judge.py запущен: ${job.criteria.length} ${plural(job.criteria.length, 'критерий', 'критерия', 'критериев')}, модель ${job.model}`);
}
async function confirmReassess(id, btn){
  const ev = getEval(id), s = summaryOf(id);
  const ok = await ask(`Переоценить по чек-листу v${SAVED.version}?`,
    `<p>Сейчас диалог оценён по чек-листу v${ev.checklist.version}${s.total !== null ? `, итог ${fmt.format(s.total)}` : ''}. Новая оценка заменит старую в judge_results.json.</p>
     ${Object.keys(storeOf(id).appeals).length ? '<p>Апелляции и решения по этому диалогу относятся к старой оценке и будут сброшены.</p>' : ''}`, 'Переоценить и заменить');
  if (ok) runAssessment(id, btn);
}
/* progress line for a dialogue being assessed */
function progressHtml(id){
  const r = RUNNING[id]; if (!r) return '';
  const pctDone = r.total ? Math.round(r.done / r.total * 100) : 0;
  return `<div class="run-progress" role="status"><span>judge.py оценивает: ${r.done} из ${r.total} ${plural(r.total, 'критерия', 'критериев', 'критериев')}</span>
    <div class="run-bar"><i style="width:${pctDone}%"></i></div></div>`;
}
