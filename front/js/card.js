/* ---------------- player ---------------- */
const pct = s => (s / duration * 100) + '%';
/* short labels for the timeline flags and chat pills; other criteria use their name */
const SHORT = {contact:'Контакт', needs:'Потребность', identification:'Идентификация', consultation:'Консультация',
  empathy:'Эмпатия', dialogue_management:'Ведение диалога', closing:'Завершение', gross_errors:'Грубая ошибка'};
function renderTrack(){
  // bar layer: hold segments + selected criterion's evidence / checked span
  const layer = $('barLayer'); layer.innerHTML = '';
  const bar = $('bar');
  bar.querySelectorAll('.ev-range').forEach(x => x.remove());
  const holds = {};
  msgs.forEach(m => { if (m.hold) (holds[m.hold] ||= []).push(m); });
  Object.values(holds).forEach(g => {
    const startEv = [...msgs].reverse().find(x => x.n < g[0].n && x.speaker === 'system' && HOLD_START.test(x.text));
    const endEv = msgs.find(x => x.n > g.at(-1).n && x.speaker === 'system' && HOLD_END.test(x.text));
    const a = (startEv || g[0]).sec, b = (endEv || g.at(-1)).sec;
    const h = document.createElement('div'); h.className = 'hold';
    h.style.left = pct(a); h.style.width = pct(b - a); h.title = `Клиент на удержании ${mmss(a)}–${mmss(b)}`;
    layer.appendChild(h);
  });
  const ev = evidenceRange(state.selected);
  [['span','ev-range checked'], ['turns','ev-range']].forEach(([k, cls]) => {
    if (!ev[k]) return;
    const o = document.createElement('div'); o.className = cls;
    o.style.left = pct(ev[k][0]); o.style.width = `max(6px, ${pct(ev[k][1] - ev[k][0])})`;
    bar.insertBefore(o, $('fill'));
  });

  // flags: one per (criterion, evidence turn); stacked in rows when they would overlap
  const box = $('flags'); box.innerHTML = '';
  const width = box.clientWidth || 600, HEAD = 24, ROW = 26;
  const items = [];
  D.checklist.criteria.forEach(c => {
    const r = results[c.id], v = valueOf(c.id);
    if (!r) return;
    const st = c.answer_type === 'flag' ? (v ? 'flagged' : null) : status(c, v);
    if (!st) return;                                   // no gross error -> no flag
    (r.evidence_turns || []).forEach(n => items.push({c, n, st, x: msgs[n-1].sec / duration * width}));
  });
  // selected criterion first, so its flags get the lowest row
  items.sort((a, b) => (b.c.id === state.selected) - (a.c.id === state.selected) || a.x - b.x);
  const rows = [];
  items.forEach(it => {
    let row = rows.findIndex(xs => xs.every(x => Math.abs(x - it.x) >= HEAD));
    if (row === -1) { rows.push([]); row = rows.length - 1; }
    rows[row].push(it.x); it.row = row;
  });
  const nRows = Math.max(1, rows.length);
  $('track').style.setProperty('--flags-h', (nRows * ROW + 10) + 'px');
  items.forEach(it => {
    const b = document.createElement('button');
    const sel = it.c.id === state.selected;
    b.className = `pin ${it.st}${sel ? ' sel' : state.selected ? ' dim' : ''}`;
    b.style.left = (it.x / width * 100) + '%';
    const label = `${SHORT[it.c.id] || it.c.name}: реплика ${it.n}, ${mmss(msgs[it.n-1].sec)}`;
    b.setAttribute('aria-label', label);
    const head = it.st === 'na' ? '<span class="na-t">Н/П</span>' : it.st === 'flagged' ? '!' : ICON[it.st];
    b.innerHTML = `<span class="tip">${esc(label)}</span><span class="head">${head}</span><span class="stem" style="height:${4 + it.row * ROW}px"></span>`;
    b.onclick = () => { state.selected = it.c.id; state.fsVerdictOpen = true; renderAll(); goTo(it.n); };
    box.appendChild(b);
  });
  updateTime();
}
function updateTime(){
  const t = state.t;
  $('time').textContent = `${mmss(t)} / ${mmss(duration)}`;
  $('fill').style.width = pct(t); $('knob').style.left = pct(t);
  $('play').innerHTML = state.playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
  $('play').setAttribute('aria-label', state.playing ? 'Пауза' : 'Воспроизвести');
  const now = [...msgs].reverse().find(m => m.speaker !== 'system' && m.sec <= t);
  document.querySelectorAll('.msg.now').forEach(e => e.classList.remove('now'));
  if (now && (state.playing || t > 0)) document.querySelector(`.msg[data-n="${now.n}"]`)?.classList.add('now');
  if (now && now.n !== state.nowN) { state.nowN = now.n; if (state.playing && state.follow) followNow(); }
  const fb = $('followBtn'); if (fb) fb.hidden = !(state.playing && !state.follow);
}
/* keep the message being played in view; manual scrolling pauses this until "К текущей реплике" */
function followNow(){
  const box = $('msgs');
  let el = box.querySelector(`[data-n="${state.nowN}"]`); if (!el) return;
  el = el.closest('details:not([open])') || el;           // inside a collapsed hold group -> its header
  box.scrollTop = el.offsetTop - box.offsetTop - box.clientHeight / 3;
}
function resumeFollow(){ state.follow = true; followNow(); updateTime(); }
['wheel', 'touchmove'].forEach(ev => $('msgs').addEventListener(ev, () => { if (state.playing) state.follow = false; }, {passive: true}));
$('msgs').addEventListener('keydown', e => { if (state.playing && ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(e.key)) state.follow = false; });
$('followBtn').onclick = resumeFollow;
const audio = $('audio');
function seek(t){
  state.follow = true; state.nowN = null;
  state.t = Math.max(0, Math.min(duration, t));
  if (!state.simulated && audio.readyState > 0) audio.currentTime = state.t;
  updateTime();
}
let last = 0;
function tick(ts){
  if (!state.playing) return;
  if (state.simulated) { state.t += (ts - last) / 1000; last = ts; if (state.t >= duration) { state.t = duration; state.playing = false; } }
  else state.t = audio.currentTime;
  updateTime();
  requestAnimationFrame(tick);
}
$('play').onclick = async () => {
  if (state.playing) { state.playing = false; if (!state.simulated) audio.pause(); updateTime(); return; }
  if (!state.simulated) { try { audio.currentTime = state.t; await audio.play(); } catch { useSimulated(); } }
  state.playing = true; state.follow = true; state.nowN = null; last = performance.now(); requestAnimationFrame(tick);
};
$('bar').onclick = e => { const r = $('bar').getBoundingClientRect(); seek((e.clientX - r.left) / r.width * duration); };
$('bar').onkeydown = e => { if (e.key === 'ArrowRight') seek(state.t + 5); if (e.key === 'ArrowLeft') seek(state.t - 5); };
function useSimulated(){
  state.simulated = true;
  const n = $('audioNote');
  n.hidden = false;
  n.textContent = D.dialogue.audio_url
    ? 'Запись не загрузилась, поэтому шкала идёт по меткам времени расшифровки.'
    : 'У чата нет записи: шкала показывает, кто и когда писал.';
}
audio.onerror = () => { if (!state.simulated) useSimulated(); };
audio.onloadedmetadata = () => { if (isFinite(audio.duration) && audio.duration > 0) { duration = Math.max(duration, audio.duration); renderTrack(); } };
audio.onended = () => { state.playing = false; updateTime(); };

