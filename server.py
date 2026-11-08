#!/usr/bin/env python3
"""Local server for the CQA prototype: serves front/ and a small JSON API on top of judge.py.

    python server.py [--port 8765] [--model <openrouter model id>]

Needs OPENROUTER_API_KEY in .env (or the environment) for real scoring. Without it the page still works and
falls back to its built-in simulated judge.

API (all JSON):
    GET  /api/state       saved checklist, its version history and saved evaluations
    PUT  /api/checklist   {checklist, history}: save the checklist (data/checklist.json)
    GET  /api/dialogues   records of dialogues.json (+ prod_dataset.json when present)
    POST /api/evaluate    {conversation_id, checklist}: run the judge on one dialogue, save and return the evaluation
"""
import argparse
import json
import mimetypes
import os
import sys
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import judge
import checklist_bridge as bridge

ROOT = Path(__file__).parent
FRONT = ROOT / "front"
DATA = ROOT / "data"
CHECKLIST_FILE, EVALS_FILE = DATA / "checklist.json", DATA / "evaluations.json"
PAGE = "cqa_app_v2_1.html"
LOCK = threading.Lock()          # guards the data/ files
STATE = {"records": {}, "boiler": set(), "shared": None, "client": None, "model": None}


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    DATA.mkdir(exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_dialogues():
    """DEV records plus the control set when its file is present (saved from the organisers' API)."""
    records = {}
    for name in ("dialogues.json", "prod_dataset.json"):
        if (ROOT / name).exists():
            for r in judge.load_records(ROOT / name):
                records.setdefault(r["conversation_id"], r)
    STATE["records"] = records
    STATE["boiler"] = judge.boilerplate_texts(list(records.values()))


def get_client():
    if STATE["client"] is None:
        try:
            STATE["client"] = judge.make_client()      # exits when OPENROUTER_API_KEY is missing
        except SystemExit as e:
            raise RuntimeError(str(e))
    return STATE["client"]


class Handler(SimpleHTTPRequestHandler):
    server_version = "CQA/1.0"

    # ---- helpers
    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---- static files (front/ only)
    def send_static(self):
        path = unquote(urlparse(self.path).path)
        rel = PAGE if path in ("/", "") else path.lstrip("/")
        target = (FRONT / rel).resolve()
        if FRONT.resolve() not in target.parents or not target.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", (mimetypes.guess_type(target.name)[0] or "application/octet-stream")
                         + ("; charset=utf-8" if target.suffix in (".html", ".js", ".css", ".json") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---- routes
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            with LOCK:
                saved = read_json(CHECKLIST_FILE, {})
                evals = read_json(EVALS_FILE, {})
            return self.send_json({"checklist": saved.get("checklist"), "history": saved.get("history"),
                                   "evaluations": evals, "model": STATE["model"],
                                   "judge_ready": bool(os.environ.get("OPENROUTER_API_KEY"))})
        if path == "/api/dialogues":
            return self.send_json({"records": list(STATE["records"].values())})
        if path.startswith("/api/"):
            return self.send_error(HTTPStatus.NOT_FOUND)
        self.send_static()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/checklist":
            return self.send_error(HTTPStatus.NOT_FOUND)
        try:
            body = self.read_body()
            checklist = body["checklist"]
            bridge.build_criteria(checklist)           # reject a checklist the judge could not run
        except (KeyError, ValueError, TypeError) as e:
            return self.send_json({"error": f"Чек-лист не сохранён: {e}"}, HTTPStatus.BAD_REQUEST)
        with LOCK:
            write_json(CHECKLIST_FILE, {"checklist": checklist, "history": body.get("history")})
        self.send_json({"ok": True})

    def do_POST(self):
        if urlparse(self.path).path != "/api/evaluate":
            return self.send_error(HTTPStatus.NOT_FOUND)
        try:
            body = self.read_body()
            record = STATE["records"].get(body.get("conversation_id"))
            if record is None:
                return self.send_json({"error": "Диалог не найден"}, HTTPStatus.NOT_FOUND)
            checklist = body["checklist"]
            bridge.build_criteria(checklist)
            client = get_client()
        except RuntimeError as e:
            return self.send_json({"error": str(e)}, HTTPStatus.SERVICE_UNAVAILABLE)
        except (KeyError, ValueError, TypeError) as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        try:
            ev = bridge.evaluate(record, checklist, STATE["model"], client, STATE["boiler"], STATE["shared"])
        except Exception as e:
            return self.send_json({"error": f"Ошибка оценки: {e}"}, HTTPStatus.BAD_GATEWAY)
        if not ev["results"]:
            msg = "; ".join(f"{x['criterion']}: {x['error']}" for x in ev["errors"][:3])
            return self.send_json({"error": f"Ни один критерий не оценён. {msg}"}, HTTPStatus.BAD_GATEWAY)
        with LOCK:
            evals = read_json(EVALS_FILE, {})
            evals[record["conversation_id"]] = {**ev, "checklist": checklist}
            write_json(EVALS_FILE, evals)
        self.send_json(ev)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default=None, help="OpenRouter model id (default: $OPENROUTER_MODEL or judge.py default)")
    args = ap.parse_args()
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass
    STATE["model"] = args.model or os.environ.get("OPENROUTER_MODEL") or judge.DEFAULT_MODEL
    STATE["shared"] = judge.load_json(judge.CHECKLIST_DIR / "shared_rules.json")
    load_dialogues()
    key = "set" if os.environ.get("OPENROUTER_API_KEY") else "MISSING: the page will use the simulated judge"
    print(f"CQA server: http://{args.host}:{args.port}/   model={STATE['model']}   "
          f"OPENROUTER_API_KEY {key}   dialogues={len(STATE['records'])}", file=sys.stderr)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
