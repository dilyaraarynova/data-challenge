#!/usr/bin/env python3
"""The checklist as the web UI sees it, stored in checklist_iter1/.

Source of truth = the criterion files (English, what judge.py sends to the model) + checklist.json
(checklist name, categories, version history). The UI works in Russian:
  load_checklist()  files -> UI shape; every prose text of a file is translated EN -> RU (`spec`)
  save_checklist()  UI shape -> files; Russian texts the user changed are translated RU -> EN,
                    new criteria get their own file, removed criteria lose theirs
UI criterion: {id, name, section, weight, answer_type, na_allowed, scale_steps, scale_max, include,
               description (= official_rule), na_condition (= N/A gate question), spec (RU copy of the file)}

Versions: a version is a signature of everything the judge sees (texts, weights, types, enabled set,
shared rules). Same content -> same version number; new content -> next number. Each history entry keeps a
snapshot of the checklist, which evaluations made with that version keep showing.
"""
import copy
import hashlib
import json
import re
import threading
from datetime import datetime
from pathlib import Path

import judge
from translator import TranslationError, Translator

CL_DIR = judge.CHECKLIST_DIR
STD_DIR = CL_DIR / "standard"
META_PATH = CL_DIR / "checklist.json"
SHARED_PATH = CL_DIR / "shared_rules.json"

# strings that are expressions/identifiers, never translated
CODE_KEYS = {"yes_if", "if", "formula"}
# strings that are prose even without spaces (single words, empty step descriptions)
PROSE_KEYS = {"question", "note", "official_rule", "instruction", "pass_if", "fail_if", "description",
              "gate_question", "how", "explanation"}
# lists of codes, never translated
LIST_CODES = {"allowed_answers"}
# fields edited in the table row, not in the rules panel
MANAGED_TOP = {"name_ru", "name_en", "section", "weight", "answer_type", "enabled", "official_rule", "order", "criterion_id"}
MANAGED_PATHS = {("scale", "min"), ("scale", "max"), ("scale", "allowed_steps"), ("na_gate", "question"),
                 ("na", "gate_question")}
TYPES = {"yes_no", "yes_no_na", "scale", "scale_na", "flag"}
NA_SCORING = "excluded, weight redistributed"
DEFAULT_EVIDENCE = {"format": "message index + timestamp + short quote",
                    "for_false_condition": "cite the message where the condition was expected to be met",
                    "for_na": "state the N/A reason and cite the message that proves it"}
RULE_QUESTION = "Is the requirement in official_rule fully met by the operator?"
FLAG_QUESTION = "Did the operator commit the violation described in official_rule?"
DIRECT_SCALE = {"type": "direct_scale",
                "description": "The model picks one step of scale.allowed_steps using official_rule and "
                               "scale.step_descriptions."}

LOCK = threading.RLock()
TR = Translator()


class ChecklistError(ValueError):
    """Shown to the user as is (Russian)."""


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- tree helpers
def is_prose(key, parent, value):
    if not isinstance(value, str) or key in CODE_KEYS or key == "name_en" or (isinstance(key, str) and key.endswith("_ru")):
        return False
    return bool(re.search(r"\s", value.strip())) or key in PROSE_KEYS or parent == "step_descriptions"


def prose_leaves(node, path=(), parent=None):
    """(path, text) of every translatable string in a criterion tree."""
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, (dict, list)):
                yield from prose_leaves(v, path + (k,), k)
            elif is_prose(k, parent, v):
                yield path + (k,), v
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, (dict, list)):
                yield from prose_leaves(v, path + (i,), parent)
            elif isinstance(v, str) and parent not in LIST_CODES and re.search(r"[^\W\d_]{3}", v):
                yield path + (i,), v


def ru_leaves(node, path=()):
    """(path, text) of native Russian fields (keys ending in _ru)."""
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, (dict, list)):
                yield from ru_leaves(v, path + (k,))
            elif isinstance(k, str) and k.endswith("_ru") and isinstance(v, str):
                yield path + (k,), v
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from ru_leaves(v, path + (i,))