/* ---------------- transcript ---------------- */
function renderTranscript(){
  const box = $('msgs'); box.innerHTML = '';
  let group = null;
  msgs.forEach(m => {
    let parent = box;
    if (m.hold) {
      if (!group || group.dataset.hold != m.hold) {
        group = document.createElement('details'); group.className = 'hold-group'; group.dataset.hold = m.hold;
        const count = msgs.filter(x => x.hold === m.hold).length;
        group.innerHTML = `<summary>Клиент на удержании: оператор консультируется с коллегой (${count} реплик). Клиент этого не слышит, в оценку общения не входит.</summary>`;
        box.appendChild(group);
      }
      parent = group;
    } else if (m.speaker !== 'system') group = null;
    const el = document.createElement(m.speaker === 'system' ? 'div' : 'button');
    el.dataset.n = m.n;
    if (m.speaker === 'system') { el.className = 'msg sys'; el.textContent = m.text; }
    else {
      el.className = 'msg';
      el.innerHTML = `<span class="ts">${mmss(m.sec)}</span><span class="who ${m.speaker}">${SPEAKER[m.speaker] || m.speaker}</span><span class="txt">${esc(m.text)}</span>`;
      el.onclick = () => seek(m.sec);
      el.title = `Реплика ${m.n}. Нажмите, чтобы перейти к этому месту записи`;
    }
    parent.appendChild(el);
  });
  markEvidence();
}
const isVoice = () => D.dialogue.channel === 'voice call';
const UNIT = () => isVoice() ? 'Реплика' : 'Сообщение';
function renderChat(){
  const box = $('msgs'); box.className = 'chat'; box.innerHTML = '';
  let prev = null;
  msgs.forEach(m => {
    if (m.speaker === 'system') {
      const s = document.createElement('div'); s.className = 'sys-pill'; s.dataset.n = m.n; s.textContent = m.text;
      box.appendChild(s); prev = m; return;
    }
    const row = document.createElement('div');
    row.className = 'crow ' + (m.speaker === 'operator' ? 'op' : m.speaker);
    row.dataset.n = m.n;
    const who = m.speaker === 'bot' ? 'Бот' : SPEAKER[m.speaker] || m.speaker;
    row.innerHTML = `<div class="bubble" title="Сообщение ${m.n}"><div class="b-who">${who}</div><div class="b-txt">${esc(m.text)}</div><div class="b-time">${mmss(m.sec)}</div></div><div class="evps" hidden></div>`;
    box.appendChild(row); prev = m;
  });
  markEvidence();
}
function renderPills(){
  const by = {};
  D.checklist.criteria.forEach(c => (results[c.id]?.evidence_turns || []).forEach(n => (by[n] ||= []).push(c)));
  $('msgs').querySelectorAll('.crow').forEach(row => {
    const n = +row.dataset.n, box = row.querySelector('.evps'), cs = by[n] || [];
    box.hidden = !cs.length;
    box.innerHTML = cs.map(c => {
      const v = valueOf(c.id), st = c.answer_type === 'flag' ? (v ? 'zero' : 'full') : status(c, v);
      const label = `${c.name}: ${answerText(c, v)}`;
      return `<button class="evp ${st}${c.id === state.selected ? ' sel' : ''}" data-c="${c.id}" title="${esc(label)}" aria-label="${esc(label)}"><span class="i">${st === 'na' ? 'Н/П' : ICON[st]}</span>${esc(SHORT[c.id] || c.name)}</button>`;
    }).join('');
    box.querySelectorAll('.evp').forEach(b => b.onclick = () => { state.selected = b.dataset.c; state.fsVerdictOpen = true; renderAll(); goTo(n); });
  });
}
const ICON_EXPAND = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6"/></svg>';
const ICON_COLLAPSE = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 9h-5V4M4 11h5v5M11 9l6-6M9 11l-6 6"/></svg>';
const isFs = () => $('transcriptCard').classList.contains('fs');
function setFullscreen(on){
  const card = $('transcriptCard'), btn = $('fsBtn');
  const keep = state.selected && firstTurn(state.selected);
  const what = isVoice() ? 'расшифровку' : 'переписку';
  card.classList.toggle('fs', on);
  document.body.classList.toggle('fs-open', on);
  if (isVoice()) {                       // the player travels with the transcript into fullscreen
    const player = $('player');
    if (on) card.insertBefore(player, $('msgs'));
    else $('viewCard').insertBefore(player, $('viewCard').querySelector('.grid'));
    renderTrack();
  }
  btn.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
  btn.setAttribute('aria-label', on ? `Свернуть ${what}` : `Развернуть ${what} на весь экран`);
  btn.title = on ? 'Свернуть (Esc)' : 'На весь экран';
  if (on) {
    const t = totalFor(valueOf);
    $('fsMeta').textContent = `${$('meta').textContent} · итог ${t === null ? '—' : fmt.format(t)} из 100`;
  }
  renderFsVerdict();
  btn.focus();
  if (keep) goTo(keep);
}
function renderFsVerdict(){
  const box = $('fsVerdict'), id = state.selected, c = crits[id];
  if (!isFs() || !c || !state.fsVerdictOpen) { box.hidden = true; return; }
  const v = valueOf(id), st = c.answer_type === 'flag' ? (v ? 'zero' : 'full') : status(c, v), pt = pointsFor(c, v);
  box.hidden = false; box.className = 'fs-verdict ' + st;
  box.innerHTML = `<button class="x" aria-label="Скрыть пояснение">✕</button>
    <h3><span>${esc(c.name)}</span><span class="pts"><b class="${st}">${c.answer_type === 'flag' ? (v ? 'есть' : 'нет') : pt === null ? 'Н/П' : fmt.format(pt)}</b>${c.answer_type === 'flag' ? '' : ` / ${c.weight}`}</span></h3>
    <div class="sub">${answerText(c, v)}</div>
    <p>${esc(results[id].rationale)}</p>
    <button class="btn ghost" id="fsOpen">Открыть в оценке</button>`;
  box.querySelector('.x').onclick = () => { state.fsVerdictOpen = false; renderFsVerdict(); };
  $('fsOpen').onclick = () => {
    setFullscreen(false);
    document.querySelector('.row[aria-selected="true"]')?.scrollIntoView({block: 'center'});
  };
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && isFs() && !$('appealDlg').open) setFullscreen(false); });
function evidenceRange(id){
  const r = results[id]; if (!r) return {};
  const at = n => msgs[n-1];
  const out = {};
  if (r.evidence_turns?.length) { const a = at(r.evidence_turns[0]), b = at(r.evidence_turns.at(-1)); out.turns = [a.sec, b.end]; }
  if (r.checked_span) { const a = at(r.checked_span[0]), b = at(r.checked_span[1]); out.span = [a.sec, b.end]; }
  return out;
}
function markEvidence(){
  const at = n => $('msgs').querySelector(`[data-n="${n}"]`);
  $('msgs').querySelectorAll('.evidence,.in-span').forEach(e => e.classList.remove('evidence','in-span'));
  const r = results[state.selected]; if (!r) return;
  (r.evidence_turns || []).forEach(n => at(n)?.classList.add('evidence'));
  if (r.checked_span) for (let n = r.checked_span[0]; n <= r.checked_span[1]; n++) at(n)?.classList.add('in-span');
}
function goTo(n){
  const el = $('msgs').querySelector(`[data-n="${n}"]`); if (!el) return;
  const g = el.closest('details'); if (g) g.open = true;
  const box = $('msgs');
  box.scrollTop = el.offsetTop - box.offsetTop - 40;
  if (isVoice()) seek(msgs[n-1].sec);
}

