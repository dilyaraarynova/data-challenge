#!/usr/bin/env python3
"""LLM-as-judge for CQA checklist criteria via the OpenRouter API.

One LLM call per (dialogue, criterion). The model only returns booleans + evidence;
the final answer/step/points are computed here from the criterion file's own rules.
Supported criterion shapes (checklist_iter1/*.json):
  - conditions + boolean decision (AND/OR/NOT) (+ optional na_gate)  e.g. c01, c02, c03, c05, c07, c08
    (c08 is a flag: no points, excluded from the total, reported separately)
  - subcriteria as ordered gates, first failed gate sets score    e.g. c04 (na_gate_then_ordered_gates)
  - subcriteria as severity ladder (critical/major/lapse count)   e.g. c06 (severity_ladder)
A per-dialogue total (0-100) is computed over the criteria that were run, redistributing N/A weight.

Transcript turns are numbered from 1 over the ORIGINAL transcript array (client, bot and system turns included),
as the results appendix (CQA_Student_Guide_Appendix_Results.pdf) requires for `evidence_turns`.

Usage:
    python judge.py                         # all dialogues in test_subset.json, all 8 criteria
    python judge.py --criteria c01_contact c02_needs c04_consultation c06_dialogue_management
    python judge.py --ids p1-ru-010 p4-ru-002 --criteria c01_contact
    python judge.py --dry-run --ids p1-ru-010   # print prompts, no API calls

Submission files (format JSON 1.0, one record per dialogue of the whole set, exactly one model):
    python judge.py --submit dev --models <model> --team-name "<team>"
        -> results/dev/results.json  (all 65 records of dialogues.json)
    python judge.py --submit prod --input prod_dataset.json --models <model> --team-name "<team>"
        -> results/prod/results.json (the 10 control chats, saved from the organisers' API response)

Env (or .env): OPENROUTER_API_KEY (required), OPENROUTER_MODEL (optional default).
"""
import argparse
import ast
import csv
import json
import os
import re
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
CHECKLIST_DIR = ROOT / "checklist_iter1"
DEFAULT_CRITERIA = sorted(p.stem for p in CHECKLIST_DIR.glob("c0*.json"))  # all 8 criteria
DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017"
# keys of the criterion file shown to the model (scoring/decision rules stay in code)
SPEC_KEYS = ("name_en", "official_rule", "na_gate", "na", "scope", "conditions", "preparation_step",
             "scale", "subcriteria", "parameters", "evidence")
HIDDEN_SUB_KEYS = {"on_fail_score", "severity"}
EXPLANATION_LANG = "Russian"  # language of the model's explanations (-> `rationale` in the results file)
# criterion file -> criterion_id required by the results appendix (do not rename)
CRITERION_CODES = {
    "c01_contact": "contact", "c02_needs": "discovery", "c03_identification": "identification",
    "c04_consultation": "consultation", "c05_empathy": "empathy", "c06_dialogue_management": "dialogue",
    "c07_closing": "closing", "c08_gross_errors": "critical",
}
ALLOWED_VALUES = {  # None = N/A
    "contact": {True, False}, "discovery": {True, False, None}, "identification": {True, False, None},
    "consultation": {0, 5, 10, 15, 20, None}, "empathy": {True, False}, "dialogue": {0, 4, 7, 10},
    "closing": {True, False, None}, "critical": {True, False},
}


# --------------------------------------------------------------------------- data
def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_records(path=None):
    """Records from the organisers' API response ({data:{records}}) or from a plain list of records."""
    data = load_json(path or ROOT / "dialogues.json")
    if isinstance(data, list):
        return data
    if data.get("isSuccess") is False:
        sys.exit(f"{path}: API response has isSuccess=false: {data.get('error')}")
    return data["data"]["records"] if "data" in data else data["records"]


def boilerplate_texts(records, min_count=10):
    """Bot messages repeated across the dataset among the first 2 bot turns (AIM greeting, privacy notice)."""
    c = Counter()
    for r in records:
        c.update([m["text"] for m in r["transcript"] if m["speaker"] == "bot"][:2])
    return {t for t, n in c.items() if n >= min_count}


def parse_ts(ts):
    """'MM:SS' (chat) or ISO-8601 with 7-digit fraction + tz (voice) -> (display string, seconds)."""
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", ts)
    if m:
        return ts, int(m.group(1)) * 60 + int(m.group(2))
    m = re.match(r"(.*\.\d{6})\d*(.*)", ts)  # truncate fraction to 6 digits
    try:
        dt = datetime.fromisoformat(m.group(1) + m.group(2) if m else ts)
        return dt.strftime("%H:%M:%S"), dt.timestamp()
    except ValueError:
        return ts, 0.0


HOLD_END = re.compile(r"больше не находится на удержании|no longer on hold|taken off hold|завершил разговор", re.I)
HOLD_START = re.compile(r"находится на удержании|(?:is|placed) on hold", re.I)


def mark_hold_segments(msgs):
    """Voice calls only: everything said between the 'client on hold' event and the 'no longer on hold' event is
    the operator consulting colleagues; the client did not hear it. Mark those non-system messages as
    speaker='internal' (system events stay) so they are never scored as communication with the client.
    A hold ends at the hold-end event or, if the client hangs up while on hold, at the hang-up event."""
    on_hold = False
    for m in msgs:
        if m["speaker"] == "system":
            if HOLD_END.search(m["text"]):
                on_hold = False
            elif HOLD_START.search(m["text"]):
                on_hold = True
        elif on_hold:
            m["speaker"] = "internal"