def get_path(node, path):
    for p in path:
        try:
            node = node[p]
        except (KeyError, IndexError, TypeError):
            return None
    return node


def set_path(node, path, value):
    for p in path[:-1]:
        node = node[p]
    node[path[-1]] = value


def managed(path):
    return path[0] in MANAGED_TOP or path[:2] in MANAGED_PATHS


# --------------------------------------------------------------------------- files
def criteria_files(directory=CL_DIR):
    files = judge.criterion_files(directory)
    crits = {cid: read(p) for cid, p in files.items()}
    return dict(sorted(crits.items(), key=lambda kv: kv[1].get("order", 999))), files


def strip_ru(node):
    if isinstance(node, dict):
        return {k: strip_ru(v) for k, v in node.items() if not (isinstance(k, str) and k.endswith("_ru"))}
    if isinstance(node, list):
        return [strip_ru(v) for v in node]
    return node


def signature(crits, shared):
    """What the judge sees: enabled criteria (without display-only *_ru fields) + shared rules."""
    body = [strip_ru(c) for c in crits.values() if c.get("enabled", True)]
    for c in body:
        c.pop("order", None)
    blob = json.dumps([sorted(body, key=lambda c: c["criterion_id"]), shared.get("rules")], sort_keys=True,
                      ensure_ascii=False)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def na_question(c):
    if c.get("na_gate"):
        return c["na_gate"].get("question") or ""
    if (c.get("na") or {}).get("allowed"):
        return c["na"].get("gate_question") or ""
    return ""


def slim(c):
    """Criterion fields an evaluation snapshot needs (scoring + display)."""
    ui = {"id": c["criterion_id"], "name": c.get("name_ru") or c.get("name_en") or c["criterion_id"],
          "section": c["section"]["id"], "weight": c.get("weight", 0), "answer_type": c["answer_type"],
          "na_allowed": c["answer_type"].endswith("_na"), "include": c.get("enabled", True)}
    if c["answer_type"].startswith("scale"):
        steps = c["scale"]["allowed_steps"]
        ui.update(scale_steps=steps, scale_max=c["scale"].get("max", max(steps)))
    return ui


def sections_of(meta, crits):
    secs = [dict(s) for s in meta.get("sections", [])]
    known = {s["id"] for s in secs}
    for c in crits.values():
        s = c["section"]
        if s["id"] not in known:
            secs.append({"id": s["id"], "name_ru": s.get("name_ru", s["id"])})
            known.add(s["id"])
    return secs


def snapshot(meta, crits, version, saved_at):
    secs = sections_of(meta, crits)
    used = {c["section"]["id"] for c in crits.values() if c.get("enabled", True)}
    return {"name": meta.get("name", "Чек-лист качества"), "version": version, "saved_at": saved_at,
            "sections": [{"id": s["id"], "name": s["name_ru"]} for s in secs if s["id"] in used],
            "criteria": [slim(c) for c in crits.values() if c.get("enabled", True)]}


def sync_meta(saved_at=None):
    """Bring checklist.json in line with the files (also after manual edits of the JSON files).
    Returns (meta, crits, shared)."""
    with LOCK:
        crits, _ = criteria_files()
        shared = read(SHARED_PATH)
        meta = read(META_PATH) if META_PATH.exists() else {
            "purpose": "Checklist metadata for the web UI: name, categories (also empty ones) and version history. "
                       "A version = signature of what the judge sees; evaluations reference it.",
            "name": "Чек-лист качества", "version": None, "saved_at": None, "sections": [], "history": []}
        meta["sections"] = sections_of(meta, crits)
        sig = signature(crits, shared)
        entry = next((h for h in meta["history"] if h["sig"] == sig), None)
        if entry is None:
            version = max((h["version"] for h in meta["history"]), default=0) + 1
            stamp = saved_at or (now() if meta["history"] else None)
            entry = {"version": version, "sig": sig, "saved_at": stamp}
            meta["history"].append(entry)
        elif saved_at:
            entry["saved_at"] = saved_at
        entry["snapshot"] = snapshot(meta, crits, entry["version"], entry["saved_at"])
        meta["version"], meta["saved_at"] = entry["version"], entry["saved_at"]
        old = read(META_PATH) if META_PATH.exists() else None
        if old != meta:
            write(META_PATH, meta)
        return meta, crits, shared