/* ---------------- quality panel ---------------- */
let lastTotal;
function renderScore(){
  const sc0 = $('scorecard');
  if (!hasEval()) {
    sc0.className = 'scorecard';
    sc0.innerHTML = `<svg class="mini" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="none" stroke="var(--line)" stroke-width="5"/></svg>
      <div><div class="sc-cap">Итоговый балл</div><div class="sc-num"><b style="color:var(--muted)">—</b><span>не оценён</span></div></div>`;
    lastTotal = undefined; return;
  }
  const t = totalFor(valueOf), orig = totalFor(id => results[id] ? results[id].value : null);
  const flags = D.checklist.criteria.filter(c => c.answer_type === 'flag');
  const flagC = flags.find(c => valueOf(c.id)) || flags[0];
  const fv = flags.some(c => valueOf(c.id));
  const r = 20, C = 2 * Math.PI * r, frac = (t ?? 0) / 100;
  const sc = $('scorecard');
  sc.className = 'scorecard' + (fv ? ' bad' : '') + (lastTotal !== undefined && lastTotal !== t ? ' changed' : '');
  lastTotal = t;
  sc.innerHTML = `
    <svg class="mini" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="${r}" fill="none" stroke="var(--line)" stroke-width="5"/>
      <circle class="arc" cx="24" cy="24" r="${r}" fill="none" stroke="var(--green)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C * frac} ${C}"/></svg>
    <div><div class="sc-cap">Итоговый балл</div>
      <div class="sc-num"><b>${t === null ? '—' : fmt.format(t)}</b><span>из 100</span></div></div>
    <div class="sc-chips">
      ${flagC ? (fv ? `<button class="chip-s red" id="flagChip">${flags.length > 1 ? esc(flagC.name) : 'Грубая ошибка'}</button>` : `<span class="chip-s green">Грубых ошибок нет</span>`) : ''}
      ${orig !== t ? `<span class="chip-s amber">После апелляции, было <s>${fmt.format(orig)}</s></span>` : ''}
    </div>`;
  sc.setAttribute('aria-label', `Итоговый балл ${t === null ? 'не рассчитан' : fmt.format(t)} из 100${fv ? ', есть грубая ошибка' : ''}`);
  $('flagChip')?.addEventListener('click', () => select(flagC.id));
}
function renderRows(){
  const box = $('rows'); box.innerHTML = '';
  if (!hasEval()) {
    const nC = SAVED.criteria.filter(c => c.include !== false).length;
    const id = D.dialogue.conversation_id, run = RUNNING[id];
    box.innerHTML = `<div class="q-empty"><b>${run ? 'Диалог оценивается' : 'Диалог ещё не оценён'}</b>Оценка пойдёт по действующему чек-листу v${SAVED.version} (${nC} ${plural(nC, 'критерий', 'критерия', 'критериев')}): judge.py, модель ${esc(CONFIG.judge_model || '')}. Здесь появятся баллы, объяснения и реплики-доказательства.
      ${run ? progressHtml(id) : `<div><button class="btn primary" id="runEval"${CONFIG.api_key ? '' : ' disabled title="Нет OPENROUTER_API_KEY в .env"'}>Оценить диалог</button>${canEditChecklists() ? ' <a class="link-btn" href="#checklists" style="margin-left:10px">Открыть чек-лист</a>' : ''}</div>`}</div>`;
    $('runEval')?.addEventListener('click', () => runAssessment(id, $('runEval')));
    return;
  }
  const evc = D.checklist, note = document.createElement('div'); note.className = 'ev-note';
  note.innerHTML = `<span>Чек-лист v${evc.version}${D.evaluation.assessed_at ? ` · оценено ${fmtDate(D.evaluation.assessed_at)}` : ''}</span><span>${esc(D.evaluation.model || '')}</span>`;
  box.appendChild(note);
  if (RUNNING[D.dialogue.conversation_id]) {
    const pr = document.createElement('div'); pr.className = 're-banner';
    pr.innerHTML = `<b>Идёт переоценка</b>Текущая оценка будет заменена, когда judge.py закончит.${progressHtml(D.dialogue.conversation_id)}`;
    box.appendChild(pr);
  } else if (isOutdated(D.evaluation)) {
    const bn = document.createElement('div'); bn.className = 're-banner';
    bn.innerHTML = `<b>Чек-лист изменился</b>Диалог оценён по v${evc.version}, сейчас действует v${SAVED.version}. Переоценка заменит эту оценку новой.
      <div><button class="btn primary" id="reEval">Переоценить по v${SAVED.version}</button></div>`;
    box.appendChild(bn);
    bn.querySelector('#reEval').onclick = e => confirmReassess(D.dialogue.conversation_id, e.currentTarget);
  }
  D.checklist.sections.forEach(sec => {
    const cs = D.checklist.criteria.filter(c => c.section === sec.id);
    if (!cs.length) return;
    let p = 0, w = 0;
    cs.forEach(c => { const pt = pointsFor(c, valueOf(c.id)); if (pt !== null) { p += pt; w += c.weight; } });
    const h = document.createElement('div'); h.className = 'section-h';
    const onlyFlags = cs.every(c => c.answer_type === 'flag');
    h.innerHTML = `<span>${esc(sec.name)}</span><span>${onlyFlags ? 'не влияет на балл' : w ? `${fmt.format(p)} / ${w}` : 'не применимо'}</span>`;
    box.appendChild(h);
    cs.forEach(c => {
      const v = valueOf(c.id), isFlag = c.answer_type === 'flag', st = isFlag ? (v ? 'zero' : 'full') : status(c, v), pt = pointsFor(c, v);
      const changed = c.id in state.overrides && state.overrides[c.id].value !== results[c.id].value;
      const ap = state.appeals[c.id];
      if (!results[c.id]) return;                 // criterion added after this evaluation
      const b = document.createElement('button');
      b.className = 'row'; b.setAttribute('role','option'); b.setAttribute('aria-selected', state.selected === c.id);
      const origPt = pointsFor(c, results[c.id].value);
      const err = results[c.id].error;
      b.innerHTML = `<span class="ico ${st}">${ICON[st]}</span>
        <span>${esc(c.name)}${err ? '<span class="tag err">ошибка модели</span>' : ''}${ap ? `<span class="tag ${ap.status === 'decided' ? 'done' : ''}">${ap.status === 'decided' ? 'решение принято' : 'апелляция'}</span>` : ''}</span>
        <span class="pts">${isFlag ? `<b class="${st}">${v ? 'есть' : 'нет'}</b>` : `${changed ? `<s>${origPt === null ? 'Н/П' : fmt.format(origPt)}</s>` : ''}<b class="${st}">${pt === null ? 'Н/П' : fmt.format(pt)}</b> / ${c.weight}`}</span>`;
      b.onclick = () => select(c.id);
      const wrap = document.createElement('div');
      const line = document.createElement('div'); line.className = 'crit-line';
      const subs = results[c.id].subcriteria;
      const open = state.openSubs.has(c.id);
      if (subs?.length) {
        const tg = document.createElement('button');
        tg.className = 'sub-toggle'; tg.setAttribute('aria-expanded', open);
        tg.setAttribute('aria-label', `${open ? 'Скрыть' : 'Показать'} подкритерии: ${c.name}`); tg.title = open ? 'Скрыть подкритерии' : 'Показать подкритерии';
        tg.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>';
        tg.onclick = () => { open ? state.openSubs.delete(c.id) : state.openSubs.add(c.id); renderRows(); renderDetail(); };
        line.appendChild(tg);
      } else line.appendChild(Object.assign(document.createElement('span'), {className: 'sub-gap'}));
      line.appendChild(b);
      wrap.appendChild(line);
      if (state.selected === c.id) {
        const v = document.createElement('div'); v.id = 'verdict'; v.className = `verdict ${st}`;
        wrap.appendChild(v);
      }
      if (subs?.length && open) {
        const list = document.createElement('div'); list.className = 'subs';
        list.innerHTML = subs.map(s => {
          // state from judge.py: pass / fail / skip (not checked) / info (N/A gate, trigger, chosen step)
          const cls = s.state || (s.value === true ? 'pass' : s.value === false ? 'fail' : 'skip');
          const ic = cls === 'pass' ? ICON.full : cls === 'fail' ? ICON.zero : cls === 'info' ? 'i' : '–';
          const note = cls === 'skip' ? (s.note || 'Не проверялось: оценка уже определена предыдущим пунктом или условие не наступило') : (s.note || '');
          return `<button class="subc" ${s.turn ? `data-go="${s.turn}" title="${UNIT()} ${s.turn}"` : 'tabindex="-1"'}><span class="si ${cls}">${ic}</span><span>${esc(s.label)}${note ? `<span class="note">${esc(note)}</span>` : ''}</span></button>`;
        }).join('');
        list.querySelectorAll('[data-go]').forEach(x => x.onclick = () => { state.selected = c.id; renderAll(); goTo(+x.dataset.go); });
        wrap.appendChild(list);
      }
      box.appendChild(wrap);
    });
  });
}
function firstTurn(id){ const r = results[id]; return r?.evidence_turns?.[0] ?? r?.checked_span?.[0]; }
function select(id){ state.selected = id; renderAll(); const n = firstTurn(id); if (n) goTo(n); }