def build_messages_list(record, boiler):
    """Drop bot boilerplate, merge same-speaker voice fragments. `idx` = ORIGINAL 1-based turn numbers."""
    msgs = []
    for i, m in enumerate(record["transcript"]):
        if m["speaker"] == "bot" and m["text"] in boiler:
            continue
        disp, sec = parse_ts(m["timestamp"])
        msgs.append({"idx": [i + 1], "ts": disp, "sec": sec, "speaker": m["speaker"], "text": m["text"]})
    if record["channel"] == "voice call":
        mark_hold_segments(msgs)
        merged = []
        for m in msgs:
            if merged and merged[-1]["speaker"] == m["speaker"]:
                merged[-1]["idx"] += m["idx"]
                merged[-1]["text"] += " " + m["text"]
            else:
                merged.append(m)
        msgs = merged
    return msgs


def label(m):
    return str(m["idx"][0]) if len(m["idx"]) == 1 else f"{m['idx'][0]}-{m['idx'][-1]}"


def render(msgs):
    return "\n".join(f"[{label(m)}] {m['ts']} {m['speaker']}: {m['text']}" for m in msgs)


def reply_gaps(msgs, threshold):
    """Operator reply gaps (client message -> next operator message) longer than `threshold` seconds."""
    out = []
    for prev, cur in zip(msgs, msgs[1:]):
        if prev["speaker"] == "client" and cur["speaker"] == "operator" and cur["sec"] - prev["sec"] > threshold:
            out.append(f"between [{label(prev)}] and [{label(cur)}]: {int(cur['sec'] - prev['sec'])}s")
    return out


# --------------------------------------------------------------------------- criterion shape helpers
def na_gate_question(crit):
    if crit.get("na_gate"):
        return crit["na_gate"]["question"]
    if crit.get("na", {}).get("allowed"):
        return crit["na"]["gate_question"]
    return None


def items(crit):
    """Booleans the model must return: conditions (yes_no) or subcriteria (gates/ladder)."""
    return crit.get("conditions") or crit.get("subcriteria") or []


def public_spec(crit):
    spec = {k: crit[k] for k in SPEC_KEYS if k in crit}
    if "subcriteria" in spec:
        spec["subcriteria"] = [{k: v for k, v in s.items() if k not in HIDDEN_SUB_KEYS} for s in spec["subcriteria"]]
    return spec


# --------------------------------------------------------------------------- prompts
def output_schema(crit):
    ev = {"index": "integer message index from the [i] label, e.g. 3 (for a merged label like [12-13] use the "
                   "first number, 12)",
          "timestamp": "string", "quote": "short verbatim quote"}
    schema = {}
    if crit.get("preparation_step"):
        schema["client_questions"] = [{"text": "...", "tag": "main|material|secondary"}]
    if na_gate_question(crit):
        schema["na_gate"] = {"value": "true|false (true = N/A condition holds)", "explanation": "1-2 sentences",
                             "evidence": ev}
    key = "conditions" if crit.get("conditions") else "subcriteria"
    body = {}
    for it in items(crit):
        if key == "conditions":
            body[it["id"]] = {"value": "true|false", "explanation": "1-2 sentences", "evidence": ev}
        else:
            e = {"passed": "true if pass_if is satisfied, false if fail_if", "explanation": "1-2 sentences",
                 "evidence": ev}
            if it.get("applies_if"):
                e = {"applies": "true|false (is applies_if met?)", **e,
                     "evidence": "null if applies is false, otherwise: " + json.dumps(ev, ensure_ascii=False)}
            body[it["id"]] = e
    schema[key] = body
    return schema


def build_messages(crit, shared, transcript, record, hints=None):
    gate = na_gate_question(crit)
    sub = bool(crit.get("subcriteria"))
    system = (
        "You are a strict, consistent quality-assurance judge of customer-support operators "
        "at a brokerage (Freedom Broker). You evaluate ONE checklist criterion per request.\n\n"
        "GENERAL RULES\n" + "\n".join(f"- {r}" for r in shared["rules"]) + "\n\n"
        "CRITERION SPEC (JSON)\n" + json.dumps(public_spec(crit), ensure_ascii=False, indent=2) + "\n\n"
        "TASK\n"
        + ("If a preparation_step is defined, do it first (`client_questions`).\n" if crit.get("preparation_step") else "")
        + ("Evaluate the N/A gate first (value=true means the N/A condition holds). Then evaluate every "
           "item independently, as if applicable.\n" if gate else "Evaluate every item independently.\n")
        + ("For each subcriterion set `passed` (true when its pass_if holds, false when fail_if holds); where "
           "`applies_if` exists also set `applies`, and when `applies` is false set `evidence` to null "
           "(never cite an unrelated message).\n" if sub else "")
        + "Give a short `explanation` and `evidence` (message index, timestamp, short verbatim quote) for each. "
        "For a failed item cite where it was expected. Do NOT compute the final score or answer.\n"
        f"Write every `explanation` in {EXPLANATION_LANG}, concisely and factually (it is shown to reviewers); "
        "keep `quote` verbatim in the original language.\n"
        "Reply with ONLY one JSON object of this shape:\n"
        + json.dumps(output_schema(crit), ensure_ascii=False, indent=2)
    )
    user = (f"Dialogue {record['conversation_id']} | channel: {record['channel']} | language: {record['language']}\n\n"
            f"{transcript}")
    if hints:
        user += "\n\nHINTS (computed in code, not hard triggers):\n" + "\n".join(f"- {h}" for h in hints)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# --------------------------------------------------------------------------- strict output schema
