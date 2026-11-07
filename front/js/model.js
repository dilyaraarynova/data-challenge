/* ---------------- checklist model ----------------
   The saved checklist comes from the server (checklist_iter1/ via checklist_store.py) and is written back by
   «Сохранить чек-лист». Every evaluation keeps a snapshot of the checklist version it was made with, so old
   scores never change when the checklist changes; a dialogue evaluated with an older version can be
   re-evaluated, which replaces its evaluation. Versions are numbered by the server (same content = same number). */
const TYPES = {yes_no: 'Да / Нет', yes_no_na: 'Да / Нет / Н/П', scale: 'Шкала', scale_na: 'Шкала / Н/П', flag: 'Флаг, без баллов'};
let SAVED = null;          // checklist in force (server)
let STANDARD = null;       // standard hackathon checklist, loaded when «Вернуть стандартный» is used
let EVALS = {};            // conversation_id -> evaluation (judge_results.json, UI shape)
let draft = null;          // what the checklist editor shows
function setSaved(cl){ SAVED = cl; draft = clone(cl); }
async function ensureStandard(){ return STANDARD ||= await API.standardChecklist(); }
const isScored = c => c.include !== false && c.answer_type !== 'flag';
/* what the judge sees: included criteria and the categories they use */
function snapshot(cl){
  const criteria = clone(cl.criteria.filter(c => c.include !== false)).map(c => { delete c.spec; return c; });
  return {name: cl.name, version: cl.version, saved_at: cl.saved_at,
          sections: clone(cl.sections.filter(s => criteria.some(c => c.section === s.id))), criteria};
}
/* content signature: used to tell whether the editor differs from the standard checklist */
const sigOf = cl => JSON.stringify([cl.sections.map(x => [x.id, x.name]),
  cl.criteria.map(c => [c.id, c.name, c.description || '', c.na_condition || '', c.section, c.weight, c.answer_type,
                        c.scale_steps || null, c.include !== false, c.spec || null]), cl.shared || null]);

function getEval(id){ return EVALS[id] || null; }
const isOutdated = ev => !!ev && !!SAVED && ev.checklist.version !== SAVED.version;
const fmtDate = s => s ? new Date(s).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';

/* integer weights that keep their proportions and add up to exactly `target` */
function scaleWeights(list, target){
  const sum = list.reduce((s, c) => s + (+c.weight || 0), 0);
  if (!list.length) return;
  const raw = list.map(c => sum ? (+c.weight || 0) * target / sum : target / list.length);
  const fl = raw.map(Math.floor);
  let left = Math.round(target - fl.reduce((a, b) => a + b, 0));
  raw.map((r, i) => [r - fl[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  list.forEach((c, i) => c.weight = fl[i]);
}