function renderDetail(){
  const id = state.selected, c = crits[id], r = results[id], box = $('verdict');
  if (!c || !box) return;
  const v = valueOf(id), st = c.answer_type === 'flag' ? (v ? 'zero' : 'full') : status(c, v), ap = state.appeals[id], ov = state.overrides[id];
  const changed = ov && ov.value !== r.value;
  const title = changed ? 'Оценка изменена после апелляции' : c.answer_type === 'flag' ? 'Проверка на грубые ошибки'
    : v === null ? 'Почему не применимо' : st === 'full' ? 'Почему полный балл' : 'Почему снижена оценка';
  const titleFlag = c.answer_type === 'flag' ? (v ? 'Найдена грубая ошибка' : 'Грубых ошибок не найдено') : null;
  const turns = r.evidence_turns || [];
  let html = `<h3>${titleFlag && !changed ? titleFlag : title}</h3>
    ${c.answer_type === 'flag' ? '' : `<div class="sub">${answerText(c, v)}, вес ${c.weight}</div>`}
    <p>${changed ? `<span style="color:var(--muted)">Обоснование модели к исходной оценке:</span> ` : ''}${esc(r.rationale)}</p>
    ${r.error ? `<div class="appeal-box err-box"><b>Ответ модели:</b> ${esc(r.error)}</div>` : ''}
    ${r.client_questions?.length ? `<div class="cq"><div class="lbl">Вопросы клиента, которые нашла модель</div><ul>${r.client_questions.map(q =>
      `<li><span class="cq-tag ${q.tag}">${{main: 'основной', material: 'существенный', secondary: 'второстепенный'}[q.tag] || q.tag}</span>${esc(q.text)}</li>`).join('')}</ul></div>` : ''}`;
  if (turns.length || r.checked_span) {
    html += `<div class="chips">${turns.map(n => `<button class="chip" data-go="${n}">${UNIT()} ${n} · ${mmss(msgs[n-1].sec)}</button>`).join('')}
      ${r.checked_span ? `<button class="chip" data-go="${r.checked_span[0]}" title="Здесь ожидалось действие, которого не было">Проверенный участок ${r.checked_span[0]}–${r.checked_span[1]}</button>` : ''}</div>`;
  }
  if (ap && ap.status === 'decided') {
    html += `<dl class="history"><dt>Исходная оценка</dt><dd>${answerText(c, r.value)}</dd>
      <dt>Апелляция</dt><dd>${esc(ap.comment)}</dd>
      <dt>Решение</dt><dd>${ov.value === r.value ? 'Оценка подтверждена' : 'Оценка изменена'}: ${esc(ov.reason)}</dd>
      <dt>Итог</dt><dd><b>${answerText(c, ov.value)}</b></dd></dl>`;
  } else if (ap && state.role === 'qa') {
    html += `<div class="appeal-box">Апелляция отправлена и ждёт проверяющего.<br><i>${esc(ap.comment)}</i></div>`;
  } else if (ap && state.role === 'reviewer') {
    const cur = id in state.draft ? state.draft[id].value : r.value;
    const opts = c.answer_type === 'flag' || c.answer_type.startsWith('yes_no') ? [true, false] : c.scale_steps.slice().reverse();
    if (c.na_allowed) opts.push(null);
    const preview = totalFor(x => x === id ? cur : valueOf(x));
    html += `<div class="appeal-box"><b>Апелляция:</b> ${esc(ap.comment)}</div>
      <label class="lbl">Оценка после проверки</label>
      <div class="choices">${opts.map(o => `<button class="choice" aria-pressed="${o === cur}" data-val='${JSON.stringify(o)}'>${answerText(c, o)}</button>`).join('')}</div>
      <label class="lbl" for="reason">Причина решения</label>
      <textarea id="reason" placeholder="Обязательно: на чём основано решение">${esc(state.draft[id]?.reason || '')}</textarea>
      <div class="preview">Итог диалога после решения: <b>${preview === null ? '—' : fmt.format(preview)}</b></div>
      <div class="actions"><button class="btn primary" id="decide">${cur === r.value ? 'Подтвердить оценку' : 'Изменить оценку'}</button></div>`;
  }
  if (state.role === 'qa' && !ap && !r.error) html += `<div class="actions">
<button class="btn ghost" id="appealBtn">Оспорить оценку</button></div>`;
  box.innerHTML = html;
  box.querySelectorAll('[data-go]').forEach(b => b.onclick = () => goTo(+b.dataset.go));
  $('appealBtn')?.addEventListener('click', openAppeal);
  box.querySelectorAll('.choice').forEach(b => b.onclick = () => {
    state.draft[id] = {...(state.draft[id] || {}), value: JSON.parse(b.dataset.val), reason: $('reason').value};
    renderDetail();
  });
  $('reason')?.addEventListener('input', e => { state.draft[id] = {value: dv(), ...(state.draft[id] || {}), reason: e.target.value}; });
  function dv(){ return id in state.draft ? state.draft[id].value : r.value; }
  $('decide')?.addEventListener('click', () => {
    const reason = $('reason').value.trim();
    if (!reason) { $('reason').focus(); toast('Укажите причину решения'); return; }
    state.overrides[id] = {value: dv(), reason, at: new Date().toISOString()};
    state.appeals[id].status = 'decided';
    delete state.draft[id];
    saveReview(D.dialogue.conversation_id);
    toast('Решение сохранено в reviews.json, итог пересчитан');
    renderAll();
  });
}