def current_version():
    return sync_meta()[0]["version"]


def version_snapshot(version):
    meta = sync_meta()[0]
    h = next((h for h in meta["history"] if h["version"] == version), None)
    return h["snapshot"] if h else None


# --------------------------------------------------------------------------- files -> UI
def translate_trees(trees):
    """RU copies of the trees (one batched translation for all of them). Returns (copies, error or None)."""
    leaves = [(i, p, v) for i, t in enumerate(trees) for p, v in prose_leaves(t)]
    error = None
    try:
        ru = TR.to_ru([v for _, _, v in leaves])
    except TranslationError as e:
        ru, error = [TR.cached_ru(v) or v for _, _, v in leaves], str(e)
    out = [copy.deepcopy(t) for t in trees]
    for (i, p, _), r in zip(leaves, ru):
        set_path(out[i], p, r)
    return out, error


def to_ui(c, spec_ru):
    ui = slim(c)
    ui["description"] = spec_ru.get("official_rule") or ""
    ui["na_condition"] = (get_path(spec_ru, ("na_gate", "question")) if c.get("na_gate")
                          else get_path(spec_ru, ("na", "gate_question")) if (c.get("na") or {}).get("allowed")
                          else "") or ""
    ui["spec"] = spec_ru
    return ui


def ui_checklist(meta, crits, shared, error=None):
    specs, terr = translate_trees(list(crits.values()) + [shared])
    return {"name": meta.get("name", "Чек-лист качества"), "version": meta["version"], "saved_at": meta["saved_at"],
            "sections": [{"id": s["id"], "name": s["name_ru"]} for s in meta["sections"]],
            "criteria": [to_ui(c, s) for c, s in zip(crits.values(), specs)],
            "shared": specs[-1], "prompt_keys": list(judge.SPEC_KEYS),
            "translation_error": error or terr}


def load_checklist():
    meta, crits, shared = sync_meta()
    return ui_checklist(meta, crits, shared)


def load_standard():
    crits, _ = criteria_files(STD_DIR)
    shared = read(STD_DIR / "shared_rules.json")
    meta = {"name": "Чек-лист качества", "version": None, "saved_at": None, "sections": sections_of({}, crits)}
    out = ui_checklist(meta, crits, shared)
    for c in out["criteria"]:
        c["from_standard"] = True
    return out


# --------------------------------------------------------------------------- UI -> files
def number(v):
    v = float(v)
    return int(v) if v.is_integer() else v


def slug(text, taken):
    base = re.sub(r"[^a-z]+", "_", text.lower()).strip("_")[:40].strip("_") or "criterion"
    s, n = base, 2
    while s in taken:
        s, n = f"{base}_{'abcdefghijklmnopqrstuvwxyz'[n - 2] if n < 28 else n}", n + 1
    return s


def remap_scores(c, old_steps, new_steps):
    """Scale steps changed: move every score of the decision logic to the nearest new step."""
    old_max, new_max = max(old_steps), max(new_steps)

    def snap(v):
        return min(new_steps, key=lambda s: (abs(s - v / old_max * new_max), s))
    logic = c.get("decision_logic") or {}
    if "all_pass_score" in logic:
        logic["all_pass_score"] = new_max
    for r in logic.get("rules", []):
        if "score" in r:
            r["score"] = snap(r["score"])
    for s in c.get("subcriteria", []):
        if "on_fail_score" in s:
            s["on_fail_score"] = snap(s["on_fail_score"])


