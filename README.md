# CQA — Conversation Quality Analytics

**Team NU IoT Lab · Freedom Broker CQA Hackathon**

An LLM judge scores support-operator dialogues (chats and voice calls, RU / KZ / EN) against an editable checklist. The web UI covers the checklist editor, the evaluation, the evidence, and the appeal and review flow.

---

## Quick start

Requires Python 3.10+ (tested on 3.12) and an [OpenRouter](https://openrouter.ai) API key.

```bash
pip install openai python-dotenv
echo "OPENROUTER_API_KEY=sk-or-..." > .env
python server.py
```

Open **http://127.0.0.1:8000**.

All dialogue sets are already in [`dialogues/`](dialogues/) (`dev.json`, `prod.json`, `swap.json`: the organisers' API responses saved as is), so there's nothing to download. The UI shows every set; filter by **Набор**. The browser talks only to our local server, so there are no CORS issues.

---

## Submitted results

| File | Set | Records |
|---|---|---|
| [`results/dev/results.json`](results/dev/results.json) | DEV | 65 (60 chats + 5 calls) |
| [`results/prod/results.json`](results/prod/results.json) | Control set | 10 |

Both files follow format JSON 1.0 from the results appendix. Field names, criterion codes and value types are unchanged. We **added** a few extra fields after the required ones; they can be ignored:

- per dialogue: `channel`, `language`
- per criterion: `weight`, `points` (weighted points), `evidence` (each cited turn with its original timestamp and a verbatim quote)

To regenerate them:

```bash
python judge.py --submit dev  --team-name "NU IoT Lab"                    # -> results/dev/results.json
python judge.py --submit prod --team-name "NU IoT Lab"                    # -> results/prod/results.json
```

Each command reads `dialogues/<set>.json`. Before writing a file, `judge.py` checks that every dialogue is present exactly once, that the values are allowed, that evidence turns are in range, and that `critical_flag` equals the `critical` value. A dialogue that could not be scored gets `status: "error"`, never a zero score.

---

## Model and cost

| | |
|---|---|
| Judge | `deepseek/deepseek-v4.1-flash-1017` via OpenRouter (`external_api`), temperature 0 |
| Translator (checklist RU ↔ EN only) | `google/gemma-3-12b-it` via OpenRouter, results cached |
| **Cost of one dialogue evaluation** (all 8 calls) | **≈ $0.0066** (chat $0.0064, call $0.0095) |
| Time per dialogue (8 calls in parallel) | median 9.8 s, p95 25.8 s |
| Full DEV set (65 dialogues) | 9 min, $0.43 |

The translator runs only when someone saves checklist changes, not per dialogue.

---

## How the judge works

1. **One request per criterion, all in parallel.** Each criterion gets its own prompt, built from its own file in [`checklists/`](checklists/), so the 8 criteria of one dialogue run as 8 concurrent requests.
2. **The LLM answers questions; the code computes the score.** For each criterion the model answers its yes/no sub-questions (or picks a scale step) and cites a turn number with a quote. The criterion file's rules turn those answers into Yes / No / N/A or a scale step. Weights, N/A redistribution and rounding then follow the checklist exactly. `critical` is reported as a separate flag.
3. **Strict output.** Every reply is checked against a JSON schema and retried up to 3 times. Quotes are also checked against the cited turn.
4. **Transcript preparation.** Turn numbers are the original 1-based indices, counting client, bot and system turns. Bot and system turns are kept as context. Repeated bot boilerplate is dropped. In voice calls, fragments from the same speaker are merged, and speech while the client is on hold is marked as internal (the client did not hear it).
5. **Languages.** One checklist serves RU, KZ and EN. Prompts are in English; rationales are written in Russian; quotes stay in the original language.

---

## Using the interface

The two modes in the sidebar, **Оператор** and **Проверяющий**, stand in for the two roles (no login, as the guide allows).

| Guide step | In the UI |
|---|---|
| **01 Create a checklist** | **Чек-листы**: add or edit criteria, wording, weight, answer type (yes/no or scale with its steps), N/A on/off and N/A condition, category. **Сохранить чек-лист** saves a new version. **Вернуть стандартный** restores the organisers' checklist. |
| **02 Evaluate a dialogue** | **Диалоги**: filter by channel or language, open a dialogue → **Оценить диалог**, or tick several → **Оценить выбранные**. The saved checklist is used. |
| **03 Show the result** | Each criterion shows its answer, points, weight, rationale and evidence. For a failed item the rationale cites where the action was expected; for N/A it states which condition was met. The card also shows section results, the total, and the critical-error flag. |
| **04 Open the card** | Clicking an evidence link scrolls to that message. For calls, the player and its timeline jump to that fragment, with markers for every cited turn. |
| **05 Appeal** | Mode **Оператор** → **Оспорить оценку** → comment → **Отправить апелляцию**. |
| **06 Decide** | Mode **Проверяющий**: the reviewer sees the disputed score, the comment and the dialogue fragment, picks the final value, enters the reason (required), then clicks **Подтвердить оценку** or **Изменить оценку**. A preview shows the new total first. The card keeps the original score, the decision and the final result. |

**Replacing a criterion (control check):** in **Чек-листы**, edit or replace the criterion → **Сохранить чек-лист** → in **Диалоги**, filter the set, tick the dialogues → **Оценить выбранные**. Russian edits are translated to English for the judge automatically.

**Dynamics 365:** the UI is plain HTML, CSS and JS with no build step. All data access lives in [`front/js/api.js`](front/js/api.js); to embed the UI as a D365 HTML web resource, only that file has to be replaced (e.g. with `Xrm.WebApi`).

---

## Repository map

| Path | What it is |
|---|---|
| `judge.py` | LLM judge and scoring; CLI for runs (`--set swap --ui` evaluates a whole set for the UI) and submission files |
| `server.py` | Local backend: serves `front/` and a small JSON API |
| `checklist_store.py` | Converts between the UI checklist (RU) and the criterion files (EN), with versioning |
| `translator.py` | RU ↔ EN translation of checklist texts (cached in `checklists/translations_ru.json`) |
| `checklists/` | Active checklist: one JSON file per criterion + `shared_rules.json`; `standard/` holds the organisers' version |
| `front/` | Web UI (`index.html`, `js/`, `css/`) |
| `dialogues/` | Dialogue sets `dev`, `prod`, `swap` (API responses as is); `audio_urls.json` holds the call recordings |
| `judge_results.json`, `reviews.json` | Evaluations shown in the UI, and appeals with reviewer decisions |
| `results/` | Submission files |
| `reports/` | Per-run reports: summary, CSV, token/cost/latency stats, raw model replies |
| `baseline/` | Early single-prompt experiment, not used by the solution |