EVIDENCE_SCHEMA = {
    "type": "object",
    "properties": {"index": {"type": "integer"}, "timestamp": {"type": "string"}, "quote": {"type": "string"}},
    "required": ["index", "timestamp", "quote"],
    "additionalProperties": False,
}


def _obj(props):
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def response_schema(crit):
    """JSON Schema (strict-mode compatible) of the model's reply, generated from the criterion file."""
    base = {"explanation": {"type": "string"}, "evidence": EVIDENCE_SCHEMA}
    props = {}
    if crit.get("preparation_step"):
        props["client_questions"] = {"type": "array", "items": _obj({
            "text": {"type": "string"},
            "tag": {"type": "string", "enum": ["main", "material", "secondary"]}})}
    if na_gate_question(crit):
        props["na_gate"] = _obj({"value": {"type": "boolean"}, **base})
    body = {}
    for it in items(crit):
        if crit.get("conditions"):
            body[it["id"]] = _obj({"value": {"type": "boolean"}, **base})
        else:
            p = {"passed": {"type": "boolean"}, **base}
            if it.get("applies_if"):  # evidence is null when the item does not apply
                p = {"applies": {"type": "boolean"}, **p,
                     "evidence": {"anyOf": [EVIDENCE_SCHEMA, {"type": "null"}]}}
            body[it["id"]] = _obj(p)
    props["conditions" if crit.get("conditions") else "subcriteria"] = _obj(body)
    return _obj(props)


_TYPES = {"object": dict, "array": list, "string": str}


def validate(value, schema, path="$"):
    """Minimal strict validator for the schema subset above. Raises ValueError on the first violation."""
    if "anyOf" in schema:
        errors = []
        for alt in schema["anyOf"]:
            try:
                return validate(value, alt, path)
            except ValueError as e:
                errors.append(str(e))
        raise ValueError(f"{path}: matches none of the alternatives ({'; '.join(errors)})")
    t = schema["type"]
    if t == "null":
        if value is not None:
            raise ValueError(f"{path}: expected null, got {value!r}")
        return
    if t == "boolean":
        if not isinstance(value, bool):  # "false" (str) or 0/1 must not slip through
            raise ValueError(f"{path}: expected boolean, got {value!r}")
        return
    if t == "integer":
        if not isinstance(value, int) or isinstance(value, bool):  # "10" (str), 10.0 and true are rejected
            raise ValueError(f"{path}: expected integer, got {value!r}")
        return
    if not isinstance(value, _TYPES[t]):
        raise ValueError(f"{path}: expected {t}, got {type(value).__name__}")
    if t == "string" and "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: {value!r} not in {schema['enum']}")
    if t == "array":
        for i, v in enumerate(value):
            validate(v, schema["items"], f"{path}[{i}]")
    if t == "object":
        missing = [k for k in schema["required"] if k not in value]
        extra = [k for k in value if k not in schema["properties"]]
        if missing or extra:
            raise ValueError(f"{path}: missing keys {missing}, unexpected keys {extra}")
        for k, sub in schema["properties"].items():
            validate(value[k], sub, f"{path}.{k}")


def _norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[\"'«»“”]", " ", s)).strip().lower()


def check_evidence(raw, msgs):
    """Soft check (warnings only): cited index exists and the quote appears in the cited message(s)."""
    warnings = []

    def walk(node, path):
        if isinstance(node, dict):
            ev = node.get("evidence")
            if isinstance(ev, dict):
                hit = [m for m in msgs if ev["index"] in m["idx"]]  # merged voice turns keep all original indices
                if not hit:
                    warnings.append(f"{path}: cited index {ev['index']} not in transcript (or removed as bot boilerplate)")
                else:
                    text = _norm(" ".join(m["text"] for m in hit))
                    for part in re.split(r"\.\.\.|…", ev["quote"]):
                        part = _norm(part)
                        if len(part) >= 3 and part not in text:
                            warnings.append(f"{path}: quote not found in [{ev['index']}]: {part[:60]!r}")
                            break
            for k, v in node.items():
                if k != "evidence":
                    walk(v, f"{path}.{k}")

    walk(raw, "$")
    return warnings


# --------------------------------------------------------------------------- LLM
def make_client():
    from openai import OpenAI
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("OPENROUTER_API_KEY is not set (put it in .env or the environment).")
    return OpenAI(base_url="https://openrouter.ai/api/v1", api_key=key)


def extract_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


MODE = {}  # model -> "json_schema" (strict, enforced by provider) or "json_object" (fallback); filled lazily


def check_reply(crit, out):
    """Semantic checks beyond the JSON Schema. Raises ValueError (-> retry) or normalises in place:
    a subcriterion that does not apply must have evidence=null, one that applies must have evidence."""
    for s in crit.get("subcriteria", []):
        if s.get("applies_if"):
            it = out["subcriteria"][s["id"]]
            if it["applies"] and it["evidence"] is None:
                raise ValueError(f"subcriteria.{s['id']}: applies=true but evidence is null")
            if not it["applies"]:
                it["evidence"] = None


