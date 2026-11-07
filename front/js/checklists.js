/* ---------------- checklist editor page ---------------- */
const isDirty = () => JSON.stringify(draft) !== JSON.stringify(SAVED);
const critById = id => draft.criteria.find(c => c.id === id);
const TRASH = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>';
const scaleText = c => (c.scale_steps || []).join(', ');
function renderChecklists(flashId){
  const secOpts = sel => draft.sections.map(s => `<option value="${s.id}"${s.id === sel ? ' selected' : ''}>${esc(s.name)}</option>`).join('') + '<option value="__new">+ Новая категория…</option>';
  const typeOpts = sel => Object.entries(TYPES).map(([k, l]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${l}</option>`).join('');
  let n = 0;
  const rows = [];
  // one flat list in category order; criteria switched off in the SAVED checklist go to the bottom
  const secIdx = id => draft.sections.findIndex(s => s.id === id);
  const savedOff = c => SAVED.criteria.find(x => x.id === c.id)?.include === false;
  const key = clSort.key, dir = clSort.dir;
  const cmp = (a, b) => {
    if (!key) return 0;
    const va = CSORT[key](a, secIdx), vb = CSORT[key](b, secIdx);
    return (typeof va === 'string' ? va.localeCompare(vb, 'ru') : va - vb) * dir;
  };
  const ordered = draft.criteria.map((c, i) => ({c, i}))
    .sort((a, b) => (savedOff(a.c) - savedOff(b.c)) || cmp(a.c, b.c) || (secIdx(a.c.section) - secIdx(b.c.section)) || (a.i - b.i))
    .map(x => x.c);
  document.querySelectorAll('.cl-table th[data-csort]').forEach(th => {
    if (key && th.dataset.csort === key) th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
  });
  ordered.forEach(c => {
      n++;
      const on = c.include !== false, flag = c.answer_type === 'flag', scale = c.answer_type.startsWith('scale');
      const ro = on ? '' : ' disabled';                     // switched-off rows are read-only, only the switch works
      const open = openSpecs.has(c.id);
      rows.push(`<tr data-id="${c.id}" class="${on ? '' : 'off'}${c.id === flashId ? ' flash' : ''}${open ? ' spec-open' : ''}">
        <td class="n-cell">${n}</td>
        <td class="name-cell"><input class="inp" data-f="name" value="${esc(c.name)}" aria-label="Название критерия"${ro}>
          <textarea class="inp desc" data-f="description" rows="2" placeholder="Добавьте условие: когда ставить «Да», «Нет» или Н/П" aria-label="Условие оценки"${ro}>${esc(c.description || '')}</textarea>
          ${c.answer_type.endsWith('_na') ? `<span class="f-cap">Когда ставить Н/П</span><textarea class="inp desc na-desc" data-f="na_condition" rows="2" placeholder="Когда ставить Н/П (вопрос для модели)" aria-label="Когда ставить Н/П"${ro}>${esc(c.na_condition || '')}</textarea>` : ''}
          <button class="link-btn spec-tg" data-act="spec" aria-expanded="${open}">${open ? 'Скрыть правила для модели' : 'Правила для модели'}</button></td>
        <td><select class="inp" data-f="section" aria-label="Категория"${ro}>${secOpts(c.section)}</select></td>
        <td><select class="inp" data-f="answer_type" aria-label="Тип ответа"${ro}>${typeOpts(c.answer_type)}</select></td>
        <td>${scale ? `<input class="inp scale" data-f="scale" value="${scaleText(c)}" aria-label="Ступени шкалы" title="Ступени через запятую. Верхняя ступень даёт полный вес"${ro}>` : '<span class="muted-cell">—</span>'}</td>
        <td class="num">${flag ? '<span class="muted-cell">без баллов</span>' : `<input class="inp w" type="number" min="0" max="100" step="1" data-f="weight" value="${c.weight}" aria-label="Вес"${ro}>`}</td>
        <td class="num share" data-share="${c.id}"></td>
        <td class="inc-cell"><button class="sw" role="switch" data-act="inc" aria-checked="${on}" aria-label="Включить в оценку: ${esc(c.name)}" title="${on ? 'Участвует в оценке' : 'Не участвует в оценке'}"><span></span></button></td>
        <td class="del-cell"><button class="icon-btn" data-act="del" aria-label="Удалить критерий ${esc(c.name)}" title="${on ? 'Удалить критерий' : 'Включите критерий, чтобы его изменить или удалить'}"${ro}>${TRASH}</button></td></tr>`);
      if (open) rows.push(`<tr class="spec-row" data-spec="${c.id}"><td></td><td colspan="8">${specPanel(c, on)}</td></tr>`);
  });
  $('clBody').innerHTML = rows.join('');
  $('clShared').innerHTML = draft.shared ? `<p class="sp-hint">Правила из checklist_iter1/shared_rules.json добавляются в начало каждого запроса judge.py, для любого критерия.</p>
    <div class="spec">${specHtml(draft.shared, [], 'shared', null, false)}</div>` : '';
  $('clTrErr').hidden = !SAVED.translation_error;
  $('clTrErr').textContent = SAVED.translation_error ? `Перевод недоступен, часть текстов показана на английском. ${SAVED.translation_error}` : '';
  renderCats(); renderClStatus();
  if (flashId) $('clBody').querySelector(`tr[data-id="${flashId}"]`)?.scrollIntoView({block: 'center', behavior: 'smooth'});
}
/* column sorting: first click sorts (text A→Я, numbers high→low), second reverses, "№" returns to the default order.
   Criteria switched off in the saved checklist always stay at the bottom. */
const clSort = {key: null, dir: 1};
const CSORT = {
  name: c => (c.name || '').toLowerCase(),
  section: (c, secIdx) => secIdx(c.section),
  type: c => Object.keys(TYPES).indexOf(c.answer_type),
  scale: c => c.scale_steps ? c.scale_max : -1,
  weight: c => isScored(c) ? +c.weight || 0 : -1,
  share: c => isScored(c) ? +c.weight || 0 : -1,
  inc: c => c.include !== false ? 1 : 0};
document.querySelectorAll('.cl-table th[data-csort]').forEach(th => th.onclick = () => {
  const k = th.dataset.csort;
  if (k === 'n') { clSort.key = null; clSort.dir = 1; }
  else if (clSort.key === k) clSort.dir = -clSort.dir;
  else { clSort.key = k; clSort.dir = ['weight', 'share', 'scale', 'inc'].includes(k) ? -1 : 1; }
  renderChecklists();
});
function renderClStatus(){
  const scored = draft.criteria.filter(isScored), sum = scored.reduce((s, c) => s + (+c.weight || 0), 0);
  $('clBody').querySelectorAll('[data-share]').forEach(td => {
    const c = critById(td.dataset.share);
    td.textContent = c && isScored(c) && sum ? fmt.format(Math.round(c.weight / sum * 10000) / 100) : '—';
  });
  $('clBody').querySelectorAll('tr[data-id]').forEach(tr => {
    const a = critById(tr.dataset.id), b = SAVED.criteria.find(c => c.id === tr.dataset.id);
    tr.classList.toggle('dirty', !b || JSON.stringify(a) !== JSON.stringify(b));
  });
  const ok = Math.abs(sum - 100) < 0.001;
  $('clSum').className = 'cl-sum' + (ok ? '' : ' warn');
  $('clSum').innerHTML = `<span>Сумма весов включённых критериев: <b>${fmt.format(sum)}</b> из 100</span>`
    + (!ok && sum > 0 ? '<button class="link-btn" id="clNorm">Привести к 100 пропорционально</button>' : '')
    + (!ok ? '<span>Итог диалога всё равно пересчитывается к 100, но веса читаются проще, когда их сумма равна 100.</span>' : '');
  $('clNorm')?.addEventListener('click', () => { scaleWeights(draft.criteria.filter(isScored), 100); renderChecklists(); });
  const dirty = isDirty();
  $('clSave').disabled = !dirty; $('clDiscard').disabled = !dirty;
  $('clDefault').disabled = !!STANDARD && sigOf(draft) === sigOf(STANDARD);
  const nInc = draft.criteria.filter(c => c.include !== false).length;
  $('clMeta').innerHTML = `Действует <b>v${SAVED.version}</b>${SAVED.saved_at ? ` · сохранён ${fmtDate(SAVED.saved_at)}` : ' · стандартный чек-лист хакатона'} · файлы ${esc(CONFIG.criteria_dir || 'checklist_iter1')}/ · в оценке ${nInc} из ${draft.criteria.length} критериев`
    + (dirty ? ' · <span class="unsaved">есть несохранённые изменения</span>' : '');
  $('clDot').hidden = !dirty;
}
function renderCats(){
  $('catList').innerHTML = draft.sections.map(s => {
    const k = draft.criteria.filter(c => c.section === s.id).length;
    return `<div class="cat-row" data-sec="${s.id}"><input class="inp" value="${esc(s.name)}" aria-label="Название категории">
      <span class="cnt">${k ? `${k} ${plural(k, 'критерий', 'критерия', 'критериев')}` : 'пустая'}</span>
      <button class="icon-btn" data-act="delsec" ${k ? 'disabled title="Сначала перенесите критерии в другую категорию"' : 'title="Удалить категорию"'} aria-label="Удалить категорию ${esc(s.name)}">${TRASH}</button></div>`;
  }).join('');
  $('catList').querySelectorAll('.cat-row').forEach(row => {
    const s = draft.sections.find(x => x.id === row.dataset.sec);
    const inp = row.querySelector('input');
    inp.onchange = () => { const v = inp.value.trim(); if (!v) { inp.value = s.name; toast('Название категории не может быть пустым'); return; } s.name = v; renderChecklists(); };
    row.querySelector('[data-act="delsec"]').onclick = () => { draft.sections = draft.sections.filter(x => x !== s); renderChecklists(); };
  });
}
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
/* table edits */
$('clBody').addEventListener('input', e => {
  const tr = e.target.closest('tr[data-id]'), f = e.target.dataset.f; if (!tr || !f) return;
  const c = critById(tr.dataset.id);
  if (f === 'name' || f === 'description' || f === 'na_condition') c[f] = e.target.value;
  else if (f === 'weight') { const v = parseFloat(e.target.value); c.weight = isFinite(v) && v >= 0 ? v : 0; e.target.classList.toggle('bad', !(isFinite(v) && v >= 0)); }
  else return;
  renderClStatus();
});
$('clBody').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const f = e.target.dataset.f; if (!f) return;
  const c = critById(tr.dataset.id);
  if (f === 'name') { c.name = e.target.value.trim(); if (!c.name) e.target.classList.add('bad'); else e.target.classList.remove('bad'); renderCats(); return; }
  if (f === 'section') {
    if (e.target.value === '__new') { e.target.value = c.section; openCats(c.id); return; }
    c.section = e.target.value; renderChecklists(c.id); return;
  }
  if (f === 'answer_type') { setType(c, e.target.value); renderChecklists(c.id); return; }
  if (f === 'scale') {
    const steps = parseSteps(e.target.value);
    if (!steps) { toast('Шкала: минимум две неотрицательные ступени через запятую, например 0, 5, 10'); e.target.value = scaleText(c); return; }
    c.scale_steps = steps; c.scale_max = steps.at(-1); e.target.value = scaleText(c); renderClStatus();
  }
});
$('clBody').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]'), tr = e.target.closest('tr[data-id]'); if (!b || !tr) return;
  const c = critById(tr.dataset.id);
  if (b.dataset.act === 'spec') { openSpecs.has(c.id) ? openSpecs.delete(c.id) : openSpecs.add(c.id); renderChecklists(); return; }
  if (b.dataset.act === 'inc') { c.include = c.include === false; renderChecklists(); return; }
  if (b.dataset.act === 'del') {
    const others = draft.criteria.filter(x => x !== c && isScored(x));
    const canSpread = isScored(c) && c.weight > 0 && others.length;
    const d = await ask(`Удалить «${c.name}»?`,
      `<p>Критерий пропадёт из чек-листа после сохранения. Уже сделанные оценки его сохранят.</p>
       ${canSpread ? `<label class="radio"><input type="checkbox" id="spread" checked><span>Распределить его вес (${fmt.format(c.weight)}) между остальными включёнными критериями пропорционально</span></label>` : ''}`, 'Удалить', true);
    if (!d) return;
    const spread = canSpread && d.querySelector('#spread')?.checked;
    const total = others.reduce((s, x) => s + x.weight, 0) + c.weight;
    draft.criteria = draft.criteria.filter(x => x !== c);
    if (spread) scaleWeights(others, total);
    renderChecklists();
    toast('Критерий удалён. Сохраните чек-лист, чтобы изменение начало действовать');
  }
});
function parseSteps(s){
  const v = [...new Set(String(s).split(/[,;\s]+/).filter(Boolean).map(Number))];
  if (v.length < 2 || v.some(x => !isFinite(x) || x < 0)) return null;
  return v.sort((a, b) => a - b);
}
function setType(c, t){
  const wasFlag = c.answer_type === 'flag', fam = x => x.startsWith('scale') ? 'scale' : 'bool';
  if (c.spec && fam(c.answer_type) !== fam(t))
    toast(t.startsWith('scale') ? 'После сохранения модель будет сразу выбирать ступень шкалы по условию оценки; подкритерии заменятся описаниями ступеней'
                                : 'После сохранения модель будет проверять одно условие оценки вместо ступеней шкалы');
  if (t.endsWith('_na') && !c.na_condition) setTimeout(() => toast('Укажите, когда ставить Н/П'), 2500);
  c.answer_type = t; c.na_allowed = t.endsWith('_na');
  if (t.startsWith('scale')) { if (!c.scale_steps) { c.scale_steps = [0, 5, 10]; c.scale_max = 10; } }
  else { delete c.scale_steps; delete c.scale_max; }
  if (t === 'flag') c.weight = 0;
  else if (wasFlag) toast('Укажите вес критерия');
}
/* categories (dialog). catTarget: criterion id or 'nc' (new-criterion form) that asked for a new category */
let catTarget = null;
const ncSecOptions = sel => draft.sections.map(s => `<option value="${s.id}"${s.id === sel ? ' selected' : ''}>${esc(s.name)}</option>`).join('') + '<option value="__new">+ Новая категория…</option>';
function openCats(target){
  catTarget = target || null;
  renderCats(); $('catName').value = '';
  $('catDlg').showModal();
  if (catTarget) $('catName').focus();
}
$('clCats').onclick = () => openCats(null);
$('catClose').onclick = () => $('catDlg').close();
$('catDlg').addEventListener('close', () => { catTarget = null; });
$('catAdd').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('catName').value.trim(); if (!name) { $('catName').focus(); return; }
  if (draft.sections.some(s => s.name.toLowerCase() === name.toLowerCase())) { toast('Такая категория уже есть'); return; }
  const sec = {id: 'sec_' + Date.now().toString(36), name};
  draft.sections.push(sec);
  $('catName').value = '';
  if (catTarget === 'nc') { $('ncSec').innerHTML = ncSecOptions(sec.id); $('catDlg').close(); return; }
  if (catTarget) { const c = critById(catTarget); if (c) c.section = sec.id; const id = catTarget; $('catDlg').close(); renderChecklists(id); toast(`Категория «${name}» добавлена`); return; }
  renderChecklists();
});
/* add criterion */
function ncCalc(){
  const w = Math.max(0, parseFloat($('ncWeight').value) || 0), flag = $('ncType').value === 'flag';
  const others = draft.criteria.filter(isScored);
  const sum = others.reduce((s, c) => s + c.weight, 0);
  const target = Math.max(0, 100 - w);
  return {w: flag ? 0 : w, flag, others, sum, target};
}
function ncPreview(){
  const {w, flag, others, target} = ncCalc();
  const scale = $('ncType').value.startsWith('scale');
  $('ncScaleF').style.visibility = scale ? 'visible' : 'hidden';
  $('ncNaF').hidden = !$('ncType').value.endsWith('_na');
  $('ncSteps').hidden = !scale;
  if (scale) {
    const steps = parseSteps($('ncScale').value) || [];
    const keep = {}; $('ncSteps').querySelectorAll('input[data-step]').forEach(i => keep[i.dataset.step] = i.value);
    $('ncSteps').innerHTML = steps.length ? '<span class="lbl">Что означает каждая ступень (для модели)</span>' + steps.slice().reverse().map(s =>
      `<label class="step-f"><b>${s}</b><input class="inp" data-step="${s}" value="${esc(keep[s] || '')}" placeholder="${s === steps.at(-1) ? 'Например: всё выполнено' : s === steps[0] ? 'Например: требование не выполнено' : ''}"></label>`).join('') : '';
  }
  $('ncWeight').disabled = flag;
  $('ncRedist').hidden = flag || !others.length || w === 0;
  if ($('ncRedist').hidden) return;
  const tmp = others.map(c => ({name: c.name, old: c.weight, weight: c.weight}));
  scaleWeights(tmp, target);
  const prop = document.querySelector('input[name="redist"]:checked').value === 'prop';
  $('ncPrev').hidden = !prop;
  $('ncPrev').innerHTML = tmp.map(t => `<span>${esc(t.name)}</span><span>${t.old} → <b>${t.weight}</b></span>`).join('')
    + `<span><b>${esc($('ncName').value.trim() || 'Новый критерий')}</b></span><span><b>${w}</b></span>`;
}
$('clAdd').onclick = () => {
  if (!draft.sections.length) { toast('Сначала добавьте категорию'); $('catName').focus(); return; }
  $('critForm').reset(); $('ncSteps').innerHTML = '';
  $('ncSec').innerHTML = ncSecOptions(draft.sections[0]?.id);
  $('ncType').innerHTML = Object.entries(TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  ncPreview();
  $('critDlg').showModal(); $('ncName').focus();
};
['ncWeight', 'ncType', 'ncName', 'ncScale'].forEach(id => $(id).addEventListener('input', ncPreview));
let ncPrevSec = null;
$('ncSec').addEventListener('focus', () => { ncPrevSec = $('ncSec').value; });
$('ncSec').addEventListener('change', () => {
  if ($('ncSec').value !== '__new') { ncPrevSec = $('ncSec').value; return; }
  $('ncSec').value = ncPrevSec || draft.sections[0]?.id || '';
  openCats('nc');
});
$('ncRedist').addEventListener('change', ncPreview);
$('critForm').addEventListener('submit', e => {
  if (e.submitter?.value !== 'save') return;
  const name = $('ncName').value.trim();
  if (!name) { e.preventDefault(); $('ncName').focus(); return; }
  const t = $('ncType').value, {w, others, target} = ncCalc();
  if (!$('ncWeight').disabled && (w > 100 || w < 0)) { e.preventDefault(); toast('Вес от 0 до 100'); return; }
  const c = {id: 'cx_' + Date.now().toString(36), name, section: $('ncSec').value, weight: w, answer_type: t, na_allowed: t.endsWith('_na'),
             include: true, description: $('ncDesc').value.trim(), na_condition: t.endsWith('_na') ? $('ncNa').value.trim() : ''};
  if (!c.description) { e.preventDefault(); $('ncDesc').focus(); toast('Опишите условие оценки: по нему модель будет оценивать критерий'); return; }
  if (t.endsWith('_na') && !c.na_condition) { e.preventDefault(); $('ncNa').focus(); toast('Укажите, когда ставить Н/П'); return; }
  if (t.startsWith('scale')) {
    const steps = parseSteps($('ncScale').value);
    if (!steps) { e.preventDefault(); toast('Шкала: минимум две ступени через запятую, например 0, 5, 10'); return; }
    c.scale_steps = steps; c.scale_max = steps.at(-1);
    c.step_descriptions = {};
    $('ncSteps').querySelectorAll('input[data-step]').forEach(i => { if (i.value.trim()) c.step_descriptions[i.dataset.step] = i.value.trim(); });
  }
  if (!$('ncRedist').hidden && document.querySelector('input[name="redist"]:checked').value === 'prop') scaleWeights(others, target);
  draft.criteria.push(c);
  renderChecklists(c.id);
  toast('Критерий добавлен. Сохраните чек-лист, чтобы он начал действовать');
});
/* save / discard / default */
function validateDraft(){
  if (draft.criteria.some(c => !c.name.trim())) return 'У каждого критерия должно быть название';
  if (!draft.criteria.some(c => isScored(c) && c.weight > 0)) return 'Нужен хотя бы один включённый критерий с весом больше 0';
  if (draft.criteria.some(c => !draft.sections.some(s => s.id === c.section))) return 'У каждого критерия должна быть категория';
  const noNa = draft.criteria.find(c => c.answer_type.endsWith('_na') && !(c.na_condition || '').trim());
  if (noNa) return `«${noNa.name}»: укажите, когда ставить Н/П`;
  return null;
}
$('clSave').onclick = async () => {
  const err = validateDraft(); if (err) { toast(err); return; }
  draft.criteria.forEach(c => c.name = c.name.trim());
  const btn = $('clSave'), prev = SAVED.version;
  btn.disabled = true; btn.textContent = 'Сохраняем…';
  try {
    setSaved(await API.saveChecklist(draft));            // server translates new Russian texts and rewrites checklist_iter1/
    openSpecs.forEach(id => { if (!critById(id)) openSpecs.delete(id); });
    toast(SAVED.version === prev ? `Сохранено в checklist_iter1/. Версия v${SAVED.version}: то, что видит модель, не изменилось`
                                 : `Чек-лист v${SAVED.version} сохранён в checklist_iter1/. «Оценить диалог» теперь использует его`);
  } catch (e) { toast(e.message); }
  btn.textContent = 'Сохранить чек-лист';
  renderChecklists();
};
$('clDiscard').onclick = () => { draft = clone(SAVED); renderChecklists(); toast('Изменения отменены'); };
$('clDefault').onclick = async () => {
  if (!await ask('Вернуть стандартный чек-лист?', '<p>Таблица вернётся к восьми критериям хакатона с исходными весами и правилами из checklist_iter1/standard/. Изменение начнёт действовать после сохранения.</p>', 'Вернуть')) return;
  try { await ensureStandard(); } catch (e) { toast(e.message); return; }
  draft = {...clone(STANDARD), version: SAVED.version, saved_at: SAVED.saved_at, prompt_keys: SAVED.prompt_keys};
  renderChecklists();
};
window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------- rules for the model: every field of the criterion file ----------------
   `spec` is the criterion's JSON file with its English texts translated to Russian by the server. Texts are
   editable here; on save the server translates changed Russian texts back to English into the file.
   Fields that are edited in the table row (name, category, type, scale, weight, switch, condition, N/A) are not
   repeated; identifiers, formulas and numbers are shown read-only. */
const openSpecs = new Set();
const SPEC_IN_ROW = new Set(['name_ru', 'section', 'weight', 'answer_type', 'enabled', 'official_rule', 'order', 'criterion_id']);
const SPEC_IN_ROW_PATHS = new Set(['scale.min', 'scale.max', 'scale.allowed_steps', 'na_gate.question', 'na.gate_question']);
const CODE_KEYS = new Set(['yes_if', 'if', 'formula']);
const PROSE_KEYS = new Set(['question', 'note', 'official_rule', 'instruction', 'pass_if', 'fail_if', 'description', 'gate_question', 'how', 'explanation']);
const READONLY_KEYS = new Set(['name_en', 'schema_version', 'purpose', 'preprocessing_in_code']);
const SCORING_KEYS = new Set(['decision', 'decision_logic', 'scoring', 'affects_score', 'allowed_answers']);
const LABELS = {
  name_en: 'Название (англ., для модели)', schema_version: 'Версия формата', allowed_answers: 'Допустимые ответы',
  na_gate: 'Условие Н/П', na: 'Условие Н/П', na_if: 'Н/П, если', note: 'Примечание', notes: 'Примечания', question: 'Вопрос модели',
  scope: 'Что оценивается', conditions: 'Условия', subcriteria: 'Подкритерии', decision: 'Как считается ответ',
  decision_logic: 'Как считается ступень', yes_if: '«Да», если', else: 'Иначе', scoring: 'Баллы', evidence: 'Доказательства',
  output_note: 'Формат ответа модели', id: 'Код', key: 'Ключ', label_ru: 'Короткое название', pass_if: 'Выполнен, если',
  fail_if: 'Не выполнен, если', on_fail_score: 'Ступень при невыполнении', severity: 'Тяжесть', applies_if: 'Проверяется, если',
  role: 'Роль', scale: 'Шкала', step_descriptions: 'Описание ступеней', min: 'Минимум', max: 'Максимум', allowed_steps: 'Ступени',
  preparation_step: 'Подготовительный шаг', instruction: 'Инструкция', parameters: 'Параметры', value: 'Значение', source: 'Источник',
  rules: 'Правила', type: 'Тип', description: 'Описание', all_pass_score: 'Ступень, если всё выполнено', score: 'Ступень',
  if: 'Если', format: 'Формат', required: 'Обязательно', for_false_condition: 'Если условие не выполнено', for_na: 'Для Н/П',
  for_no: 'Для «Нет»', for_yes: 'Для «Да»', required_for_yes: 'Обязательно для «Да»', on_missing_action: 'Если действия не было',
  on_na: 'Для Н/П', per_gate: 'По подкритериям', display: 'Отображение', affects_score: 'Влияет на итог', official_rule: 'Официальное правило',
  evaluate_first: 'Проверять первым', allowed: 'Н/П допускается', gate_question: 'Вопрос модели', related: 'Связанные критерии',
  channel_overrides: 'Особенности каналов', subcriteria_overrides: 'Изменения подкритериев', optional_audio_checks: 'Проверки по аудио',
  status: 'Статус', items: 'Пункты', how: 'Как', scoring_rule: 'Правило подсчёта', formula: 'Формула',
  step_to_points_before_na_redistribution: 'Баллы за ступень (до перераспределения Н/П)', lapse_count_definition: 'Что считается сбоем',
  hint_from_code: 'Подсказка из кода', termination_events: 'События завершения', client_side: 'Со стороны клиента',
  operator_side: 'Со стороны оператора', voice_rule: 'Правило для звонков', purpose: 'Назначение', preprocessing_in_code: 'Подготовка в коде',
  first_reply_definition: 'Первый ответ', client_language_definition: 'Язык клиента', examples_note: 'О примерах',
  requires_identification_examples: 'Когда нужна идентификация', 'operator discloses': 'Оператор раскрывает',
  'operator performs': 'Оператор выполняет', first_response_threshold: 'Порог первого ответа',
  explicit_wait_gap_seconds: 'Пауза ожидания, сек', 'voice call': 'Звонок', 'agent chat': 'Чат'};
const labelOf = k => LABELS[k] || String(k).replace(/_/g, ' ');
const isProse = (k, parent, v) => typeof v === 'string' && !CODE_KEYS.has(k) &&
  (/_ru$/.test(k) || /\s/.test(v.trim()) || PROSE_KEYS.has(k) || parent === 'step_descriptions');
function badge(k, scope){
  const inPrompt = scope === 'shared' ? k === 'rules' : (SAVED.prompt_keys || []).includes(k);
  return inPrompt ? '<span class="sp-b prompt" title="judge.py передаёт это поле модели">в промпте</span>'
    : SCORING_KEYS.has(k) ? '<span class="sp-b code" title="judge.py считает ответ и баллы по этому полю, модели не передаётся">в расчёте</span>'
    : '<span class="sp-b" title="Модели не передаётся и в расчёте не участвует">справочно</span>';
}
function leafHtml(v, path, scope, k, parent, ro){
  const p = esc(JSON.stringify(path));
  const listItem = typeof k === 'number';
  if (typeof v === 'string' && (listItem ? /\p{L}{3}/u.test(v) && parent !== 'allowed_answers' : isProse(k, parent, v)) && !READONLY_KEYS.has(k) && !READONLY_KEYS.has(path[0])) {
    const rows = Math.max(1, Math.min(6, Math.ceil(v.length / 85)));
    return `<textarea class="inp sp-t" rows="${rows}" data-scope="${scope}" data-path="${p}"${ro ? ' disabled' : ''}>${esc(v)}</textarea>`;
  }
  const shown = v === null ? '—' : v === true ? 'да' : v === false ? 'нет' : Array.isArray(v) ? v.join(', ') : String(v);
  return `<span class="sp-code">${esc(shown)}</span>`;
}
function specHtml(node, path, scope, parent, ro){
  if (Array.isArray(node) && node.every(x => x === null || typeof x !== 'object') && !node.some(x => typeof x === 'string' && /\s/.test(x)) && parent !== 'rules')
    return leafHtml(node, path, scope, parent, null, ro);
  const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  return entries.map(([k, v]) => {
    const full = path.concat(k), dotted = full.join('.');
    if (scope === 'crit' && (path.length === 0 && SPEC_IN_ROW.has(k) || SPEC_IN_ROW_PATHS.has(dotted))) return '';
    const head = typeof k === 'number' ? '' : `<span class="sp-k">${esc(labelOf(k))}${path.length === 0 ? badge(k, scope) : ''}</span>`;
    if (v !== null && typeof v === 'object' && !(Array.isArray(v) && v.every(x => x === null || typeof x !== 'object') && !v.some(x => typeof x === 'string' && /\s/.test(x)) && k !== 'rules')) {
      const inner = specHtml(v, full, scope, typeof k === 'number' ? parent : k, ro);
      if (!inner.trim()) return '';
      return typeof k === 'number' ? `<div class="sp-item">${inner}</div>` : `<div class="sp-group">${head}<div class="sp-v">${inner}</div></div>`;
    }
    return `<div class="sp-row">${head}${leafHtml(v, full, scope, k, parent, ro)}</div>`;
  }).join('');
}
function specPanel(c, on){
  if (!c.spec) return `<div class="spec"><p class="sp-hint">Файл checklist_iter1/&lt;id&gt;.json появится после сохранения чек-листа: условие оценки${c.na_allowed ? ', условие Н/П' : ''}${c.answer_type.startsWith('scale') ? ' и описания ступеней' : ''} будут переведены на английский и станут правилами для модели. Потом здесь можно будет править все поля файла.</p></div>`;
  const saved = SAVED.criteria.find(x => x.id === c.id);
  const typeNote = saved && saved.answer_type !== c.answer_type ? '<p class="sp-hint warn">Тип ответа изменён: после сохранения структура правил обновится под новый тип.</p>' : '';
  return `<div class="spec"><p class="sp-hint">Файл <b>checklist_iter1/${esc(c.id)}.json</b>. Тексты показаны по-русски; изменённые тексты при сохранении переводятся на английский и записываются в файл. «В промпте» — поле уходит модели, «в расчёте» — по нему judge.py считает ответ.</p>${typeNote}
    ${specHtml(c.spec, [], 'crit', null, !on)}</div>`;
}
function setIn(obj, path, v){ path.slice(0, -1).reduce((o, k) => o[k], obj)[path.at(-1)] = v; }
$('clBody').addEventListener('input', e => {
  const t = e.target; if (!t.dataset.path) return;
  const c = critById(t.closest('tr[data-spec]').dataset.spec);
  setIn(c.spec, JSON.parse(t.dataset.path), t.value);
  renderClStatus();
});
$('clShared').addEventListener('input', e => {
  const t = e.target; if (!t.dataset.path) return;
  setIn(draft.shared, JSON.parse(t.dataset.path), t.value);
  renderClStatus();
});
