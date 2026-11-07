/* ---------------- dialogue list ---------------- */
const listState = {q: '', channel: 'all', language: 'all', status: 'all', sort: 'score', dir: -1};
const selected = new Set();                 // dialogues ticked for «Оценить выбранные»
let visibleIds = [];
const CH_ICON = {
  'voice call': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h3l1.5 4-2 1.2a9 9 0 0 0 4.3 4.3l1.2-2L17 12v3a2 2 0 0 1-2 2A12 12 0 0 1 3 5a2 2 0 0 1 2-2z"/></svg>',
  'agent chat': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 4h14v9H8l-4 3v-3H3z"/></svg>'};
function rowInfo(r){
  const tr = r.transcript, t0 = parseTs(tr[0].timestamp);
  const length = Math.max(...tr.map(m => parseTs(m.timestamp) - t0));
  const first = tr.find(m => m.speaker === 'client');
  return {id: r.conversation_id, channel: r.channel, language: r.language, length, preview: first ? first.text : '', sum: summaryOf(r.conversation_id),
          text: tr.map(m => m.text).join(' ').toLowerCase()};
}
function statusMatch(s, f){
  return f === 'all' || (f === 'evaluated' && s.evaluated) || (f === 'pending' && !s.evaluated)
    || (f === 'gross' && s.gross) || (f === 'appeal' && s.openAppeals > 0) || (f === 'outdated' && s.outdated);
}
function renderFilters(rows){
  const count = (key, val) => rows.filter(r => val === 'all' || r[key] === val).length;
  const groups = [
    ['Канал', 'channel', [['all','Все'], ['agent chat','Чаты'], ['voice call','Звонки']]],
    ['Язык', 'language', [['all','Все'], ['RU','RU'], ['KZ','KZ'], ['EN','EN']]],
    ['Статус', 'status', [['all','Все'], ['evaluated','Оценены'], ['pending','Без оценки'], ['gross','Грубая ошибка'], ['appeal','Апелляция'], ['outdated','Старый чек-лист']]]];
  const active = listState.channel !== 'all' || listState.language !== 'all' || listState.status !== 'all' || listState.q;
  $('filters').innerHTML = groups.map(([label, key, opts]) => `<div class="fgroup ${key}" role="group" aria-label="${label}"><span class="fl">${label}</span><div class="seg">${
    opts.map(([v, l]) => {
      const n = key === 'status' ? rows.filter(r => statusMatch(r.sum, v)).length : count(key, v);
      return `<button class="fchip" data-k="${key}" data-v="${v}" aria-pressed="${listState[key] === v}">${l}<span class="n">${n}</span></button>`;
    }).join('')}</div></div>`).join('');
  $('fReset').hidden = !active;
  // clicking the active option again switches that group back to "Все"
  $('filters').querySelectorAll('.fchip').forEach(b => b.onclick = () => {
    const k = b.dataset.k, v = b.dataset.v;
    listState[k] = (listState[k] === v && v !== 'all') ? 'all' : v;
    renderList();
  });

}
function renderList(){
  const all = DATA.dialogues.map(rowInfo);
  renderFilters(all);
  const q = listState.q.trim().toLowerCase();
  let rows = all.filter(r => (listState.channel === 'all' || r.channel === listState.channel)
    && (listState.language === 'all' || r.language === listState.language)
    && statusMatch(r.sum, listState.status)
    && (!q || r.id.toLowerCase().includes(q) || r.text.includes(q)));
  const key = listState.sort, dir = listState.dir;
  const val = r => key === 'score' ? (r.sum.evaluated ? r.sum.total : -1) : key === 'length' ? r.length : r[key];
  rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir || a.id.localeCompare(b.id));
  const evaluated = all.filter(r => r.sum.evaluated).length;
  $('listMeta').textContent = `${all.length} диалогов, оценено ${evaluated}`;
  document.querySelectorAll('.dlg-table th[data-sort]').forEach(th => {
    if (th.dataset.sort === key) th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
  });
  visibleIds = rows.map(r => r.id);
  $('dlgBody').innerHTML = rows.map(r => {
    const s = r.sum, run = RUNNING[r.id];
    const runChip = run ? `<span class="chip-s blue" title="judge.py оценивает диалог">Оценивается · ${run.done}/${run.total}</span>` : '';
    const chips = runChip + (!s.evaluated ? (run ? '' : '<span class="chip-s" style="background:var(--na-soft);color:var(--muted)">Не оценён</span>')
      : [s.errors ? `<span class="chip-s red" title="Модель не вернула ответ по части критериев">Ошибка модели · ${s.errors}</span>` : '',
         s.gross ? '<span class="chip-s red">Грубая ошибка</span>' : '',
         s.openAppeals ? `<span class="chip-s amber">Апелляция${s.openAppeals > 1 ? ' · ' + s.openAppeals : ''}</span>` : '',
         s.decided ? '<span class="chip-s green">Решение принято</span>' : '',
         s.outdated ? `<span class="chip-s" style="background:var(--na-soft);color:var(--muted)" title="Оценён по прежней версии чек-листа">Чек-лист v${s.version}</span>` : ''].join(''));
    return `<tr tabindex="0" data-id="${r.id}" aria-label="Открыть ${r.id}"${selected.has(r.id) ? ' class="picked"' : ''}>
      <td class="sel-cell"><input type="checkbox" class="rsel" data-id="${r.id}" aria-label="Выбрать ${r.id}"${selected.has(r.id) ? ' checked' : ''}></td>
      <td><span class="did">${r.id}</span><span class="dprev">${esc(r.preview)}</span></td>
      <td><span class="ch">${CH_ICON[r.channel] || ''}${r.channel === 'voice call' ? 'Звонок' : 'Чат'}</span></td>
      <td>${LANG[r.language] || r.language}</td>
      <td class="num">${mmss(r.length)}</td>
      <td class="num">${s.evaluated && s.total !== null ? `<span class="score-b">${s.total !== s.orig && s.orig !== null ? `<s>${fmt.format(s.orig)}</s>` : ''}${fmt.format(s.total)}</span>` : '<span class="score-b none">—</span>'}</td>
      <td><div class="st-chips">${chips}</div></td></tr>`;
  }).join('');
  $('listEmpty').hidden = rows.length > 0;
  $('dlgBody').querySelectorAll('tr').forEach(tr => {
    tr.onclick = e => { if (e.target.closest('.sel-cell')) return; location.hash = encodeURIComponent(tr.dataset.id); };
    tr.onkeydown = e => { if (e.target.closest('.sel-cell')) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); } };
  });
  $('dlgBody').querySelectorAll('.rsel').forEach(cb => cb.onchange = () => {
    cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id);
    cb.closest('tr').classList.toggle('picked', cb.checked);
    renderSelBar();
  });
  renderSelBar();
}
/* batch assessment */
function renderSelBar(){
  const n = selected.size, vis = visibleIds.filter(id => selected.has(id)).length;
  const all = $('selAll');
  all.checked = visibleIds.length > 0 && vis === visibleIds.length;
  all.indeterminate = vis > 0 && vis < visibleIds.length;
  $('selBar').hidden = n === 0;
  if (!n) return;
  const busy = [...selected].filter(id => RUNNING[id]).length;
  $('selCount').textContent = `Выбрано ${n} ${plural(n, 'диалог', 'диалога', 'диалогов')}` + (busy ? `, ${busy} уже оцениваются` : '');
  $('selRun').disabled = !CONFIG.api_key || busy === n;
  $('selRun').title = CONFIG.api_key ? '' : 'Нет OPENROUTER_API_KEY в .env';
}
$('selAll').onchange = () => {
  const on = $('selAll').checked;
  visibleIds.forEach(id => on ? selected.add(id) : selected.delete(id));
  renderList();
};
$('selClear').onclick = () => { selected.clear(); renderList(); };
$('selRun').onclick = async () => {
  const ids = [...selected].filter(id => !RUNNING[id]);
  const k = SAVED.criteria.filter(c => c.include !== false).length;
  const again = ids.filter(id => getEval(id)).length;
  const withAppeals = ids.filter(id => Object.keys(storeOf(id).appeals).length).length;
  const ok = await ask(`Оценить ${ids.length} ${plural(ids.length, 'диалог', 'диалога', 'диалогов')}?`,
    `<p>judge.py оценит их по чек-листу v${SAVED.version}: ${k} ${plural(k, 'критерий', 'критерия', 'критериев')}, всего ${ids.length * k} ${plural(ids.length * k, 'запрос', 'запроса', 'запросов')} к модели ${esc(CONFIG.judge_model || '')}. Результаты запишутся в judge_results.json.</p>
     ${again ? `<p>${again} из них уже ${plural(again, 'оценён', 'оценены', 'оценены')}: новая оценка заменит старую.</p>` : ''}
     ${withAppeals ? `<p>Апелляции и решения по ${withAppeals} ${plural(withAppeals, 'диалогу', 'диалогам', 'диалогам')} будут сброшены.</p>` : ''}`, 'Оценить');
  if (!ok) return;
  const job = await startAssessment(ids);
  if (job) { selected.clear(); renderList(); toast(`judge.py запущен для ${Object.keys(job.dialogues).length} ${plural(Object.keys(job.dialogues).length, 'диалога', 'диалогов', 'диалогов')}`); }
};
document.querySelectorAll('.dlg-table th[data-sort]').forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  listState.dir = listState.sort === k ? -listState.dir : (k === 'score' || k === 'length' ? -1 : 1);
  listState.sort = k; renderList();
});
$('q').addEventListener('input', e => { listState.q = e.target.value; renderList(); });
$('fReset').onclick = () => { Object.assign(listState, {channel:'all', language:'all', status:'all', q:''}); $('q').value = ''; renderList(); };
