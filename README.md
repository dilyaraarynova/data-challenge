# CQA — Conversation Quality Analytics

Scores customer-support dialogues (chats and voice-call transcripts, RU / KZ / EN) against an editable quality checklist using an LLM judge. Includes a web app for evaluating, reviewing the evidence and handling appeals.

Built at the Freedom Broker CQA Hackathon.

## How to start

```bash
pip install -r requirements.txt
cp .env.example .env          # add your OpenRouter key
python server.py              # http://127.0.0.1:8000
```

The sample data in `data/` already includes evaluations, so the UI opens with results. The key is only needed to run new evaluations or save checklist edits.

## How it works

1. **Preparation (code).** Repeated bot boilerplate is dropped. In calls, fragments from the same speaker are merged, and speech while the client is on hold is marked as internal. Turns keep their original numbers so that evidence can be traced.
2. **Judging (LLM).** Each criterion is a separate request with its own prompt built from its checklist file. The 8 requests for a dialogue run in parallel. The model returns only yes/no answers to the criterion's sub-questions (or a scale step), each citing a turn and a quote. Every reply is checked against a strict JSON schema and retried on failure.
3. **Scoring (code).** The criterion file's rules turn those answers into Yes / No / N/A or a scale step. Weights, N/A weight redistribution and rounding are applied in code. Critical errors are a separate flag, not points.

The LLM never outputs a score directly, so scores are reproducible and every one can be traced back to a quote.

With `deepseek/deepseek-v4.1-flash-1017`, one dialogue costs ~$0.0066 and takes ~10 s (median; all 8 criteria in parallel).

## Checklist

`checklists/` holds one JSON file per criterion, plus `shared_rules.json` (rules added to every prompt) and `checklist.json` (name, sections, version history). `checklists/standard/` is the original checklist, which **Вернуть стандартный** in the UI restores.

A criterion is one of four shapes:

| Shape                          | Decided by                                                       |
| ------------------------------ | ---------------------------------------------------------------- |
| `conditions` + `decision`      | boolean expression over yes/no conditions (`a AND (b OR NOT c)`) |
| `subcriteria`, ordered gates   | first failed gate sets the score                                 |
| `subcriteria`, severity ladder | critical / major failures and the count of minor lapses          |
| `direct_scale`                 | the model picks a step (criteria created in the UI)              |

Any of them can have an N/A gate. Files are in English, since that's what the model sees. The UI edits them in Russian: changed texts are translated by a small LLM (`translator.py`, cached in `translations_ru.json`). Each saved checklist gets a version number, and every evaluation keeps the version it was made with.

## Data

`data/dialogues/<set>.json` holds one file per dataset (`dev`, `prod`, `swap`). Each file is either an API response `{"data": {"records": [...]}}` or a plain list of records:

```json
{
  "conversation_id": "p1-ru-001",
  "channel": "agent chat | voice call",
  "language": "RU | KZ | EN",
  "transcript": [
    {
      "timestamp": "00:02",
      "speaker": "client | operator | bot | system",
      "text": "..."
    }
  ]
}
```

Chat timestamps are `MM:SS`; call timestamps are ISO 8601. Recording URLs for calls go in `data/audio_urls.json`. To add a dataset, drop a new file into the folder and restart the server.

## Command line

```bash
python judge.py --set swap --ui                      # evaluate a whole set and show it in the UI
python judge.py --set dev --ids p1-ru-010 --criteria contact
python judge.py --models <model-a> <model-b>         # compare models (reports only)
python judge.py --dry-run --ids p1-ru-010            # print prompts, no API calls
python judge.py --submit dev --team-name "<team>"    # results/dev/results.json (hackathon format)
```

Every run writes `reports/<timestamp>/`: a summary, a CSV, token/cost/latency stats and the raw model replies. Stop or restart `server.py` around `--ui` runs: a running server keeps its own copy of `judge_results.json` and will overwrite it on its next save.

## Frontend

Plain HTML, CSS and JavaScript: no framework, no build step. `server.py` serves `front/` and a small JSON API from the same origin.

| File                        | Role                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `index.html`, `css/cqa.css` | Markup and styles; scripts load as classic `<script>` tags in order                                |
| `js/config.js`              | `window.CQA_CONFIG`: `apiBase` (API URL), `openParam` (query param that opens a dialogue)          |
| `js/api.js`                 | **The only file that talks to the backend.** Replace it to use another backend                     |
| `js/core.js`, `js/model.js` | State, transcript preparation and scoring (same rules as `judge.py`); checklist model and versions |
| `js/list.js`                | Dialogue list: filters by set, channel, language and status; bulk evaluation                       |
| `js/card.js`                | Dialogue card: transcript, verdicts, evidence links, audio player with evidence markers, appeals   |
| `js/assess.js`              | Starts evaluation jobs and polls their progress                                                    |
| `js/checklists.js`          | Checklist editor                                                                                   |
| `js/forms.js`, `js/main.js` | Form handling for sandboxed hosts; hash routing (`#<conversation_id>`, `#checklists`)              |

The sidebar's two modes, **Оператор** (files appeals) and **Проверяющий** (decides appeals, edits the checklist), stand in for user roles; there is no login. The UI text is in Russian.

To embed the UI elsewhere (e.g. as a Dynamics 365 HTML web resource), host `front/`, set `CQA_CONFIG` before `config.js`, and reimplement the functions in `api.js` with the same return shapes.

**API**

| Method    | Path                             |                                                          |
| --------- | -------------------------------- | -------------------------------------------------------- |
| GET       | `/api/bootstrap`                 | dialogues, checklist, evaluations, reviews, running jobs |
| GET / PUT | `/api/checklist`                 | current checklist; save it (rewrites `checklists/`)      |
| GET       | `/api/checklist/standard`        | original checklist                                       |
| GET       | `/api/evaluations`               | all evaluations                                          |
| POST      | `/api/evaluate` `{"ids": [...]}` | start an evaluation job                                  |
| GET       | `/api/jobs/<id>`                 | job progress                                             |
| PUT       | `/api/reviews/<conversation_id>` | save appeals and reviewer decisions                      |

## Layout

```
judge.py            LLM judge, scoring, CLI
server.py           web server + JSON API
checklist_store.py  checklist files <-> UI shape, versioning
translator.py       RU <-> EN translation of checklist texts
checklists/         active checklist (one file per criterion), standard/ = original
front/              web UI
data/               dialogues/, audio_urls.json, judge_results.json (evaluations), reviews.json (appeals), dev_eval_cases.json (notes for prompt testing)
results/            hackathon submission files (JSON 1.0)
reports/            per-run reports
```
