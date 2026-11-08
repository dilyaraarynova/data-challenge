#!/usr/bin/env python3
"""RU <-> EN translator for checklist texts (UI is Russian, judge prompts and criterion files are English).

A small instruction model behind an OpenAI-compatible API translates whole batches in one call.
Every pair is kept in a cache file, so a text is translated once and a Russian text the user typed is shown
back exactly as typed (the cache maps the English it produced back to the user's Russian).

Env (or .env):
  OPENROUTER_API_KEY        key for the default endpoint (OpenRouter)
  TRANSLATOR_MODEL          default google/gemma-3-12b-it (small open-weights model)
  TRANSLATOR_BASE_URL       default https://openrouter.ai/api/v1; for a truly local model run Ollama and set
                            http://localhost:11434/v1 with TRANSLATOR_MODEL=gemma3:12b (key not needed then)

CLI:  python translator.py ru "Оператор поздоровался"     python translator.py en "Operator greeted the client"
"""
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).parent
CACHE_PATH = ROOT / "checklists" / "translations_ru.json"
DEFAULT_MODEL = "google/gemma-3-12b-it"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
BATCH = 12  # strings per request (batches run in parallel)

SYSTEM = (
    "You translate texts of a quality-assurance checklist for customer-support operators of a brokerage "
    "(Freedom Broker). The checklist is used to instruct an LLM judge, so keep the meaning exact.\n"
    "Rules:\n"
    "- Translate every item of `items` from {src} to {dst}; return the same number of items in the same order.\n"
    "- Keep unchanged: quoted example phrases in Russian or Kazakh (e.g. 'Привет', 'Мен Нұрланмын', "
    "«Клиент находится на удержании»), identifiers and codes (6.4, na_gate, applies_if, yes_if, "
    "explicit_wait_gap_seconds, criterion ids), numbers, N/A, AND/OR/NOT, square-bracket tokens like "
    "[Имя скрыто], markdown and punctuation style.\n"
    "- Use the terms: operator = оператор, client = клиент, criterion = критерий, subcriterion = подкритерий, "
    "evidence = доказательство, N/A = Н/П (when translating to Russian; Н/П = N/A to English), "
    "hold = удержание, gross error = грубая ошибка, identification/verification = идентификация.\n"
    "- Concise, natural, professional language. No explanations, only the JSON."
)


def _load_env():
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass


class TranslationError(RuntimeError):
    pass


class Translator:
    def __init__(self, cache_path=CACHE_PATH):
        _load_env()
        self.cache_path = Path(cache_path)
        self.model = os.environ.get("TRANSLATOR_MODEL") or DEFAULT_MODEL
        self.base_url = os.environ.get("TRANSLATOR_BASE_URL") or DEFAULT_BASE_URL
        self.lock = threading.Lock()
        self.en2ru, self.ru2en = {}, {}
        if self.cache_path.exists():
            data = json.loads(self.cache_path.read_text(encoding="utf-8"))
            for en, ru in data.get("pairs", {}).items():
                self._remember(en, ru)
        self._client = None

    # ------------------------------------------------------------------ cache
    def _remember(self, en, ru):
        self.en2ru[en] = ru
        self.ru2en[ru] = en

    def _save(self):
        self.cache_path.write_text(json.dumps({
            "purpose": "Cache of the checklist translator (translator.py): English text of the criterion files -> "
                       "Russian text shown in the web UI. Edit a Russian value to change what the UI shows.",
            "model": self.model, "pairs": dict(sorted(self.en2ru.items()))}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")

    def remember(self, en, ru):
        """Record a known pair (e.g. the English produced for a Russian text the user typed)."""
        with self.lock:
            self._remember(en, ru)
            self._save()

    def cached_ru(self, en):
        return self.en2ru.get(en)

    def cached_en(self, ru):
        return self.ru2en.get(ru)

    # ------------------------------------------------------------------ model
    def client(self):
        if self._client is None:
            from openai import OpenAI
            key = os.environ.get("TRANSLATOR_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
            if not key and "openrouter.ai" in self.base_url:
                raise TranslationError("OPENROUTER_API_KEY не задан: перевод недоступен")
            self._client = OpenAI(base_url=self.base_url, api_key=key or "local")
        return self._client

    def _call(self, texts, src, dst):
        schema = {"type": "object", "additionalProperties": False, "required": ["items"],
                  "properties": {"items": {"type": "array", "items": {"type": "string"}}}}
        messages = [{"role": "system", "content": SYSTEM.format(src=src, dst=dst)},
                    {"role": "user", "content": json.dumps({"items": texts}, ensure_ascii=False)}]
        last = None
        for attempt in range(3):
            try:
                kwargs = {"response_format": {"type": "json_schema",
                                              "json_schema": {"name": "translation", "strict": True, "schema": schema}}}
                if "openrouter.ai" in self.base_url:
                    kwargs["extra_body"] = {"provider": {"require_parameters": True}}
                resp = self.client().chat.completions.create(model=self.model, messages=messages, temperature=0,
                                                             **kwargs)
                text = (resp.choices[0].message.content or "").strip()
                text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                out = json.loads(text)["items"]
                if len(out) != len(texts) or not all(isinstance(x, str) for x in out):
                    raise ValueError(f"expected {len(texts)} strings, got {len(out)}")
                return [o.strip() for o in out]
            except TranslationError:
                raise
            except Exception as e:  # network, invalid JSON, wrong count -> retry
                last = e
        raise TranslationError(f"Перевод не удался ({self.model}): {last}")

    def _translate(self, texts, to_ru):
        src, dst = ("English", "Russian") if to_ru else ("Russian", "English")
        known = self.en2ru if to_ru else self.ru2en
        todo = sorted({t for t in texts if t and t.strip() and t not in known})
        chunks = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
        with ThreadPoolExecutor(max_workers=6) as ex:          # batches in parallel
            done = list(ex.map(lambda ch: (ch, self._call(ch, src, dst)), chunks))
        for chunk, out in done:
            with self.lock:
                for a, b in zip(chunk, out):
                    if to_ru:
                        self._remember(a, b)
                    else:
                        self._remember(b, a)
                self._save()
        return [known.get(t, t) if t and t.strip() else t for t in texts]

    def to_ru(self, texts):
        return self._translate(list(texts), True)

    def to_en(self, texts):
        return self._translate(list(texts), False)


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("ru", "en"):
        sys.exit(__doc__)
    t = Translator()
    print("\n".join((t.to_ru if sys.argv[1] == "ru" else t.to_en)(sys.argv[2:])))