class LLMError(RuntimeError):
    """Call failed after all retries; `usage` still holds what the failed attempts cost."""

    def __init__(self, msg, usage):
        super().__init__(msg)
        self.usage = usage


def add_usage(acc, u):
    """Accumulate tokens and OpenRouter's reported cost (usage.cost, requested via usage.include)."""
    if not u:
        return
    acc["prompt"] += u.prompt_tokens or 0
    acc["completion"] += u.completion_tokens or 0
    cost = getattr(u, "cost", None)
    if cost is not None:
        acc["cost"] = (acc["cost"] or 0) + float(cost)


def call_llm(client, model, messages, schema, check=None, retries=3):
    """Ask for strict structured output; fall back to json_object if the model/provider rejects json_schema.
    Every reply is validated against `schema` (+ optional `check`) in code and retried on violation, so nothing
    is scored on bad output. Returns (reply, usage); usage covers ALL attempts of this job (retries cost money):
    prompt/completion tokens, cost in USD (None if the API reported none), latency_s (time spent inside API
    calls) and calls."""
    from openai import BadRequestError, NotFoundError
    usage = {"prompt": 0, "completion": 0, "cost": None, "latency_s": 0.0, "calls": 0}
    last = None
    attempt = 0
    while attempt < retries:
        mode = MODE.setdefault(model, "json_schema")
        kwargs = {"response_format": {"type": "json_object"}, "extra_body": {"usage": {"include": True}}}
        if mode == "json_schema":
            kwargs = {
                "response_format": {"type": "json_schema",
                                    "json_schema": {"name": "verdict", "strict": True, "schema": schema}},
                # only route to providers that honour json_schema; ask OpenRouter to report the cost
                "extra_body": {"provider": {"require_parameters": True}, "usage": {"include": True}},
            }
        try:
            usage["calls"] += 1
            t0 = time.perf_counter()
            try:
                resp = client.chat.completions.create(model=model, messages=messages, temperature=0, **kwargs)
            finally:
                usage["latency_s"] += time.perf_counter() - t0
            add_usage(usage, resp.usage)
            out = extract_json(resp.choices[0].message.content or "")
            validate(out, schema)
            if check:
                check(out)
            return out, usage
        except (BadRequestError, NotFoundError) as e:
            if mode == "json_schema":  # structured outputs unsupported here -> permanent fallback for this model
                MODE[model] = "json_object"
                print(f"[{model}] json_schema rejected ({str(e)[:120]}); falling back to json_object",
                      file=sys.stderr)
                continue  # does not consume a retry
            last = e
        except Exception as e:  # network, rate limit, invalid JSON, schema violation
            last = e
        attempt += 1
        time.sleep(2 ** attempt)
    raise LLMError(f"LLM call failed after {retries} attempts: {last}", usage)


# --------------------------------------------------------------------------- scoring (in code)
def sub_active(sub, raw_item, record):
    """False if the subcriterion is not evaluated: voice auto-pass rule, or applies_if not met."""
    if sub.get("voice_rule") and record["channel"] == "voice call" and "auto-pass" in sub["voice_rule"]:
        return False
    return not (sub.get("applies_if") and not raw_item["applies"])


def evaluate_subs(crit, raw, record):
    """passed[id] = True/False, or None when the item is inactive or comes after an early stop.
    Early stop: a failed gate (ordered gates) or a failed critical/major item (severity ladder) already fixes
    the score, so every later item is ignored; that keeps contradictory sub-verdicts out of the result."""
    gates = crit["decision_logic"]["type"] == "na_gate_then_ordered_gates"
    passed, stopped = {}, False
    for s in crit["subcriteria"]:
        item = raw["subcriteria"][s["id"]]
        if stopped or not sub_active(s, item, record):
            passed[s["id"]] = None
            continue
        passed[s["id"]] = item["passed"]
        if not item["passed"] and (gates or s.get("severity") != "lapse"):
            stopped = True
    return passed


def eval_bool(expr, env):
    """Safely evaluate 'a AND (NOT b OR c)' over a dict of booleans."""
    py = re.sub(r"(?<![A-Za-z_])(AND|OR|NOT)(?![A-Za-z_])", lambda m: m.group(1).lower(), expr)

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.BoolOp):
            vals = (ev(v) for v in n.values)
            return all(vals) if isinstance(n.op, ast.And) else any(vals)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not):
            return not ev(n.operand)
        if isinstance(n, ast.Name):
            return env.get(n.id, False)
        raise ValueError(f"unsupported expression: {expr}")
    return ev(ast.parse(py, mode="eval"))


