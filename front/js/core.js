/* CQA core: formatting helpers, app state, dialogue preparation and scoring (same rules as judge.py). */
const clone = o => JSON.parse(JSON.stringify(o));
const fmt = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mmss = s => { s = Math.max(0, Math.round(s)); return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0'); };
function parseTs(ts){
  const m = /^(\d{1,2}):(\d{2})$/.exec(ts);
  if (m) return +m[1]*60 + +m[2];
  return Date.parse(ts.replace(/(\.\d{3})\d*/, '$1')) / 1000;
}

const HOLD_END = /больше не находится на удержании|no longer on hold|завершил разговор/i;
const HOLD_START = /находится на удержании|on hold/i;
const SPEAKER = {client:'Клиент', operator:'Оператор', bot:'Бот', internal:'Оператор, внутренний разговор'};
const LANG = {RU:'Русский', KZ:'Қазақша', EN:'English'};

/* data loaded from the server at start (main.js -> API.bootstrap) */
const DATA = {dialogues: []};
const RECORDS = {};
let REVIEWS = {};                                  // reviews.json: conversation_id -> {appeals, overrides}
let CONFIG = {};
function setDialogues(list){
  DATA.dialogues = list;
  Object.keys(RECORDS).forEach(k => delete RECORDS[k]);
  list.forEach(r => RECORDS[r.conversation_id] = r);
}

let D, msgs = [], total0 = 0, duration = 0, crits = {}, results = {};
/* per-dialogue review state; appeals and decisions are saved to reviews.json, the reviewer's draft stays local */
const stores = {};
const storeOf = id => stores[id] ||= {overrides: clone(REVIEWS[id]?.overrides || {}), appeals: clone(REVIEWS[id]?.appeals || {}),
                                      draft: {}, openSubs: new Set()};
async function saveReview(id){
  const st = storeOf(id);
  REVIEWS[id] = {appeals: clone(st.appeals), overrides: clone(st.overrides)};
  try { await API.saveReview(id, REVIEWS[id]); }
  catch (e) { toast('Не удалось сохранить в reviews.json: ' + e.message); }
}
const hasEval = () => !!(D && D.evaluation);
const state = {follow:true, nowN:null, openSubs:new Set(), role:'qa', selected:null, overrides:{}, appeals:{}, draft:{}, t:0, playing:false, simulated:false};

function prepare(){
  const tr = D.dialogue.transcript;
  const t0 = parseTs(tr[0].timestamp);
  let hold = false, holdId = 0;
  msgs = tr.map((m, i) => {
    const o = {n: i+1, sec: parseTs(m.timestamp) - t0, speaker: m.speaker, text: m.text, hold: null};
    if (m.speaker === 'system') {
      if (HOLD_END.test(m.text)) hold = false;
      else if (HOLD_START.test(m.text)) { hold = true; holdId++; }
    } else if (hold && D.dialogue.channel === 'voice call') { o.speaker = 'internal'; o.hold = holdId; }
    return o;
  });
  msgs.forEach((m, i) => {
    const next = msgs.slice(i+1).find(x => x.sec >= m.sec);
    const est = Math.max(2, m.text.length / 12);
    m.end = Math.min(next ? Math.max(next.sec, m.sec + 1) : m.sec + 3, m.sec + est);
  });
  duration = Math.max(...msgs.map(m => m.end)) + 2;
  crits = {}; results = {};
  D.checklist.criteria.forEach(c => crits[c.id] = c);
  (D.evaluation?.results || []).forEach(r => results[r.criterion] = r);
}

/* ---------------- scoring (same rules as judge.py) ---------------- */
const valueOf = id => (id in state.overrides) ? state.overrides[id].value : (results[id] ? results[id].value : null);
function pointsFor(c, v){
  if (c.answer_type === 'flag' || v === null) return null;
  if (typeof v === 'boolean') return v ? c.weight : 0;
  return Math.round(v / c.scale_max * c.weight * 100) / 100;
}
function totalFor(getV, criteria = D.checklist.criteria){
  let p = 0, w = 0;
  criteria.forEach(c => {
    const pt = pointsFor(c, getV(c.id));
    if (pt === null) return;
    p += pt; w += c.weight;
  });
  return w ? Math.round(p / w * 10000) / 100 : null;
}
function summaryOf(id){
  const ev = getEval(id);
  if (!ev) return {evaluated:false};
  const cl = ev.checklist;
  const res = {}; ev.results.forEach(r => res[r.criterion] = r);
  const st = storeOf(id);
  const eff = cid => (cid in st.overrides) ? st.overrides[cid].value : (res[cid] ? res[cid].value : null);
  const appeals = Object.values(st.appeals);
  return {evaluated:true, total: totalFor(eff, cl.criteria), orig: totalFor(cid => res[cid] ? res[cid].value : null, cl.criteria),
          gross: cl.criteria.some(c => c.answer_type === 'flag' && !!eff(c.id)), version: cl.version, outdated: isOutdated(ev),
          openAppeals: appeals.filter(a => a.status === 'open').length, decided: appeals.filter(a => a.status === 'decided').length,
          errors: ev.results.filter(r => r.error).length};
}
const answerText = (c, v) => v === null ? 'Не применимо' : typeof v === 'boolean'
  ? (c.answer_type === 'flag' ? (v ? 'Есть' : 'Нет') : (v ? 'Да' : 'Нет')) : `${v} из ${c.scale_max}`;
function status(c, v){
  if (v === null) return 'na';
  const pt = pointsFor(c, v);
  return pt === c.weight ? 'full' : pt === 0 ? 'zero' : 'part';
}
const ICON = {
  full:'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  part:'<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>',
  zero:'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>',
  na:'Н/П'};