def ui_items(spec, *keys):
    """The first non-empty list of subcriteria in the UI copy (items with a question), looking at `keys` in order."""
    for k in keys:
        lst = (spec or {}).get(k)
        if isinstance(lst, list):
            items = [x for x in lst if isinstance(x, dict) and (x.get("question") or "").strip()]
            if items:
                return items
    return []


def rule_text(c):
    """official_rule of a criterion made in the UI: generated from its structure (its questions say the rest)."""
    if c.get("subcriteria"):
        return "Evaluate the subcriteria in order; the first failed one fixes the score; if all pass, the score is the maximum."
    if c["answer_type"] == "flag":
        return "Yes (flag raised) if ANY of the listed conditions holds; otherwise No."
    return "Yes only if ALL of the listed conditions hold; otherwise No."


def merge_items(base, key, spec, resolve, name):
    """Subcriteria (`conditions` or `subcriteria`) from the UI copy of the file, matched by id, not by position:
    existing ones keep every field they have (their texts come from the UI), new ones (id null) get only the
    question, removed ones disappear, the order of the UI list is kept. Returns (items, changed)."""
    old_items = base[key]
    ui_items = spec.get(key)
    if not isinstance(ui_items, list):
        return copy.deepcopy(old_items), False
    by_id = {x.get("id"): x for x in old_items}
    out, used = [], set()
    for it in ui_items:
        if not isinstance(it, dict):
            continue
        old = by_id.get(it.get("id"))
        if old is not None and old["id"] not in used:
            used.add(old["id"])
            new = copy.deepcopy(old)
            for path, en in prose_leaves(old):               # texts edited in the panel
                ru = get_path(it, path)
                if isinstance(ru, str):
                    set_path(new, path, resolve(en, ru))
            for path, _ in ru_leaves(old):
                ru = get_path(it, path)
                if isinstance(ru, str):
                    set_path(new, path, ru.strip())
            if "on_fail_score" in old and isinstance(it.get("on_fail_score"), (int, float)) and not isinstance(it.get("on_fail_score"), bool):
                new["on_fail_score"] = it["on_fail_score"]              # «если нет → ступень N», chosen in the UI
            out.append(new)
        else:
            q = (it.get("question") or "").strip()
            if q:
                out.append({"id": None, "question": resolve(None, q),
                            **({"on_fail_score": it["on_fail_score"]} if isinstance(it.get("on_fail_score"), (int, float)) else {})})
    if not out:
        raise ChecklistError(f"«{name}»: нужен хотя бы один субкритерий")
    return out, [x.get("id") for x in out] != [x["id"] for x in old_items]