def decide(crit, raw, record):
    """Apply the criterion's own decision rules to the model's booleans -> answer/step/points."""
    na = bool(raw.get("na_gate", {}).get("value")) if na_gate_question(crit) else False
    res = {"weight": crit["weight"], "step": None, "answer": None, "points": None}

    if na:
        res["answer"] = "na"
    elif crit.get("decision"):                                   # yes/no: "a AND b"
        conds = {c["id"]: bool(raw["conditions"].get(c["id"], {}).get("value")) for c in crit["conditions"]}
        res["answer"] = "yes" if eval_bool(crit["decision"]["yes_if"], conds) else "no"
        if crit.get("affects_score", True):                      # c08 is a flag: no points
            res["points"] = crit["scoring"][res["answer"]]
        res["conditions"] = conds
    else:                                                        # scale criteria
        subs = crit["subcriteria"]
        passed = evaluate_subs(crit, raw, record)
        logic = crit["decision_logic"]
        if logic["type"] == "na_gate_then_ordered_gates":
            step = logic["all_pass_score"]
            for s in subs:
                if passed[s["id"]] is False:
                    step = s["on_fail_score"]
                    break
        elif logic["type"] == "severity_ladder":
            lapses = sum(1 for s in subs if s.get("severity") == "lapse" and passed[s["id"]] is False)
            step = None
            for rule in logic["rules"]:
                cond = rule.get("if")
                if cond is None:                                 # else branch
                    step = rule["score"]
                elif (m := re.fullmatch(r"(\S+) fails", cond)):
                    if passed.get(m.group(1)) is False:
                        step = rule["score"]
                elif (m := re.fullmatch(r"lapse_count (>=|==) (\d+)", cond)):
                    n = int(m.group(2))
                    if (lapses >= n) if m.group(1) == ">=" else (lapses == n):
                        step = rule["score"]
                else:
                    raise ValueError(f"unsupported rule: {cond}")
                if step is not None:
                    break
        else:
            raise ValueError(f"unsupported decision_logic type: {logic['type']}")
        res["step"] = step
        res["answer"] = str(step)
        res["points"] = round(step / crit["scale"]["max"] * crit["weight"], 2)
        res["passed"] = passed
    return res


def decisive_ids(crit, res):
    """Items that determined the verdict (cited in rationale / evidence_turns).
    N/A -> the gate. Yes/no -> items whose flip would change the answer. Gates -> first failed gate.
    Ladder -> failed items. If nothing failed (full marks) -> all active items (never inactive/skipped ones)."""
    if res["answer"] == "na":
        return ["na_gate"]
    if crit.get("decision"):
        conds, base = res["conditions"], res["answer"]
        out = []
        for cid, v in conds.items():
            flipped = {**conds, cid: not v}
            if ("yes" if eval_bool(crit["decision"]["yes_if"], flipped) else "no") != base:
                out.append(cid)
        return out or list(conds)
    passed = res["passed"]
    failed = [i for i, p in passed.items() if p is False]
    return failed or [i for i, p in passed.items() if p is not None]


def turns_for(raw, item_ids, crit, msgs, n_turns):
    """evidence_turns: 1-based original transcript numbers cited by the given items (merged voice turns expand)."""
    turns = set()
    for iid in item_ids:
        item = raw["na_gate"] if iid == "na_gate" else raw["conditions" if crit.get("conditions") else "subcriteria"][iid]
        n = item["evidence"]["index"]
        hit = [m for m in msgs if n in m["idx"]]
        if hit:
            turns.update(hit[0]["idx"])
        elif 1 <= n <= n_turns:
            turns.add(n)
    return sorted(turns)


def rationale_text(raw, item_ids, crit, limit=600):
    parts = []
    for iid in item_ids:
        item = raw["na_gate"] if iid == "na_gate" else raw["conditions" if crit.get("conditions") else "subcriteria"][iid]
        e = item["explanation"].strip()
        if e and e not in parts:
            parts.append(e)
    text = " ".join(parts)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def result_value(res):
    """Appendix `value`: true/false (yes/no), null (N/A), or the scale step."""
    if res["answer"] == "na":
        return None
    if res["step"] is not None:
        return res["step"]
    return res["answer"] == "yes"


def total_score(results):
    """0-100 over the criteria run: drop N/A, redistribute weight, round to 2 decimals (None if nothing applies)."""
    ok = [r for r in results if "error" not in r and r["answer"] != "na" and r["points"] is not None]
    wsum = sum(r["weight"] for r in ok)
    if not ok or wsum == 0:
        return None
    return round(sum(r["points"] for r in ok) / wsum * 100, 2)


