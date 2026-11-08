/* ---------------- checklist editor page ---------------- */
const isDirty = () => JSON.stringify(draft) !== JSON.stringify(SAVED);
const critById = id => draft.criteria.find(c => c.id === id);
const TRASH = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>';
const scaleText = c => (c.scale_steps || []).join(', ');
/* A criterion's own questions (conditions / subcriteria of its file, shown in Russian): [{path, text}] */
/* subcriteria of a criterion (its `conditions` or `subcriteria` list in the file copy) and whether the list may change:
   yes/no/flag lists and ordered gates yes, the severity ladder of «Ведение диалога» no (its steps count lapses) */
function subInfo(c){
  const sp = c.spec, key = sp && (sp.conditions ? 'conditions' : sp.subcriteria ? 'subcriteria' : null);
  if (!key) return null;
  return {key, list: sp[key], editable: key === 'conditions' || (sp.decision_logic || {}).type === 'na_gate_then_ordered_gates'};
}
function subNote(c, si){
  const saved = SAVED.criteria.find(x => x.id === c.id), was = saved && saved.spec && saved.spec[si.key];
  const changed = !was || was.map(x => x.id).join() !== si.list.map(x => x.id).join();
  if (si.key === 'subcriteria') return 'Субкритерии проверяются по порядку: первый невыполненный определяет ступень шкалы. У нового субкритерия ступень подбирается автоматически.';
  if (!changed) return '';
  return c.answer_type === 'flag' ? 'После сохранения флаг ставится, если выполнен хотя бы один субкритерий.'
                                  : 'После сохранения «Да» ставится, если выполнены все субкритерии.';
}
function specQuestions(c){
  const sp = c.spec, key = sp && (sp.conditions ? 'conditions' : sp.subcriteria ? 'subcriteria' : null);
  return key ? sp[key].map((x, i) => ({path: [key, i, 'question'], text: x.question || ''})) : [];
}
/* read-only summary on the card face: what the model checks. Edited inside the panel. */
function sumHtml(c){
  const q = specQuestions(c).map(x => x.text.trim()).filter(Boolean);
  if (!q.length) return c.description ? `<span class="sum-lead">Правило:</span> ${esc(c.description)}` : '<span class="sum-empty">Правило пока не задано. Нажмите «Изменить субкритерии».</span>';
  return `<span class="sum-lead">${c.answer_type === 'flag' ? 'Нарушение, если:' : 'Проверяем:'}</span><ul>${q.slice(0, 3).map(t => `<li>${esc(t)}</li>`).join('')}</ul>`
    + (q.length > 3 ? `<span class="sum-more">и ещё ${q.length - 3}</span>` : '');
}
const BADGE = {yes_no: 'Ответ: Да / Нет', yes_no_na: 'Ответ: Да / Нет / Не применимо', scale: 'Оценка по шагам', scale_na: 'Оценка по шагам или Не применимо', flag: 'Флаг нарушения, без баллов'};
/* ordered gates: what a failed subcriterion does to the score */
function failSelect(c, x, i, ro){
  const st = (c.scale_steps || []).slice(0, -1);
  const cur = st.includes(x.on_fail_score) ? x.on_fail_score : st[Math.min(i, Math.max(st.length - 1, 0))];
  return `<label class="cond-fail">если «нет» →<select class="inp" data-sf="fail" aria-label="Что будет, если субкритерий не выполнен"${ro}>${st.map(v => `<option value="${v}"${v === cur ? ' selected' : ''}>ступень ${v}</option>`).join('')}</select></label>`;
}
function panelHtml(c, on, secOpts, typeOpts){
  const ro = on ? '' : ' disabled', scale = c.answer_type.startsWith('scale'), na = c.answer_type.endsWith('_na');
  const si = subInfo(c);
  return `${si ? '' : `<h3>Правило оценки</h3>
    <p class="help">Главное условие для модели: когда ставить «Да», «Нет» или какой шаг шкалы.</p>
    <textarea class="inp rule" rows="3" data-f="description" placeholder="Добавьте условие: когда ставить «Да», «Нет» или Н/П" aria-label="Правило оценки"${ro}>${esc(c.description || '')}</textarea>`}
    ${na ? `<label class="how-f">Когда ставить «Не применимо»<textarea class="inp" rows="2" data-f="na_condition" placeholder="Когда ставить Н/П (вопрос для модели)"${ro}>${esc(c.na_condition || '')}</textarea></label>` : ''}
    ${si ? `<h3>Субкритерии</h3><p class="help">Вопросы, на которые модель отвечает «да» или «нет». Итоговый ответ считает программа.</p>
      <div class="cond-list">${si.list.map((x, i) => `<div class="cond" data-i="${i}"><span class="cond-n">${i + 1}</span><div class="cond-body"><textarea class="inp sp-t" data-scope="crit" data-path="${esc(JSON.stringify([si.key, i, 'question']))}"${ro} placeholder="Вопрос для модели">${esc(x.question || '')}</textarea>${scale && si.key === 'subcriteria' && si.editable ? failSelect(c, x, i, ro) : ''}</div>${si.editable ? `<span class="cond-btns"><button class="icon-btn" data-act="sup" aria-label="Выше"${ro}${i ? '' : ' disabled'}>↑</button><button class="icon-btn" data-act="sdown" aria-label="Ниже"${ro}${i < si.list.length - 1 ? '' : ' disabled'}>↓</button><button class="icon-btn" data-act="sdel" aria-label="Удалить субкритерий"${ro}${si.list.length > 1 ? '' : ' disabled'}>×</button></span>` : ''}</div>`).join('')}</div>
      ${si.editable ? `<button class="btn ghost small add-sub" data-act="sadd"${ro}>+ Добавить субкритерий</button>${subNote(c, si) ? `<p class="help">${subNote(c, si)}</p>` : ''}` : '<p class="help">Список субкритериев этого критерия фиксирован: его ступени зависят от числа сбоев. Тексты можно править.</p>'}` : ''}
    ${scale && c.spec && c.spec.scale && !(si && si.editable && si.key === 'subcriteria') ? `<h3>Что значит каждая ступень</h3><p class="help">Описание для модели: что означает каждая оценка.</p>
      <div class="step-list">${c.scale_steps.slice().reverse().map(v => `<label class="step-f"><b>${v}</b><textarea class="inp sp-t" data-scope="crit" data-path="${esc(JSON.stringify(['scale', 'step_descriptions', String(v)]))}"${ro}>${esc((c.spec.scale.step_descriptions || {})[String(v)] || '')}</textarea></label>`).join('')}</div>` : ''}
    <details class="all-fields" hidden><summary>Все правила для модели (файл критерия)</summary>${specPanel(c, on)}</details>   <!-- expert view of the whole criterion file, hidden from QA -->
    <h3 class="params-h">Параметры критерия</h3>
    <div class="crit-details">
      <label>Категория<select class="inp" data-f="section"${ro}>${secOpts(c.section)}</select><span class="help">В какой блок попадает критерий в итоговой карточке.</span></label>
      <label>Тип ответа<select class="inp" data-f="answer_type"${ro}>${typeOpts(c.answer_type)}</select><span class="help">«Н/П»: критерий не применим к диалогу. Флаг: отметка нарушения без баллов.</span></label>
      ${scale ? `<label>Шаги оценки<input class="inp scale" data-f="scale" value="${scaleText(c)}"${ro}><span class="help">Баллы через запятую, например 0, 5, 10. Верхний шаг даёт полный вес.</span></label>` : ''}
      <div class="del-wrap"><button class="btn ghost" data-act="del"${ro} title="${on ? 'Удалить критерий' : 'Включите критерий, чтобы его удалить'}">${TRASH} Удалить критерий</button></div>
    </div>`;
}
function renderChecklists(flashId){
  const secOpts = sel => draft.sections.map(s => `<option value="${s.id}"${s.id === sel ? ' selected' : ''}>${esc(s.name)}</option>`).join('') + '<option value="__new">+ Новая категория…</option>';
  const typeOpts = sel => Object.entries(TYPES).map(([k, l]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${l}</option>`).join('');
  openSpecs.forEach(id => { if (!critById(id)) openSpecs.delete(id); });      // the open card was deleted or discarded
  const html = [];
  let n = 0;
  draft.sections.forEach(s => {
    const list = draft.criteria.filter(c => c.section === s.id);
    if (!list.length) return;
    html.push(`<h2 class="crit-sec">${esc(s.name)}</h2>`);
    list.forEach(c => {
      n++;
      const on = c.include !== false, flag = c.answer_type === 'flag', open = openSpecs.has(c.id), ro = on ? '' : ' disabled';
      html.push(`<article class="crit${on ? '' : ' off'}${c.id === flashId ? ' flash' : ''}${open ? ' focus' : ''}" data-id="${c.id}">
        <div class="crit-head">
          <span class="crit-n">${n}</span>
          <div class="crit-main">
            <input class="inp name" data-f="name" value="${esc(c.name)}" aria-label="Название критерия"${ro}>
            <div class="crit-sum" data-sum>${sumHtml(c)}</div>
          </div>
          <div class="crit-side">
            ${flag ? '<span class="muted-cell">без баллов</span>' : `<div class="stepper" role="group" aria-label="Вес критерия"><span class="unit unit-l">Вес</span>
              <button data-act="wdec" aria-label="Уменьшить вес"${ro}>−</button>
              <input class="inp w" type="number" min="0" max="100" step="1" data-f="weight" value="${c.weight}" aria-label="Вес в баллах"${ro}>
              <button data-act="winc" aria-label="Увеличить вес"${ro}>+</button><span class="unit">баллов</span></div>`}
            <button class="sw" role="switch" data-act="inc" aria-checked="${on}" aria-label="Учитывать в оценке: ${esc(c.name)}" title="${on ? 'Учитывается в оценке' : 'Не учитывается в оценке'}"><span></span></button>
          </div>
        </div>
        <div class="crit-foot">
          <span class="crit-badge">${BADGE[c.answer_type] || ''}</span>
          <span class="muted-cell" data-share="${c.id}"></span>
          <span class="crit-btns"><button class="btn ghost small" data-act="more" aria-expanded="${open}">${open ? 'Готово' : 'Изменить субкритерии <span class="chev">▾</span>'}</button></span>
        </div>
        ${open ? `<div class="crit-how">${panelHtml(c, on, secOpts, typeOpts)}</div>` : ''}
      </article>`);
    });
  });
  $('clBody').innerHTML = html.join('');
  $('clBackdrop').classList.toggle('on', !!$('clBody').querySelector('.crit.focus'));
  $('clShared').innerHTML = draft.shared ? `<p class="sp-hint">Правила из checklists/shared_rules.json добавляются в начало каждого запроса judge.py, для любого критерия.</p>
    <div class="spec">${specHtml(draft.shared, [], 'shared', null, false)}</div>` : '';
  $('clTrErr').hidden = !SAVED.translation_error;
  $('clTrErr').textContent = SAVED.translation_error ? `Перевод недоступен, часть текстов показана на английском. ${SAVED.translation_error}` : '';
  renderCats(); renderClStatus();
  if (flashId) $('clBody').querySelector(`.crit[data-id="${flashId}"]`)?.scrollIntoView({block: 'center', behavior: 'smooth'});
}
/* focus mode: the open card sits above a dim layer. The layer lets wheel and touch scrolling through;
   a click outside the card, Esc or «Готово» closes it. */
document.body.insertAdjacentHTML('beforeend', '<div class="cl-backdrop" id="clBackdrop"></div>');
const closeFocus = () => { if (!openSpecs.size) return; openSpecs.clear(); renderChecklists(); };
document.addEventListener('click', e => {
  if (!openSpecs.size || e.target.closest('.crit.focus, dialog, .toast')) return;
  e.preventDefault(); e.stopPropagation(); closeFocus();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openSpecs.size && !document.querySelector('dialog[open]')) closeFocus(); });
function renderClStatus(){
  const scored = draft.criteria.filter(isScored), sum = scored.reduce((s, c) => s + (+c.weight || 0), 0);
  $('clBody').querySelectorAll('[data-share]').forEach(td => {
    const c = critById(td.dataset.share);
    td.textContent = c && isScored(c) && sum ? `Даёт ${fmt.format(Math.round(c.weight / sum * 10000) / 100)} из 100 в итоге` : '';
  });
  $('clBody').querySelectorAll('.crit[data-id]').forEach(el => {
    const a = critById(el.dataset.id), b = SAVED.criteria.find(c => c.id === el.dataset.id);
    el.classList.toggle('dirty', !b || JSON.stringify(a) !== JSON.stringify(b));
  });
  const ok = Math.abs(sum - 100) < 0.001, diff = Math.round((100 - sum) * 100) / 100;
  $('clSum').className = 'cl-sum card' + (ok ? '' : ' warn');
  $('clSum').innerHTML = `<span class="sum-main">Сумма весов: <b>${fmt.format(sum)}</b> из 100 ${ok ? '✓' : ''}</span>`
    + (!ok && sum > 0 ? `<span>${diff > 0 ? `Не хватает ${fmt.format(diff)} ${plural(Math.round(diff), 'балла', 'баллов', 'баллов')}.` : `Лишних ${fmt.format(-diff)} ${plural(Math.round(-diff), 'балл', 'балла', 'баллов')}.`} Итог диалога всё равно считается из 100.</span><button class="link-btn" id="clNorm">Привести к 100 автоматически</button>` : '');
  $('clNorm')?.addEventListener('click', () => { scaleWeights(draft.criteria.filter(isScored), 100); renderChecklists(); });
  const dirty = isDirty();
  $('clSave').disabled = !dirty; $('clDiscard').disabled = !dirty;
  $('clDefault').disabled = !!STANDARD && sigOf(draft) === sigOf(STANDARD);
  const nInc = draft.criteria.filter(c => c.include !== false).length;
  $('clMeta').innerHTML = `Действует <b>v${SAVED.version}</b>${SAVED.saved_at ? ` · сохранён ${fmtDate(SAVED.saved_at)}` : ' · стандартный чек-лист хакатона'} · файлы ${esc(CONFIG.criteria_dir || 'checklists')}/ · в оценке ${nInc} из ${draft.criteria.length} критериев`
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
/* card edits */
$('clBody').addEventListener('input', e => {
  const card = e.target.closest('.crit[data-id]'), f = e.target.dataset.f; if (!card || !f) return;
  const c = critById(card.dataset.id);
  if (f === 'name' || f === 'description' || f === 'na_condition') c[f] = e.target.value;
  else if (f === 'weight') { const v = parseFloat(e.target.value); c.weight = isFinite(v) && v >= 0 ? v : 0; e.target.classList.toggle('bad', !(isFinite(v) && v >= 0)); }
  else return;
  if (f === 'description') card.querySelector('[data-sum]').innerHTML = sumHtml(c);
  renderClStatus();
});
$('clBody').addEventListener('change', e => {
  const card = e.target.closest('.crit[data-id]'); if (!card) return;
  const c = critById(card.dataset.id);
  if (e.target.dataset.sf === 'fail') {                    // what a failed subcriterion does to the score
    subInfo(c).list[+e.target.closest('.cond').dataset.i].on_fail_score = +e.target.value;
    renderClStatus(); return;
  }
  const f = e.target.dataset.f; if (!f) return;
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
  const b = e.target.closest('button[data-act]'), card = e.target.closest('.crit[data-id]'); if (!b || !card) return;
  const c = critById(card.dataset.id);
  if (b.dataset.act === 'more') {
    const was = openSpecs.has(c.id); openSpecs.clear(); if (!was) openSpecs.add(c.id);
    renderChecklists();
    if (!was) document.querySelector(`.crit[data-id="${c.id}"]`)?.scrollIntoView({block: 'start', behavior: 'smooth'});
    return;
  }
  if (b.dataset.act === 'wdec' || b.dataset.act === 'winc') {
    c.weight = Math.max(0, Math.min(100, (+c.weight || 0) + (b.dataset.act === 'winc' ? 1 : -1)));
    card.querySelector('input[data-f="weight"]').value = c.weight; renderClStatus(); return;
  }
  if (['sadd', 'sdel', 'sup', 'sdown'].includes(b.dataset.act)) {
    const si = subInfo(c); if (!si || !si.editable) return;
    const L = si.list, i = +b.closest('.cond')?.dataset.i;
    if (b.dataset.act === 'sadd') L.push({id: null, question: ''});
    else if (b.dataset.act === 'sdel') L.splice(i, 1);
    else { const j = b.dataset.act === 'sup' ? i - 1 : i + 1; if (L[j]) [L[i], L[j]] = [L[j], L[i]]; }
    renderChecklists();
    if (b.dataset.act === 'sadd') document.querySelector(`.crit[data-id="${c.id}"] .cond:last-child textarea`)?.focus();
    return;
  }
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
    openSpecs.delete(c.id);
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
  if (fam(c.answer_type) !== fam(t)) {
    const sp = c.spec;
    if (sp && t.startsWith('scale') && sp.conditions) {                  // conditions -> ordered gates
      sp.subcriteria = sp.conditions; delete sp.conditions;
      sp.decision_logic = {type: 'na_gate_then_ordered_gates'}; sp.scale = sp.scale || {step_descriptions: {}};
    } else if (sp && !t.startsWith('scale') && sp.subcriteria) {         // ordered gates -> conditions
      sp.conditions = sp.subcriteria.map(x => ({id: x.id, question: x.question})); delete sp.subcriteria;
      delete sp.decision_logic; delete sp.scale;
    }
    toast(t.startsWith('scale') ? 'Субкритерии станут последовательными проверками: первый невыполненный определит ступень шкалы'
                                : 'Субкритерии станут условиями: «Да» ставится, если выполнены все');
  }
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
  if (t.startsWith('scale')) c.spec = {subcriteria: [{id: null, question: c.description}], decision_logic: {type: 'na_gate_then_ordered_gates'}, scale: {step_descriptions: c.step_descriptions}};
  else c.spec = {conditions: [{id: null, question: c.description}]};          // the typed rule is the first subcriterion
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
    setSaved(await API.saveChecklist(draft));            // server translates new Russian texts and rewrites checklists/
    openSpecs.forEach(id => { if (!critById(id)) openSpecs.delete(id); });
    toast(SAVED.version === prev ? `Сохранено в checklists/. Версия v${SAVED.version}: то, что видит модель, не изменилось`
                                 : `Чек-лист v${SAVED.version} сохранён в checklists/. «Оценить диалог» теперь использует его`);
  } catch (e) { toast(e.message); }
  btn.textContent = 'Сохранить чек-лист';
  renderChecklists();
};
$('clDiscard').onclick = () => { draft = clone(SAVED); renderChecklists(); toast('Изменения отменены'); };
$('clDefault').onclick = async () => {
  if (!await ask('Вернуть стандартный чек-лист?', '<p>Таблица вернётся к восьми критериям хакатона с исходными весами и правилами из checklists/standard/. Изменение начнёт действовать после сохранения.</p>', 'Вернуть')) return;
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
  if (!c.spec) return `<div class="spec"><p class="sp-hint">Файл checklists/&lt;id&gt;.json появится после сохранения чек-листа: условие оценки${c.na_allowed ? ', условие Н/П' : ''}${c.answer_type.startsWith('scale') ? ' и описания ступеней' : ''} будут переведены на английский и станут правилами для модели. Потом здесь можно будет править все поля файла.</p></div>`;
  const saved = SAVED.criteria.find(x => x.id === c.id);
  const typeNote = saved && saved.answer_type !== c.answer_type ? '<p class="sp-hint warn">Тип ответа изменён: после сохранения структура правил обновится под новый тип.</p>' : '';
  return `<div class="spec"><p class="sp-hint">Файл <b>checklists/${esc(c.id)}.json</b>. Тексты показаны по-русски; изменённые тексты при сохранении переводятся на английский и записываются в файл. «В промпте» — поле уходит модели, «в расчёте» — по нему judge.py считает ответ.</p>${typeNote}
    ${specHtml(c.spec, [], 'crit', null, !on)}</div>`;
}
function setIn(obj, path, v){ path.slice(0, -1).reduce((o, k) => o[k], obj)[path.at(-1)] = v; }
$('clBody').addEventListener('input', e => {
  const t = e.target; if (!t.dataset.path) return;
  const card = t.closest('.crit[data-id]'), c = critById(card.dataset.id);
  setIn(c.spec, JSON.parse(t.dataset.path), t.value);
  card.querySelectorAll('[data-path]').forEach(o => { if (o !== t && o.dataset.path === t.dataset.path) o.value = t.value; });   // same text shown twice
  card.querySelector('[data-sum]').innerHTML = sumHtml(c);
  renderClStatus();
});
$('clShared').addEventListener('input', e => {
  const t = e.target; if (!t.dataset.path) return;
  setIn(draft.shared, JSON.parse(t.dataset.path), t.value);
  renderClStatus();
});
