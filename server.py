#!/usr/bin/env python3
"""Local backend of the CQA web app: serves front/ and a small JSON API over the files of this folder.

    python server.py                 # http://127.0.0.1:8000
    python server.py --port 8080 --workers 8

Files it reads and writes
  dialogues.json            dialogues (read only)            audio_urls.json  audio link per voice call (read only)
  checklist_iter1/*.json    criteria the judge runs           (checklist_store.py; translations_ru.json = RU cache)
  judge_results.json        judge.py results per dialogue     (runs[model].results + evaluations index)
  reviews.json              appeals and reviewer decisions

API (all JSON)
  GET  /api/bootstrap                 everything the UI needs at start
  GET  /api/checklist                 current checklist (UI shape, Russian)
  PUT  /api/checklist                 save the checklist -> rewrites checklist_iter1/
  GET  /api/checklist/standard        the standard hackathon checklist (checklist_iter1/standard/)
  GET  /api/evaluations               evaluations of all dialogues (UI shape)
  POST /api/evaluate {"ids": [...]}   run judge.py on these dialogues with the saved checklist -> job
  GET  /api/jobs/<id>                 progress of a judge job
  PUT  /api/reviews/<conversation_id> {"appeals": {...}, "overrides": {...}}
"""
import argparse
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import checklist_store as cs
import judge

ROOT = Path(__file__).parent
FRONT = ROOT / "front"
RESULTS_PATH = ROOT / "judge_results.json"
REVIEWS_PATH = ROOT / "reviews.json"
AUDIO_PATH = ROOT / "audio_urls.json"
DIALOGUES_PATH = ROOT / "dialogues.json"


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write(path, obj):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- dialogues
RECORDS = judge.load_records(DIALOGUES_PATH)
BY_ID = {r["conversation_id"]: r for r in RECORDS}
BOILER = judge.boilerplate_texts(RECORDS)


def dialogues():
    audio = read(AUDIO_PATH, {}).get("audio_urls", {})
    return [{**r, "audio_url": audio.get(r["conversation_id"])} for r in RECORDS]


# --------------------------------------------------------------------------- results (judge_results.json)
class Results:
    """judge_results.json keeps judge.py's own format: {criteria, runs: {model: {output_mode, totals, results}}}.
    `evaluations` indexes the latest evaluation of each dialogue: {conversation_id: {model, assessed_at,
    checklist_version}}. A new evaluation of a dialogue replaces its old results in every run."""

    def __init__(self):
        self.lock = threading.Lock()
        data = read(RESULTS_PATH, {"criteria": [], "runs": {}})
        if "evaluations" not in data:                   # results made before the app: checklist version 1
            stamp = datetime.fromtimestamp(RESULTS_PATH.stat().st_mtime).astimezone().isoformat(timespec="seconds") \
                if RESULTS_PATH.exists() else None
            data["evaluations"] = {cid: {"model": m, "assessed_at": stamp, "checklist_version": 1}
                                   for m, run in data["runs"].items() for cid in run.get("totals", {})}
            write(RESULTS_PATH, data)
        self.data = data

    def put(self, cid, model, output_mode, results, version):
        with self.lock:
            d = self.data
            for run in d["runs"].values():
                run["results"] = [r for r in run["results"] if r["conversation_id"] != cid]
                run.get("totals", {}).pop(cid, None)
            run = d["runs"].setdefault(model, {"output_mode": output_mode, "totals": {}, "results": []})
            run["output_mode"] = output_mode or run.get("output_mode")
            run["results"].extend(results)
            run.setdefault("totals", {})[cid] = judge.total_score(results)
            d["runs"] = {m: r for m, r in d["runs"].items() if r["results"]}
            d["criteria"] = sorted({r["criterion"] for run in d["runs"].values() for r in run["results"]},
                                   key=lambda c: (d["criteria"].index(c) if c in d["criteria"] else 999, c))
            d["evaluations"][cid] = {"model": model, "assessed_at": now(), "checklist_version": version}
            write(RESULTS_PATH, d)

    def ui_all(self):
        crits, _ = cs.criteria_files()
        snaps = {}
        out = {}
        with self.lock:
            for cid, info in self.data["evaluations"].items():
                run = self.data["runs"].get(info["model"])
                if not run:
                    continue
                v = info.get("checklist_version")
                if v not in snaps:
                    snaps[v] = cs.version_snapshot(v)
                rows = [r for r in run["results"] if r["conversation_id"] == cid]
                snap = snaps[v] or cs.snapshot({}, {r["criterion"]: crits[r["criterion"]] for r in rows
                                                    if r["criterion"] in crits}, v, None)
                out[cid] = {"model": info["model"], "assessed_at": info.get("assessed_at"), "checklist": snap,
                            "results": [ui_result(r, crits.get(r["criterion"])) for r in rows]}
        return out