def usage_stats(results, wall_s, n_dialogues):
    """Tokens, price and inference time of one model run. Failed jobs are included (their attempts cost money).
    Latency is per job (criterion call, all attempts); wall time is the elapsed time of the whole run."""
    def agg(rows):
        us = [r.get("usage") or {} for r in rows]
        inp, out = sum(u.get("prompt", 0) for u in us), sum(u.get("completion", 0) for u in us)
        costs = [u["cost"] for u in us if u.get("cost") is not None]
        lat = sorted(u.get("latency_s", 0.0) for u in us)
        return {
            "jobs": len(rows), "api_calls": sum(u.get("calls", 0) for u in us),
            "input_tokens": inp, "output_tokens": out, "total_tokens": inp + out,
            "cost_usd": round(sum(costs), 6) if costs else None,
            "jobs_without_cost": len(rows) - len(costs),
            "latency_s": {"total": round(sum(lat), 2), "mean": round(sum(lat) / len(lat), 2) if lat else 0,
                          "median": round(lat[len(lat) // 2], 2) if lat else 0,
                          "p95": round(lat[min(len(lat) - 1, int(len(lat) * 0.95))], 2) if lat else 0,
                          "max": round(lat[-1], 2) if lat else 0},
        }
    stats = agg(results)
    stats["wall_time_s"] = round(wall_s, 2)
    stats["dialogues"] = n_dialogues
    if stats["cost_usd"] is not None:
        stats["cost_per_dialogue_usd"] = round(stats["cost_usd"] / n_dialogues, 6)  # all calls of one dialogue
    stats["per_criterion"] = {c: agg([r for r in results if r["criterion"] == c])
                              for c in sorted({r["criterion"] for r in results})}
    return stats


def stats_lines(s):
    lat = s["latency_s"]
    cost = "n/a (API reported no cost)" if s["cost_usd"] is None else (
        f"${s['cost_usd']:.4f}  (${s['cost_per_dialogue_usd']:.4f} per dialogue, all {s['jobs'] // s['dialogues']} "
        "criterion calls)" + (f"  [{s['jobs_without_cost']} jobs without cost]" if s["jobs_without_cost"] else ""))
    return [
        f"tokens: input {s['input_tokens']:,}  output {s['output_tokens']:,}  total {s['total_tokens']:,}"
        f"   ({s['api_calls']} API calls for {s['jobs']} jobs)",
        f"price:  {cost}",
        f"time:   per call mean {lat['mean']}s  median {lat['median']}s  p95 {lat['p95']}s  max {lat['max']}s;  "
        f"inference total {lat['total']}s;  wall clock {s['wall_time_s']}s",
    ]


def slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s)


def write_reports(d, info, crits, ids, meta, by_id, runs):
    """Report files of one judge.py run, written into its own directory `d` (never overwrites earlier runs):
      summary.md            human-readable: setup, per-model stats, verdict table, errors
      results.csv           one row per (model, dialogue): verdict per criterion + total (opens in Excel)
      stats.json            tokens / price / time per model and per criterion
      details_<model>.json  full output per model: raw model replies, evidence, rationale, usage, warnings
    Called after every model finishes, so a long multi-model run keeps what it has if it is interrupted."""
    d.mkdir(parents=True, exist_ok=True)
    cols = [c["criterion_id"] for c in crits]
    dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    dump(d / "stats.json", {"run": info, "models": {m: r["stats"] for m, r in runs.items()}})

    md = [f"# Judge report, {info['started']}", "",
          f"- models: {', '.join(runs)}", f"- criteria: {', '.join(cols)}",
          f"- dialogues: {len(ids)} (input: {info['input']})", ""]
    with open(d / "results.csv", "w", newline="", encoding="utf-8-sig") as f:  # utf-8-sig: Excel reads Cyrillic
        w = csv.writer(f)
        w.writerow(["model", "conversation_id", "label", "gross_error", "channel", "language", *cols, "total"])
        for m, r in runs.items():
            dump(d / f"details_{slug(m)}.json", {"run": info, "model": m, "output_mode": r["output_mode"],
                                                 "stats": r["stats"], "totals": r["totals"], "results": r["results"]})
            table = {}
            for x in r["results"]:
                table.setdefault(x["conversation_id"], {})[x["criterion"]] = x
            errs = [x for x in r["results"] if "error" in x]
            warns = sum(len(x.get("evidence_warnings", [])) for x in r["results"])
            md += [f"## {m}", "", f"Output mode: {r['output_mode']}. {len(r['results']) - len(errs)}/"
                   f"{len(r['results'])} jobs ok, {len(errs)} errors, {warns} evidence warnings.", "",
                   "```", *stats_lines(r["stats"]), "```", "",
                   "| conversation | label | " + " | ".join(cols) + " | total |",
                   "|---|---|" + "---|" * (len(cols) + 1)]
            for cid in ids:
                cells = ["ERROR" if "error" in table[cid][c] else table[cid][c]["answer"] for c in cols]
                total = "" if r["totals"][cid] is None else r["totals"][cid]
                label = meta.get(cid, {}).get("label", "")
                w.writerow([m, cid, label, meta.get(cid, {}).get("gross_error", ""), by_id[cid]["channel"],
                            by_id[cid]["language"], *cells, total])
                md.append(f"| {cid} | {label} | " + " | ".join(cells) + f" | {'-' if total == '' else total} |")
            md.append("")
            if errs:
                md += ["Errors:", *(f"- {x['conversation_id']} / {x['criterion']}: {x['error'][:200]}" for x in errs), ""]
    (d / "summary.md").write_text("\n".join(md) + "\n", encoding="utf-8")


def wait_hints(crit, msgs):
    """Code-computed hints for criteria that define explicit_wait_gap_seconds (c06); None otherwise."""
    thr = crit.get("parameters", {}).get("explicit_wait_gap_seconds", {}).get("value")
    if not thr:
        return None
    return [f"operator reply gap > {thr}s {g}" for g in reply_gaps(msgs, thr)] or [f"no operator reply gap over {thr}s"]


def judge_one(client, model, crit, shared, record, msgs):
    raw, usage = call_llm(client, model, build_messages(crit, shared, render(msgs), record, wait_hints(crit, msgs)),
                          response_schema(crit), lambda out: check_reply(crit, out))
    res = decide(crit, raw, record)
    dec = decisive_ids(crit, res)
    res.update(criterion=crit["criterion_id"], conversation_id=record["conversation_id"], raw=raw, usage=usage,
               evidence_warnings=check_evidence(raw, msgs),
               value=result_value(res), rationale=rationale_text(raw, dec, crit),
               evidence_turns=turns_for(raw, dec, crit, msgs, len(record["transcript"])))
    return res


# --------------------------------------------------------------------------- submission (results appendix, JSON 1.0)
def submission_record(cid, per_crit, stems):
    """One record per dialogue. status=ok needs all 8 criteria; otherwise status=error with empty criteria,
    score=null and the reason (an error is never replaced by a zero score)."""
    bad = [s for s in stems if s not in per_crit or "error" in per_crit[s]]
    if bad:
        reasons = "; ".join(f"{s}: {per_crit[s]['error']}" if s in per_crit else f"{s}: not evaluated" for s in bad)
        return {"conversation_id": cid, "status": "error", "criteria": [], "score": None, "error": reasons[:500]}
    criteria = [{"criterion_id": CRITERION_CODES[s], "value": per_crit[s]["value"],
                 "rationale": per_crit[s]["rationale"], "evidence_turns": per_crit[s]["evidence_turns"]}
                for s in stems]
    return {"conversation_id": cid, "status": "ok", "criteria": criteria,
            "score": {"final_score": total_score([per_crit[s] for s in stems]),
                      "critical_flag": per_crit["c08_gross_errors"]["value"]}}


def validate_submission(payload, expected_ids, n_turns, expect_count=None):
    """Hard checks before anything is written. Returns a list of problems (empty = ok)."""
    errs = []
    recs = payload["results"]
    ids = [r["conversation_id"] for r in recs]
    if len(ids) != len(set(ids)):
        errs.append("duplicate conversation_id")
    if set(ids) != set(expected_ids):
        errs.append(f"ids differ from the dataset: missing={sorted(set(expected_ids) - set(ids))[:5]} "
                    f"unexpected={sorted(set(ids) - set(expected_ids))[:5]}")
    if expect_count is not None and len(recs) != expect_count:
        errs.append(f"expected {expect_count} records, got {len(recs)}")
    order = list(ALLOWED_VALUES)
    for r in recs:
        cid = r["conversation_id"]
        if r["status"] == "error":
            if r["criteria"] != [] or r["score"] is not None or not r.get("error"):
                errs.append(f"{cid}: error record must have criteria=[], score=null and an error text")
            continue
        codes = [c["criterion_id"] for c in r["criteria"]]
        if codes != order:
            errs.append(f"{cid}: criteria {codes} != {order}")
            continue
        for c in r["criteria"]:
            v, code = c["value"], c["criterion_id"]
            is_bool_code = code in ("contact", "discovery", "identification", "empathy", "closing", "critical")
            if v is not None and (isinstance(v, bool) != is_bool_code):
                errs.append(f"{cid}.{code}: wrong value type {v!r}")
            elif v not in ALLOWED_VALUES[code]:
                errs.append(f"{cid}.{code}: value {v!r} not allowed")
            if not c["rationale"].strip():
                errs.append(f"{cid}.{code}: empty rationale")
            t = c["evidence_turns"]
            if not t or t != sorted(set(t)) or not all(isinstance(i, int) and 1 <= i <= n_turns[cid] for i in t):
                errs.append(f"{cid}.{code}: bad evidence_turns {t}")
        fs = r["score"]["final_score"]
        if fs is not None and (isinstance(fs, bool) or not isinstance(fs, (int, float)) or not 0 <= fs <= 100):
            errs.append(f"{cid}: bad final_score {fs!r}")
        if not isinstance(r["score"]["critical_flag"], bool):
            errs.append(f"{cid}: critical_flag must be bool")
        elif r["score"]["critical_flag"] != r["criteria"][-1]["value"]:
            errs.append(f"{cid}: critical_flag != critical value")
    return errs


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subset", default=str(ROOT / "test_subset.json"))
    ap.add_argument("--ids", nargs="*", help="override: only these conversation_ids")
    ap.add_argument("--criteria", nargs="*", default=DEFAULT_CRITERIA, help="criterion ids (file stems)")
    ap.add_argument("--models", nargs="*", default=None,
                    help="OpenRouter model ids; several allowed, each is run and reported separately "
                         "(default: $OPENROUTER_MODEL or " + DEFAULT_MODEL + ")")
    ap.add_argument("--input", default=None, help="dataset file: organiser API response or list of records "
                                                  "(default: dialogues.json = DEV)")
    ap.add_argument("--all", action="store_true", help="run every record of the input instead of test_subset.json")
    ap.add_argument("--submit", choices=["dev", "prod"],
                    help="write results/<set>/results.json (appendix format). Runs the WHOLE input set, all 8 "
                         "criteria and exactly one model")
    ap.add_argument("--team-name", default=os.environ.get("TEAM_NAME"), help="team_name for the results file")
    ap.add_argument("--mode", choices=["local", "external_api", "hybrid"], default="external_api",
                    help="model.mode in the results file (OpenRouter = external_api)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--report-dir", default=None,
                    help="directory for this run's report files (default: reports/<timestamp>[_submit-<set>])")
    ap.add_argument("--dry-run", action="store_true", help="print prompts only")
    args = ap.parse_args()

    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass
    models = args.models or [os.environ.get("OPENROUTER_MODEL") or DEFAULT_MODEL]

    if args.submit:
        if len(models) != 1:
            sys.exit("--submit needs exactly one model (the results file names the model that produced it).")
        if args.ids or (args.criteria and sorted(args.criteria) != sorted(CRITERION_CODES)):
            sys.exit("--submit must cover all 8 criteria and the whole dataset: drop --ids/--criteria.")
        if args.submit == "prod" and not args.input:
            sys.exit("--submit prod needs --input <file with the control set saved from the organisers' API>.")
        if not args.team_name:
            print("WARNING: no --team-name / TEAM_NAME given, writing a placeholder.", file=sys.stderr)
        args.all = True

    records = load_records(args.input)
    by_id = {r["conversation_id"]: r for r in records}
    if len(by_id) != len(records):
        sys.exit("duplicate conversation_id in the input dataset")
    # bot boilerplate is detected over DEV + input (a 10-chat control set alone is too small to detect it)
    pool = {r["conversation_id"]: r for r in load_records()}
    pool.update(by_id)
    boiler = boilerplate_texts(list(pool.values()))
    subset = load_json(args.subset)["dialogues"]
    meta = {d["conversation_id"]: d for d in subset}
    ids = args.ids or (list(by_id) if args.all else [d["conversation_id"] for d in subset])
    missing = [i for i in ids if i not in by_id]
    if missing:
        sys.exit(f"Unknown conversation ids: {missing}")

    shared = load_json(CHECKLIST_DIR / "shared_rules.json")
    crits = [load_json(CHECKLIST_DIR / f"{c}.json") for c in args.criteria]
    jobs = [(c, by_id[i], build_messages_list(by_id[i], boiler)) for i in ids for c in crits]

    if args.dry_run:
        for c, r, msgs in jobs:
            print("=" * 100, f"\n{c['criterion_id']} / {r['conversation_id']}")
            for m in build_messages(c, shared, render(msgs), r, wait_hints(c, msgs)):
                print(f"--- {m['role']} ---\n{m['content']}")
        return

    client = make_client()
    started = datetime.now()
    report_dir = Path(args.report_dir) if args.report_dir else (
        ROOT / "reports" / (started.strftime("%Y%m%d-%H%M%S") + (f"_submit-{args.submit}" if args.submit else "")))
    info = {"started": started.isoformat(timespec="seconds"), "input": args.input or "dialogues.json",
            "criteria": args.criteria, "dialogues": len(ids), "models": models, "workers": args.workers,
            "submit": args.submit}
    runs = {}
    for model in models:
        print(f"model={model}  jobs={len(jobs)}", file=sys.stderr)

        def run(job, model=model):
            c, r, msgs = job
            try:
                return judge_one(client, model, c, shared, r, msgs)
            except Exception as e:
                return {"criterion": c["criterion_id"], "conversation_id": r["conversation_id"], "error": str(e),
                        "usage": getattr(e, "usage", None)}

        t_start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            results = list(ex.map(run, jobs))
        stats = usage_stats(results, time.perf_counter() - t_start, len(ids))

        table = {}
        for r in results:
            table.setdefault(r["conversation_id"], {})[r["criterion"]] = r
        totals = {cid: total_score(list(table[cid].values())) for cid in ids}
        runs[model] = {"output_mode": MODE.get(model), "stats": stats, "totals": totals, "results": results}

        w = max(12, *(len(c["criterion_id"]) for c in crits))
        print(f"\n=== {model}  (output mode: {MODE.get(model)})")
        print(f"{'conversation':<12} {'label':<8} " + " ".join(f"{c['criterion_id']:<{w}}" for c in crits) + " total")
        for cid in ids:
            cells = []
            for c in crits:
                r = table[cid][c["criterion_id"]]
                cells.append(f"{'ERROR' if 'error' in r else r['answer']:<{w}}")
            t = totals[cid]
            print(f"{cid:<12} {meta.get(cid, {}).get('label', ''):<8} " + " ".join(cells)
                  + f" {'-' if t is None else t}")
        errs = [r for r in results if "error" in r]
        warns = sum(len(r.get("evidence_warnings", [])) for r in results)
        print(f"{len(results) - len(errs)}/{len(results)} ok, {len(errs)} errors, {warns} evidence warnings")
        print("\n".join(stats_lines(stats)))
        for e in errs:
            print("ERROR", e["conversation_id"], e["criterion"], e["error"], file=sys.stderr)
        write_reports(report_dir, info, crits, ids, meta, by_id, runs)

        if args.submit:
            stems = [c["criterion_id"] for c in sorted(crits, key=lambda c: c["order"])]
            payload = {"schema_version": "1.0", "team_name": args.team_name or "TODO-team-name",
                       "model": {"mode": args.mode, "name": model},
                       "results": [submission_record(cid, table[cid], stems) for cid in ids]}
            n_turns = {cid: len(by_id[cid]["transcript"]) for cid in ids}
            problems = validate_submission(payload, list(by_id), n_turns, 10 if args.submit == "prod" else None)
            out_path = ROOT / "results" / args.submit / "results.json"
            if problems:
                print(f"\nSUBMISSION NOT WRITTEN, {len(problems)} problem(s):", file=sys.stderr)
                for p in problems[:30]:
                    print("  -", p, file=sys.stderr)
            else:
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                n_err = sum(r["status"] == "error" for r in payload["results"])
                print(f"\nSubmission written: {out_path} ({len(ids)} records, {n_err} with status=error). "
                      "Commit AND push it before the stop-code.")

    print(f"\nReports: {report_dir}  (summary.md, results.csv, stats.json, details_<model>.json)")
    print("total = 0-100 over the criteria run only (N/A weight redistributed; errored criteria excluded). "
          "Evidence warnings = cited index/quote not found in the transcript (see evidence_warnings).")


if __name__ == "__main__":
    main()