def build(base, ui, order, sec_names, resolve):
    """One criterion file from the UI row. `base` = current (or standard) file, None for a new criterion.
    `resolve(en_old, ru_new)` -> English text for the Russian one (keeps en_old when the Russian is unchanged)."""
    name = (ui.get("name") or "").strip()
    t = ui.get("answer_type")
    if not name:
        raise ChecklistError("У каждого критерия должно быть название")
    if t not in TYPES:
        raise ChecklistError(f"«{name}»: неизвестный тип ответа {t!r}")
    if ui.get("section") not in sec_names:
        raise ChecklistError(f"«{name}»: у критерия должна быть категория")
    weight = 0 if t == "flag" else number(ui.get("weight") or 0)
    if weight < 0:
        raise ChecklistError(f"«{name}»: вес не может быть отрицательным")
    spec = ui.get("spec") or {}

    if base:
        c = copy.deepcopy(base)
        key = "conditions" if base.get("conditions") else "subcriteria" if base.get("subcriteria") else None
        for path, en in prose_leaves(base):              # texts edited in the rules panel (items: see merge_items)
            if not managed(path) and path[0] != key:
                ru = get_path(spec, path)
                if isinstance(ru, str):
                    set_path(c, path, resolve(en, ru))
        for path, _ in ru_leaves(base):                  # native Russian fields (label_ru …)
            if not managed(path) and path[0] != key:
                ru = get_path(spec, path)
                if isinstance(ru, str):
                    set_path(c, path, ru.strip())
        name_en = base.get("name_en") if base.get("name_ru") == name else resolve(None, name)
        if key:
            items, changed = merge_items(base, key, spec, resolve, name)
            taken = {x["id"] for x in items if x.get("id")}
            if key == "subcriteria" and changed and (base.get("decision_logic") or {}).get("type") != "na_gate_then_ordered_gates":
                raise ChecklistError(f"«{name}»: у этого критерия нельзя менять список субкритериев")
            steps = sorted({number(x) for x in (ui.get("scale_steps") or (base.get("scale") or {}).get("allowed_steps") or [0, 1])})
            for i, it in enumerate(items):
                if it.get("id") is None:                  # new subcriterion
                    n = 1
                    while f"{'check' if key == 'conditions' else 'gate'}_{n}" in taken:
                        n += 1
                    it["id"] = f"{'check' if key == 'conditions' else 'gate'}_{n}"
                    taken.add(it["id"])
                    if key == "subcriteria":
                        it.update(pass_if="Yes.", fail_if="No.")
                        it.setdefault("on_fail_score", steps[min(i, max(len(steps) - 2, 0))])
            c[key] = items
            if key == "conditions" and changed:           # the list changed: "yes" = all hold (flag: any holds)
                ids = [x["id"] for x in items]
                c["decision"] = {**(c.get("decision") or {}), "yes_if": (" OR " if ui.get("answer_type") == "flag" else " AND ").join(ids)}
                c["decision"].setdefault("else", "no")
    else:
        c = {"schema_version": "2.0", "criterion_id": None}
        name_en = resolve(None, name)

    c.update(order=order, section={"id": ui["section"], "name_ru": sec_names[ui["section"]]},
             name_ru=name, name_en=name_en, answer_type=t)
    c["weight"], c["enabled"] = weight, ui.get("include", True) is not False
    rule = resolve(c.get("official_rule"), ui.get("description") or "")
    if rule:
        c["official_rule"] = rule
    else:
        c.pop("official_rule", None)

    na = t.endswith("_na")
    if t in ("yes_no", "yes_no_na", "flag"):
        if not (c.get("conditions") and c.get("decision")):       # new, or was a scale criterion
            old_q = {x["id"]: x["question"] for x in ((base or {}).get("subcriteria") or (base or {}).get("conditions") or [])}
            items = ui_items(spec, "conditions", "subcriteria")
            for k in ("scale", "subcriteria", "decision_logic", "preparation_step", "na", "parameters"):
                c.pop(k, None)
            if items:
                c["conditions"] = [{"id": f"check_{i + 1}", "question": resolve(old_q.get(x.get("id")), x["question"])}
                                   for i, x in enumerate(items)]
            elif rule:
                c["conditions"] = [{"id": "violation_found" if t == "flag" else "rule_met", "question": rule}]
            else:
                raise ChecklistError(f"«{name}»: добавьте хотя бы один субкритерий")
            c["decision"] = {"yes_if": (" OR " if t == "flag" else " AND ").join(x["id"] for x in c["conditions"]), "else": "no"}
        c["allowed_answers"] = ["yes", "no"] + (["na"] if na else [])
        if t == "flag":
            c["affects_score"] = False
            c.pop("scoring", None)
        else:
            c.pop("affects_score", None)
            c["scoring"] = {"yes": weight, "no": 0, **({"na": NA_SCORING} if na else {})}
    else:
        steps = sorted({number(s) for s in ui.get("scale_steps") or []})
        if len(steps) < 2 or steps[0] < 0:
            raise ChecklistError(f"«{name}»: шкала — минимум две неотрицательные ступени")
        if not c.get("decision_logic"):                          # new, or was a yes/no criterion: ordered gates
            old_q = {x["id"]: x["question"] for x in ((base or {}).get("conditions") or (base or {}).get("subcriteria") or [])}
            items = ui_items(spec, "subcriteria", "conditions")
            for k in ("conditions", "decision", "allowed_answers", "affects_score", "scoring"):
                c.pop(k, None)
            if not items and not rule:
                raise ChecklistError(f"«{name}»: добавьте хотя бы один субкритерий")
            subs = []
            for i, x in enumerate(items or [{"question": None}]):
                f = x.get("on_fail_score")
                subs.append({"id": f"gate_{i + 1}",
                             "question": resolve(old_q.get(x.get("id")), x["question"]) if items else rule,
                             "pass_if": "Yes.", "fail_if": "No.",
                             "on_fail_score": f if f in steps[:-1] else steps[min(i, max(len(steps) - 2, 0))]})
            c["subcriteria"] = subs
            c["decision_logic"] = {"type": "na_gate_then_ordered_gates", "all_pass_score": steps[-1]}
        old = c.get("scale") or {}
        if old.get("allowed_steps") and old["allowed_steps"] != steps:
            remap_scores(c, old["allowed_steps"], steps)
        if (c.get("decision_logic") or {}).get("type") == "na_gate_then_ordered_gates":
            for x in c.get("subcriteria", []):
                if x.get("on_fail_score", steps[0]) not in steps[:-1]:
                    raise ChecklistError(f"«{name}»: балл при невыполнении субкритерия должен быть одной из ступеней шкалы, кроме максимальной")
        descs = dict(old.get("step_descriptions") or {})
        for k0, ru in ((spec.get("scale") or {}).get("step_descriptions") or {}).items():       # edited in the card
            k = str(number(k0))
            if isinstance(ru, str) and ru.strip() and number(k0) in steps:
                descs[k] = resolve(descs.get(k), ru)
        for s, ru in (ui.get("step_descriptions") or {}).items():   # new-criterion form
            descs[str(number(s))] = resolve(None, ru)
        if (c.get("decision_logic") or {}).get("type") == "na_gate_then_ordered_gates":
            descs = {}                                    # generated: which subcriterion fails when this step is given
            for st in steps:
                if st == steps[-1]:
                    descs[str(st)] = "All subcriteria passed."
                else:
                    qs = [x["question"] for x in c.get("subcriteria", []) if x.get("on_fail_score") == st]
                    descs[str(st)] = ("The first failed subcriterion is: " + " / ".join(qs)) if qs else ""
        c["scale"] = {"min": steps[0], "max": steps[-1], "allowed_steps": steps,
                      "step_descriptions": {str(s): descs.get(str(s), "") for s in reversed(steps)}}
        new = not c.get("scoring")
        c["scoring"] = {**(c.get("scoring") or {}), "formula": f"points = step / {steps[-1]} * weight",
                        "step_to_points_before_na_redistribution":
                            {str(s): number(round(s / steps[-1] * weight, 2)) for s in reversed(steps)}}
        if na and new:                                 # existing files describe N/A in their `na` block
            c["scoring"]["na"] = NA_SCORING
        elif not na:
            c["scoring"].pop("na", None)

    # N/A gate: consultation-style criteria keep `na`, the others use `na_gate`
    q_ru = (ui.get("na_condition") or "").strip()
    if "na" in c and c.get("subcriteria"):
        if na:
            q = resolve(c["na"].get("gate_question"), q_ru)
            if not q:
                raise ChecklistError(f"«{name}»: укажите, когда ставить Н/П")
            c["na"] = {**c["na"], "allowed": True, "gate_question": q}
            c["na"].setdefault("evaluate_first", True)
        else:
            c["na"] = {"allowed": False}
    elif na:
        g = c.get("na_gate") or {}
        q = resolve(g.get("question"), q_ru)
        if not q:
            raise ChecklistError(f"«{name}»: укажите, когда ставить Н/П")
        c["na_gate"] = {"question": q, "na_if": g.get("na_if", True), **{k: v for k, v in g.items()
                                                                         if k not in ("question", "na_if")}}
        if c.get("decision"):
            c["decision"] = {"na_if": "na_gate", **{k: v for k, v in c["decision"].items() if k != "na_if"}}
    else:
        if "na_gate" in c or c.get("conditions"):
            c["na_gate"] = None
        if c.get("decision"):
            c["decision"].pop("na_if", None)
        if not c.get("subcriteria"):
            c.pop("na", None)
    c.setdefault("evidence", copy.deepcopy(DEFAULT_EVIDENCE))
    if base is None and (c.get("conditions") or c.get("subcriteria")):
        c["official_rule"] = rule_text(c)          # the typed rule became the first subcriterion
    return c