/* ---------------- appeal ---------------- */
function openAppeal(){
  const id = state.selected, c = crits[id], r = results[id];
  $('appealCrit').textContent = `${c.name}: ${answerText(c, r.value)}`;
  const n = (r.evidence_turns || [])[0];
  $('appealQuote').innerHTML = n ? `<b>${UNIT()} ${n}.</b> ${esc(msgs[n-1].text.slice(0, 220))}` : esc(r.rationale);
  $('appealText').value = '';
  $('appealDlg').showModal();
}
$('appealForm').addEventListener('submit', e => {
  if (e.submitter?.value !== 'save') return;
  const text = $('appealText').value.trim();
  if (!text) { e.preventDefault(); $('appealText').focus(); return; }
  state.appeals[state.selected] = {comment: text, status: 'open', at: new Date().toISOString()};
  saveReview(D.dialogue.conversation_id);
  toast('Апелляция отправлена');
  renderAll();
});

/* ---------------- misc ---------------- */
function setRole(role){
  state.role = role;
  $('roleQa').setAttribute('aria-pressed', role === 'qa'); $('roleRev').setAttribute('aria-pressed', role === 'reviewer');
  applyRoleAccess();
  if (!$('viewChecklists').hidden) {
    if (role !== 'reviewer') { location.hash = ''; toast('Чек-листы доступны только проверяющему'); }
    return;
  }
  if ($('viewCard').hidden) { renderList(); return; }
  const open = Object.keys(state.appeals).find(k => state.appeals[k].status === 'open');
  if (role === 'reviewer' && open) state.selected = open;
  renderAll();
}
$('roleQa').onclick = () => setRole('qa'); $('roleRev').onclick = () => setRole('reviewer');
const canEditChecklists = () => state.role === 'reviewer';
function applyRoleAccess(){
  $('navChecklists').hidden = !canEditChecklists();
  document.querySelectorAll('a[href="#checklists"]').forEach(a => a.hidden = !canEditChecklists());
}
let toastT;
function toast(t){ const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400); }

