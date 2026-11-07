"""
Evaluate support conversations from dialogues.json with LLMs via OpenRouter.

Examples:
    python evaluate.py                                   # gpt-6-luna, baseline_prompt.txt, test_subset.json
    python evaluate.py --models openai/gpt-6-luna anthropic/claude-sonnet-5-5
    python evaluate.py --prompt-file my_prompt_v2.txt --limit 5
    python evaluate.py --ids p1-ru-001 p1-ru-002         # specific ids
    python evaluate.py --subset "" --limit 10            # first 10 of all dialogues

API key: put OPENROUTER_API_KEY=sk-or-... in a .env file next to this script
(or export it in your shell).
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

HERE = Path(__file__).parent
API_URL = "https://openrouter.ai/api/v1/chat/completions"

def load_env_file(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines) so no extra dependency is needed."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def format_transcript(record: dict) -> str:
    lines = [
        f"Conversation ID: {record['conversation_id']}",
        f"Channel: {record.get('channel')}",
        f"Language: {record.get('language')}",
        "",
        "TRANSCRIPT:",
    ]
    for msg in record["transcript"]:
        lines.append(f"[{msg.get('timestamp', '')}] {msg['speaker'].upper()}: {msg['text']}")
    return "\n".join(lines)


def parse_json(text: str):
    """Parse model output as JSON, tolerating ```json fences or extra text."""
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text[text.find("{"): text.rfind("}") + 1]
    try:
        return json.loads(candidate)
    except (json.JSONDecodeError, ValueError):
        return None


def call_model(api_key, model, system_prompt, user_content, args):
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": args.temperature,
    }
    if not args.no_json_mode:
        payload["response_format"] = {"type": "json_object"}
    if args.reasoning:
        payload["reasoning"] = {"enabled": True}

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    last_error = None
    for attempt in range(1, args.retries + 1):
        try:
            resp = requests.post(API_URL, headers=headers, json=payload, timeout=args.timeout)
            if resp.status_code == 200:
                data = resp.json()
                if "choices" in data:
                    return data
                last_error = f"Unexpected response: {json.dumps(data)[:500]}"
            else:
                last_error = f"HTTP {resp.status_code}: {resp.text[:500]}"
                if resp.status_code in (400, 401, 402, 403, 404):
                    raise RuntimeError(last_error)  # not worth retrying (bad key, no credits, bad model name)
        except requests.RequestException as e:
            last_error = str(e)
        print(f"    attempt {attempt} failed: {last_error}", file=sys.stderr)
        time.sleep(2 ** attempt)
    raise RuntimeError(last_error)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--models", nargs="+", default=["openai/gpt-6-luna"], help="OpenRouter model name(s)")
    p.add_argument("--prompt-file", default="baseline_prompt.txt", help="File with the evaluation prompt")
    p.add_argument("--prompt", default=None, help="Prompt text directly (overrides --prompt-file)")
    p.add_argument("--data", default="dialogues.json", help="Dialogues JSON file")
    p.add_argument("--subset", default="test_subset.json",
                   help='JSON file listing conversation_ids to evaluate (pass "" to use all dialogues)')
    p.add_argument("--limit", type=int, default=0, help="How many conversations to evaluate (0 = all)")
    p.add_argument("--offset", type=int, default=0, help="Skip the first N conversations")
    p.add_argument("--ids", nargs="+", default=None, help="Evaluate only these conversation_ids")
    p.add_argument("--out-dir", default="results", help="Where to save results")
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--reasoning", action="store_true", help="Enable reasoning (for models that support it)")
    p.add_argument("--no-json-mode", action="store_true",
                   help="Don't send response_format=json_object (use if a model rejects it)")
    p.add_argument("--retries", type=int, default=3)
    p.add_argument("--timeout", type=int, default=180)
    args = p.parse_args()

    load_env_file(HERE / ".env")
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key or api_key == "paste-your-key-here":
        sys.exit("OPENROUTER_API_KEY not set. Add it to .env (OPENROUTER_API_KEY=sk-or-...) or export it.")

    # Prompt
    if args.prompt:
        prompt_text, prompt_name = args.prompt, "inline"
    else:
        prompt_path = Path(args.prompt_file)
        prompt_text, prompt_name = prompt_path.read_text(encoding="utf-8"), prompt_path.stem
    system_prompt = prompt_text

    # Conversations
    raw = json.loads(Path(args.data).read_text(encoding="utf-8"))
    records = raw["data"]["records"] if isinstance(raw, dict) else raw
    labels = {}
    if args.ids:
        wanted = args.ids
    elif args.subset:
        subset = json.loads(Path(args.subset).read_text(encoding="utf-8"))
        items = subset["dialogues"] if isinstance(subset, dict) else subset
        wanted = [d["conversation_id"] if isinstance(d, dict) else d for d in items]
        labels = {d["conversation_id"]: d.get("label") for d in items if isinstance(d, dict)}
    else:
        wanted = None

    if wanted is not None:
        by_id = {r["conversation_id"]: r for r in records}
        missing = [cid for cid in wanted if cid not in by_id]
        if missing:
            print(f"WARNING: not found in {args.data}: {missing}", file=sys.stderr)
        records = [by_id[cid] for cid in wanted if cid in by_id]
        records = records[args.offset:]
        if args.limit:
            records = records[: args.limit]
    else:
        records = records[args.offset:]
        if args.limit:
            records = records[: args.limit]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    for model in args.models:
        print(f"\n=== {model} | prompt: {prompt_name} | {len(records)} conversations ===")
        results = []
        out_path = out_dir / f"{model.replace('/', '_')}__{prompt_name}__{stamp}.json"

        for i, rec in enumerate(records, 1):
            cid = rec["conversation_id"]
            print(f"  [{i}/{len(records)}] {cid} ...", end=" ", flush=True)
            entry = {"conversation_id": cid, "language": rec.get("language"), "label": labels.get(cid)}
            started = time.time()
            try:
                data = call_model(api_key, model, system_prompt, format_transcript(rec), args)
                content = data["choices"][0]["message"].get("content")
                parsed = parse_json(content)
                entry.update({
                    "evaluation": parsed,
                    "raw_response": None if parsed is not None else content,
                    "usage": data.get("usage"),
                    "error": None if parsed is not None else "Could not parse JSON",
                })
                score = parsed.get("final_score") if isinstance(parsed, dict) else None
                print(f"ok  score={score}  (label: {labels.get(cid)})" if parsed is not None else "returned non-JSON")
            except Exception as e:
                entry.update({"evaluation": None, "error": str(e)})
                print(f"ERROR: {e}")
            entry["seconds"] = round(time.time() - started, 1)
            results.append(entry)

            # Save after each conversation so nothing is lost if the run stops
            out_path.write_text(json.dumps({
                "model": model,
                "prompt_name": prompt_name,
                "prompt": system_prompt,
                "subset": None if args.ids else (args.subset or None),
                "created_at": stamp,
                "results": results,
            }, ensure_ascii=False, indent=2), encoding="utf-8")

        ok = sum(1 for r in results if r.get("evaluation") is not None)
        print(f"  -> saved {out_path} ({ok}/{len(results)} parsed)")


if __name__ == "__main__":
    main()