def ru(text):
    return cs.TR.cached_ru(text) or text


def evidence_turn(item):
    ev = (item or {}).get("evidence")
    return ev.get("index") if isinstance(ev, dict) else None


def ui_items(r, crit):
    """The model's per-item verdicts as rows of the quality panel (state: pass / fail / skip / info)."""
    raw, out = r.get("raw") or {}, []
    if not crit:
        return out
    if raw.get("na_gate"):
        g = raw["na_gate"]
        out.append({"id": "na", "label": "Н/П: " + ru(judge.na_gate_question(crit) or ""), "state": "info",
                    "value": g["value"], "turn": evidence_turn(g),
                    "note": ("Да. " if g["value"] else "Нет. ") + g.get("explanation", "")})
    if raw.get("scale_step"):
        s = raw["scale_step"]
        out.append({"id": "step", "label": f"Выбранная ступень: {s['value']}", "state": "info", "value": s["value"],
                    "turn": evidence_turn(s), "note": s.get("explanation", "")})
    conds = raw.get("conditions") or {}
    flag = crit.get("answer_type") == "flag"
    for c in crit.get("conditions") or []:
        item = conds.get(c["id"])
        if not item:
            continue
        v = item["value"]
        if c.get("role") == "trigger":
            state = "info"
        elif c.get("applies_if") and not conds.get(c["applies_if"], {}).get("value", True):
            state = "skip"
        else:
            state = ("fail" if v else "pass") if flag else ("pass" if v else "fail")
        out.append({"id": c["id"], "label": c.get("label_ru") or ru(c["question"]), "state": state, "value": v,
                    "turn": evidence_turn(item),
                    "note": ("Да. " if v else "Нет. ") + item.get("explanation", "") if state == "info"
                    else item.get("explanation", "")})
    subs = raw.get("subcriteria") or {}
    passed = r.get("passed") or {}
    for s in crit.get("subcriteria") or []:
        item = subs.get(s["id"])
        if not item:
            continue
        p = passed.get(s["id"])
        out.append({"id": s["id"], "label": s.get("label_ru") or ru(s["question"]),
                    "state": "skip" if p is None else "pass" if p else "fail", "value": p,
                    "turn": evidence_turn(item) if p is not None else None,
                    "note": item.get("explanation", "") if p is not None else None})
    return out


def ui_result(r, crit):
    if "error" in r:
        return {"criterion": r["criterion"], "value": None, "error": r["error"][:400], "evidence_turns": [],
                "rationale": "Модель не вернула корректный ответ, критерий не оценён. Переоцените диалог."}
    out = {"criterion": r["criterion"], "value": r["value"], "evidence_turns": r.get("evidence_turns") or [],
           "rationale": r.get("rationale") or "", "subcriteria": ui_items(r, crit)}
    q = (r.get("raw") or {}).get("client_questions")
    if q:
        out["client_questions"] = q
    if r.get("evidence_warnings"):
        out["evidence_warnings"] = r["evidence_warnings"]
    return out