function renderAll(){
  renderScore(); renderRows(); renderDetail(); markEvidence();
  if (isVoice()) renderTrack(); else renderPills();
  renderFsVerdict();
  if (state.selected !== state.revealed) { state.revealed = state.selected; revealSelected(); }
}
/* keep the opened criterion visible inside the score panel (only when that panel scrolls by itself) */
function revealSelected(){
  const q = document.querySelector('.quality'), row = $('verdict')?.previousElementSibling;
  if (!q || !row || q.scrollHeight <= q.clientHeight || getComputedStyle(q).overflowY !== 'auto') return;
  const qr = q.getBoundingClientRect(), rr = row.getBoundingClientRect();
  if (rr.top < qr.top + 60 || rr.top > qr.bottom - 220) q.scrollTop += rr.top - qr.top - 70;
}

/* ---------------- dialogue card ---------------- */
function openDialogue(id){
  if (isFs()) setFullscreen(false);
  stopPlayback();
  const rec = RECORDS[id];
  const ev = getEval(id);
  D = {dialogue: rec, checklist: ev ? ev.checklist : snapshot(SAVED), evaluation: ev};
  const st = storeOf(id);
  Object.assign(state, {overrides: st.overrides, appeals: st.appeals, draft: st.draft, openSubs: st.openSubs,
    selected: null, t: 0, playing: false, simulated: false, fsVerdictOpen: false, nowN: null, follow: true});
  lastTotal = undefined; state.revealed = undefined;
  const qp = document.querySelector('.quality'); if (qp) qp.scrollTop = 0;
  prepare();
  const d = D.dialogue;
  const length = Math.max(...msgs.map(m => m.sec));
  $('meta').textContent = `${isVoice() ? 'Звонок' : 'Чат'} ${d.conversation_id} · ${LANG[d.language] || d.language} · ${mmss(length)}`;
  const msgsBox = $('msgs'); msgsBox.className = 'msgs'; msgsBox.scrollTop = 0;
  $('audioNote').hidden = true;
  $('fsBtn').hidden = false; $('fsBtn').innerHTML = ICON_EXPAND;
  $('fsBtn').onclick = () => setFullscreen(!isFs());
  if (isVoice()) {
    $('player').hidden = false;
    $('transcriptTitle').textContent = 'Расшифровка';
    $('transcriptCard').setAttribute('aria-label', 'Расшифровка');
    $('fsBtn').setAttribute('aria-label', 'Развернуть расшифровку на весь экран');
    audio.removeAttribute('src'); audio.load();
    if (d.audio_url) audio.src = d.audio_url; else useSimulated();
    renderTranscript();
  } else {
    $('player').hidden = true;
    $('transcriptTitle').textContent = 'Переписка';
    $('transcriptCard').setAttribute('aria-label', 'Переписка');
    $('fsBtn').setAttribute('aria-label', 'Развернуть переписку на весь экран');
    renderChat();
  }
  showView('card');
  document.querySelector('main').scrollTop = 0;
  fitGrid();
  // open with no criterion selected; the user picks one explicitly
  renderAll();
}
function stopPlayback(){ if (state.playing) { state.playing = false; try { audio.pause(); } catch {} } }
function showView(v){
  $('viewList').hidden = v !== 'list'; $('viewCard').hidden = v !== 'card'; $('viewChecklists').hidden = v !== 'checklists';
  const cl = v === 'checklists';
  $('navDialogs').toggleAttribute('aria-current', !cl); $('navChecklists').toggleAttribute('aria-current', cl);
  if (cl) $('navChecklists').setAttribute('aria-current', 'page'); else $('navDialogs').setAttribute('aria-current', 'page');
  document.title = v === 'list' ? 'CQA · Диалоги' : cl ? 'CQA · Чек-листы' : `CQA · ${D.dialogue.conversation_id}`;
}