def save_checklist(ui):
    with LOCK:
        crits, files = criteria_files()
        std, _ = criteria_files(STD_DIR)
        shared = read(SHARED_PATH)
        sections = [{"id": s["id"], "name_ru": (s.get("name") or "").strip()} for s in ui.get("sections", [])]
        if any(not s["name_ru"] for s in sections):
            raise ChecklistError("Название категории не может быть пустым")
        sec_names = {s["id"]: s["name_ru"] for s in sections}
        rows = ui.get("criteria") or []
        if not any(r.get("include", True) is not False and r.get("answer_type") != "flag"
                   and float(r.get("weight") or 0) > 0 for r in rows):
            raise ChecklistError("Нужен хотя бы один включённый критерий с весом больше 0")

        def base_of(r):
            if r.get("from_standard") and r["id"] in std:
                return std[r["id"]]
            return crits.get(r["id"]) or std.get(r["id"])

        def run(resolve):
            out = [build(base_of(r), r, i + 1, sec_names, resolve) for i, r in enumerate(rows)]
            sh = copy.deepcopy(shared)
            for path, en in prose_leaves(shared):
                ru = get_path(ui.get("shared") or {}, path)
                if isinstance(ru, str):
                    set_path(sh, path, resolve(en, ru))
            return out, sh

        def known(en_old, ru):
            """English for a Russian text: unchanged text keeps its English, else the cache; None = unknown."""
            ru = (ru or "").strip()
            if not ru:
                return ""
            if ru == en_old or (en_old is not None and TR.cached_ru(en_old) == ru):
                return en_old
            return TR.cached_en(ru)

        need = set()

        def collect(en_old, ru):
            en = known(en_old, ru)
            if en is None:
                need.add(ru.strip())
                return "pending translation"
            return en

        run(collect)                                            # pass 1: which Russian texts are new or changed
        if need:
            try:
                TR.to_en(sorted(need))
            except TranslationError as e:
                raise ChecklistError(f"Не удалось перевести новые тексты на английский: {e}")
        new_crits, new_shared = run(known)                      # pass 2: everything resolved

        taken = set()
        for r, c in zip(rows, new_crits):                       # ids: keep known ones, slug new ones
            if r["id"] in crits or r["id"] in std:
                c["criterion_id"] = r["id"]
            taken.add(c["criterion_id"])
        for c in new_crits:
            if not c["criterion_id"]:
                c["criterion_id"] = slug(c["name_en"], taken | set(crits) | set(std))
                taken.add(c["criterion_id"])

        keep = {c["criterion_id"] for c in new_crits}
        for cid, path in files.items():                         # removed criteria lose their file
            if cid not in keep:
                path.unlink()
        for c in new_crits:
            write(files.get(c["criterion_id"], CL_DIR / f"{c['criterion_id']}.json"), c)
        if new_shared != shared:
            write(SHARED_PATH, new_shared)

        meta = read(META_PATH) if META_PATH.exists() else {"history": []}
        meta["name"] = (ui.get("name") or meta.get("name") or "Чек-лист качества").strip()
        meta["sections"] = sections
        write(META_PATH, meta)
        meta, crits, shared = sync_meta(saved_at=now())
        return ui_checklist(meta, crits, shared)
