"""Bridge between the checklist editor (front/cqa_app_v2_1.html) and judge.py.

The editor stores each criterion as: name, weight, answer_type, scale_steps, ordered `conditions`
(questions the judge answers yes/no), an N/A rule (`na_gate`) and a free-text `hint`.
judge.py works on criterion dicts in the checklist_iter1/*.json shape. This module converts one into the other:

  * built-in c01..c08 that the user did NOT edit (flag `edited` is false) keep their original, hand-tuned
    JSON file (scope notes, c06 lapse rules, ...); only weight and the hint are applied from the editor;
  * built-in criteria that were edited, and every new criterion, are generated from the editor fields:
      yes/no  -> conditions + "all must hold" decision           (+ N/A gate)
      scale   -> ordered gates, first failed gate sets the score (+ N/A gate)
      flag    -> conditions + "any holds" decision, no points
  * criteria switched off (`include` false) are not run.

The model only answers true/false per condition; the answer, step and points are computed by judge.py.
"""
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import judge


def original_file(criterion_id):
    """Hand-tuned criterion file for a built-in id, or None."""
    path = judge.CHECKLIST_DIR / f"{criterion_id}.json"
    return judge.load_json(path) if path.exists() else None


def _pass_scores(ui):
    """Score reached when this and every earlier condition holds (editor semantics). Last one = scale max."""
    steps = ui["scale_steps"]
    n = len(ui["conditions"])
    out = []
    for k, c in enumerate(ui["conditions"]):
        v = c.get("pass_score")
        if k == n - 1:
            out.append(steps[-1])
        else:
            out.append(v if v in steps else steps[min(k + 1, len(steps) - 2)])
    return out


def generate(ui, order):
    """Criterion dict in the checklist_iter1 shape, built only from editor fields."""
    t = ui["answer_type"]
    conds = [c for c in ui.get("conditions", []) if str(c.get("question", "")).strip()]
    if not conds:
        raise ValueError(f"«{ui['name']}»: добавьте хотя бы один субкритерий")
    name = ui["name"].strip() or ui["id"]
    crit = {
        "schema_version": "ui-1", "criterion_id": ui["id"], "order": order,
        "name_ru": name, "name_en": name, "answer_type": t, "weight": ui.get("weight", 0),
        "evidence": {"required": True, "format": "message index + timestamp + short quote",
                     "for_false_condition": "cite the message where the condition was expected to be met",
                     "for_na": "state the N/A reason and cite the message that proves it"},
    }
    if ui.get("hint", "").strip():
        crit["hint"] = ui["hint"].strip()
    if t.endswith("_na") and str(ui.get("na_gate", "")).strip():
        crit["na_gate"] = {"question": ui["na_gate"].strip(), "na_if": True,
                           "note": "Evaluated first. true means the criterion is not applicable."}
    ids = [f"s{i + 1}" for i in range(len(conds))]
    if t == "flag":
        crit.update(
            official_rule=f"{name}: Yes (flag raised) if ANY of the listed conditions holds.",
            weight=0, affects_score=False,
            conditions=[{"id": i, "question": c["question"].strip()} for i, c in zip(ids, conds)],
            decision={"yes_if": " OR ".join(ids), "else": "no"})
    elif t.startswith("yes_no"):
        crit.update(
            official_rule=f"{name}: Yes only if ALL of the listed conditions hold, otherwise No.",
            conditions=[{"id": i, "question": c["question"].strip()} for i, c in zip(ids, conds)],
            decision={"yes_if": " AND ".join(ids), "else": "no"},
            scoring={"yes": crit["weight"], "no": 0})
    elif t.startswith("scale"):
        steps = sorted(set(ui.get("scale_steps") or []))
        if len(steps) < 2:
            raise ValueError(f"«{name}»: у шкалы должно быть минимум два шага")
        ui = {**ui, "scale_steps": steps, "conditions": conds}
        passes = _pass_scores(ui)
        subs = []
        for k, c in enumerate(conds):
            subs.append({"id": ids[k], "question": c["question"].strip(), "pass_if": "Yes.", "fail_if": "No.",
                         "on_fail_score": steps[0] if k == 0 else passes[k - 1]})
        crit.update(
            official_rule=f"{name}: items are checked in order; the first failed item fixes the score.",
            scale={"min": steps[0], "max": steps[-1], "allowed_steps": steps},
            subcriteria=subs,
            decision_logic={"type": "na_gate_then_ordered_gates", "all_pass_score": steps[-1]},
            scoring={"formula": f"points = step / {steps[-1]} * weight"})
    else:
        raise ValueError(f"«{name}»: неизвестный тип ответа {t}")
    return crit


def build_criterion(ui, order):
    """Original JSON if the built-in criterion is untouched, otherwise generated from the editor fields."""
    base = original_file(ui["id"])
    if base is not None and not ui.get("edited"):
        crit = copy.deepcopy(base)
        crit["weight"] = ui.get("weight", crit["weight"]) if crit.get("affects_score", True) else 0
        if isinstance(crit.get("scoring"), dict) and "yes" in crit["scoring"]:
            crit["scoring"]["yes"] = crit["weight"]
        if ui.get("hint", "").strip():
            crit["hint"] = ui["hint"].strip()
        return crit
    return generate(ui, order)


def build_criteria(checklist):
    """Criterion dicts for every included criterion of an editor checklist, in editor order."""
    out = []
    for i, ui in enumerate(c for c in checklist["criteria"] if c.get("include", True)):
        out.append(build_criterion(ui, i + 1))
    if not out:
        raise ValueError("В чек-листе нет включённых критериев")
    return out


def evaluate(record, checklist, model, client, boiler, shared, workers=8):
    """Run judge.py over one dialogue with an editor checklist.
    Returns the evaluation shape the page uses plus `errors`, `total` and `usage` (tokens, cost)."""
    crits = build_criteria(checklist)
    msgs = judge.build_messages_list(record, boiler)

    def run(crit):
        try:
            return judge.judge_one(client, model, crit, shared, record, msgs)
        except Exception as e:  # keep the other criteria, report this one
            return {"criterion": crit["criterion_id"], "error": str(e), "usage": getattr(e, "usage", None)}

    with ThreadPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(run, crits))
    ok = [r for r in res if "error" not in r]
    usage = {"prompt": 0, "completion": 0, "cost": None, "calls": 0}
    for r in res:
        u = r.get("usage") or {}
        usage["prompt"] += u.get("prompt", 0)
        usage["completion"] += u.get("completion", 0)
        usage["calls"] += u.get("calls", 0)
        if u.get("cost") is not None:
            usage["cost"] = (usage["cost"] or 0) + u["cost"]
    return {
        "model": model, "assessed_at": datetime.now().isoformat(timespec="seconds"),
        "results": [{"criterion": r["criterion"], "value": r["value"], "evidence_turns": r["evidence_turns"],
                     "rationale": r["rationale"]} for r in ok],
        "errors": [{"criterion": r["criterion"], "error": r["error"]} for r in res if "error" in r],
        "total": judge.total_score(ok), "usage": usage,
    }