# --------------------------------------------------------------------------- reviews (reviews.json)
class Reviews:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = read(REVIEWS_PATH, {"purpose": "Appeals of operators and decisions of reviewers per dialogue "
                                                   "(conversation_id -> {appeals, overrides}), keyed by criterion id.",
                                        "reviews": {}})

    def put(self, cid, body):
        with self.lock:
            rv = {"appeals": body.get("appeals") or {}, "overrides": body.get("overrides") or {}}
            if rv["appeals"] or rv["overrides"]:
                self.data["reviews"][cid] = rv
            else:
                self.data["reviews"].pop(cid, None)
            write(REVIEWS_PATH, self.data)

    def drop(self, cid):
        with self.lock:
            if self.data["reviews"].pop(cid, None) is not None:
                write(REVIEWS_PATH, self.data)


# --------------------------------------------------------------------------- judge jobs
class Jobs:
    """One judge run over a set of dialogues, in a background thread. Every dialogue is written to
    judge_results.json as soon as all its criteria are done, so a long run keeps what it has."""

    def __init__(self, results, reviews, workers):
        self.results, self.reviews, self.workers = results, reviews, workers
        self.jobs, self.lock = {}, threading.Lock()
        self.client = None

    def busy_ids(self):
        with self.lock:
            return {cid for j in self.jobs.values() if j["status"] == "running"
                    for cid, d in j["dialogues"].items() if d["state"] in ("queued", "running")}

    def start(self, ids):
        if not os.environ.get("OPENROUTER_API_KEY"):
            raise ValueError("OPENROUTER_API_KEY не задан в .env: оценка недоступна")
        unknown = [i for i in ids if i not in BY_ID]
        if unknown:
            raise ValueError(f"Неизвестные диалоги: {', '.join(unknown[:5])}")
        busy = self.busy_ids()
        ids = [i for i in dict.fromkeys(ids) if i not in busy]
        if not ids:
            raise ValueError("Эти диалоги уже оцениваются")
        stems = judge.enabled_criteria()
        if not stems:
            raise ValueError("В чек-листе нет включённых критериев")
        crits = [judge.load_criterion(s) for s in stems]
        model = os.environ.get("OPENROUTER_MODEL") or judge.DEFAULT_MODEL
        job = {"id": uuid.uuid4().hex[:10], "status": "running", "model": model, "started": now(),
               "checklist_version": cs.current_version(), "criteria": stems, "total": len(ids) * len(crits),
               "done": 0, "errors": [],
               "dialogues": {i: {"state": "queued", "done": 0, "total": len(crits)} for i in ids}}
        with self.lock:
            self.jobs[job["id"]] = job
        threading.Thread(target=self._run, args=(job, crits), daemon=True).start()
        return self.view(job["id"])

    def _run(self, job, crits):
        try:
            if self.client is None:
                self.client = judge.make_client()
            shared = judge.load_json(judge.CHECKLIST_DIR / "shared_rules.json")
            msgs = {cid: judge.build_messages_list(BY_ID[cid], BOILER) for cid in job["dialogues"]}
            per = {cid: [] for cid in job["dialogues"]}

            def one(task):
                cid, crit = task
                with self.lock:
                    job["dialogues"][cid]["state"] = "running"
                try:
                    res = judge.judge_one(self.client, job["model"], crit, shared, BY_ID[cid], msgs[cid])
                except Exception as e:
                    res = {"criterion": crit["criterion_id"], "conversation_id": cid, "error": str(e),
                           "usage": getattr(e, "usage", None)}
                with self.lock:
                    per[cid].append(res)
                    d = job["dialogues"][cid]
                    d["done"] += 1
                    job["done"] += 1
                    if "error" in res:
                        job["errors"].append(f"{cid} / {crit['criterion_id']}: {res['error'][:200]}")
                    complete = d["done"] == d["total"]
                if complete:
                    order = {c["criterion_id"]: i for i, c in enumerate(crits)}
                    rows = sorted(per[cid], key=lambda r: order[r["criterion"]])
                    self.results.put(cid, job["model"], judge.MODE.get(job["model"]), rows, job["checklist_version"])
                    self.reviews.drop(cid)          # appeals belonged to the replaced evaluation
                    with self.lock:
                        job["dialogues"][cid]["state"] = "error" if any("error" in r for r in rows) else "done"

            tasks = [(cid, c) for cid in job["dialogues"] for c in crits]
            with ThreadPoolExecutor(max_workers=self.workers) as ex:
                list(ex.map(one, tasks))
            job["status"] = "done"
        except BaseException as e:                  # noqa: BLE001 - reported to the UI
            traceback.print_exc()
            job["status"], job["fatal"] = "error", str(e)
        job["finished"] = now()

    def view(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            return json.loads(json.dumps(j)) if j else None

    def active(self):
        with self.lock:
            return [json.loads(json.dumps(j)) for j in self.jobs.values() if j["status"] == "running"]


# --------------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "CQA/1.0"

    def log_message(self, fmt, *args):
        if "/api/jobs/" not in (args[0] if args else ""):     # progress polling would flood the log
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def handle_api(self, method):
        path = urlparse(self.path).path
        app = self.server.app
        try:
            if method == "GET" and path == "/api/bootstrap":
                return self.send_json({"dialogues": dialogues(), "checklist": cs.load_checklist(),
                                       "evaluations": app["results"].ui_all(),
                                       "reviews": app["reviews"].data["reviews"], "jobs": app["jobs"].active(),
                                       "config": config()})
            if method == "GET" and path == "/api/checklist":
                return self.send_json(cs.load_checklist())
            if method == "PUT" and path == "/api/checklist":
                return self.send_json(cs.save_checklist(self.body()))
            if method == "GET" and path == "/api/checklist/standard":
                return self.send_json(cs.load_standard())
            if method == "GET" and path == "/api/evaluations":
                return self.send_json(app["results"].ui_all())
            if method == "POST" and path == "/api/evaluate":
                return self.send_json(app["jobs"].start(self.body().get("ids") or []))
            if method == "GET" and path.startswith("/api/jobs/"):
                j = app["jobs"].view(path.rsplit("/", 1)[1])
                return self.send_json(j) if j else self.send_json({"error": "Задача не найдена"}, 404)
            if method == "PUT" and path.startswith("/api/reviews/"):
                cid = unquote(path.rsplit("/", 1)[1])
                if cid not in BY_ID:
                    return self.send_json({"error": "Неизвестный диалог"}, 404)
                app["reviews"].put(cid, self.body())
                return self.send_json({"ok": True})
            return self.send_json({"error": "Не найдено"}, 404)
        except (cs.ChecklistError, ValueError) as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self.send_json({"error": f"Ошибка сервера: {e}"}, 500)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api("GET")
        rel = unquote(urlparse(self.path).path).lstrip("/") or "index.html"
        f = (FRONT / rel).resolve()
        if FRONT.resolve() not in f.parents or not f.is_file():
            return self.send_json({"error": "Не найдено"}, 404)
        data = f.read_bytes()
        self.send_response(200)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else ""))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.handle_api("POST")

    def do_PUT(self):
        self.handle_api("PUT")


def config():
    return {"judge_model": os.environ.get("OPENROUTER_MODEL") or judge.DEFAULT_MODEL,
            "translator_model": cs.TR.model, "api_key": bool(os.environ.get("OPENROUTER_API_KEY")),
            "criteria_dir": str(judge.CHECKLIST_DIR.relative_to(ROOT))}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--workers", type=int, default=8, help="parallel LLM calls of a judge job")
    args = ap.parse_args()
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass
    results, reviews = Results(), Reviews()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.app = {"results": results, "reviews": reviews, "jobs": Jobs(results, reviews, args.workers)}
    print(f"CQA: http://{args.host}:{args.port}   (judge model: {config()['judge_model']}, "
          f"translator: {cs.TR.model})", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
