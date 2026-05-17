# Cricket Analyst — agentic research over the GOAT Rankings dataset

A LangGraph-based agentic system that answers open-ended cricket questions by
planning, calling typed tools against the existing rankings dataset,
critiquing its own answers, and revising when grounding is weak. Streams
events to the frontend over SSE and is fully observable via LangFuse.

This is the agentic counterpart to the static `docs/` site. The site exposes
deterministic leaderboards and a tuning UI; this agent handles the messy
open-ended questions ("best XI for 90s subcontinent dustbowls", "who's
ranked outside the top 50 but elite if you down-weight longevity?") that
don't fit a single LLM call.

## Architecture

```
                              ┌─────────────────────────────────────────────┐
                              │           AnalystState (Pydantic)           │
                              │ question · messages · plan · retrieved      │
                              │ tool_iterations · draft · critique          │
                              │ revision_count · final                      │
                              └─────────────────────────────────────────────┘

  START → planner → retriever → plan_gate ──halt──► END
                                    │
                                  proceed
                                    │
                                    ▼
                              tool_executor ◄──┐
                                    │          │ (more tool calls)
                              more_tools?──────┘
                                    │ done
                                    ▼
                              synthesizer ◄──────┐
                                    │            │ (revise with critique)
                                    ▼            │
                                 critic ──revise─┘
                                    │ pass / out-of-retries
                                    ▼
                                   END
```

Six nodes, two cycles. Every node is wrapped in `@observe` so LangFuse
traces show node-level spans, tool calls, retries, latency and cost.

### Tools

| Tool | Purpose |
|---|---|
| `query_players` | Top-N batters/bowlers/allrounders with optional country + min-matches filter |
| `get_player` | Full player profile including 10-match stint arc |
| `compare_players` | Side-by-side head-to-head with explicit deltas |
| `build_xi` | Constraint-satisfying 11-player XI (roles + minimums) |
| `analyze_career_arc` | Peak window, prime, decline, longevity signals |

Tools are pure Python functions over the rankings JSON shipped by the
existing weekly scrape. Each is wrapped in LangChain's `@tool` decorator
with Pydantic-typed parameters so the model's tool calls are validated
automatically — no JSON-parsing tax.

### Retrieval

`BM25Retriever` indexes the flattened player profiles for the active format
and returns the top-8 lexical hits before the tool executor runs. This
narrows the model's working memory from 870 players to a focused shortlist.

The interface (`Retriever` protocol + `RetrievalHit` dataclass) is
implementation-agnostic so a semantic retriever (Voyage, OpenAI, local
sentence-transformers) can be dropped in without touching the graph.

### Files

```
agent/
├── pyproject.toml
├── README.md
├── .env.example
├── src/
│   ├── analyst/
│   │   ├── config.py          # env, data paths
│   │   ├── tracing.py         # LangFuse @observe (no-op if unset)
│   │   ├── state.py           # AnalystState, Plan, FinalAnswer, Critique
│   │   ├── retrieval.py       # BM25Retriever + Retriever protocol
│   │   ├── graph.py           # LangGraph wiring
│   │   ├── cli.py             # `uv run analyst "question"`
│   │   ├── nodes/
│   │   │   ├── planner.py        # structured output → Plan
│   │   │   ├── retriever.py
│   │   │   ├── plan_gate.py      # interrupt() for HITL
│   │   │   ├── tool_executor.py  # ReAct loop, bind_tools
│   │   │   ├── synthesizer.py    # structured output → FinalAnswer
│   │   │   └── critic.py         # structured output → Critique + retry
│   │   └── tools/
│   │       ├── query_players.py
│   │       ├── get_player.py
│   │       ├── compare_players.py
│   │       ├── build_xi.py
│   │       └── analyze_career_arc.py
│   └── api/
│       └── main.py            # FastAPI: /ask, /ask/stream (SSE), /ask/approve
├── deploy/
│   └── modal_app.py           # Modal deployment
└── tests/
    ├── test_tools.py          # tool-level unit tests
    ├── test_graph.py          # state / wiring tests
    └── test_retrieval.py
```

## Quickstart (local)

```bash
cd agent
cp .env.example .env
# edit .env: paste your ANTHROPIC_API_KEY (sk-ant-...)

uv sync                                              # creates .venv, installs deps
uv run pytest -q                                     # 20 tests, no API calls

uv run analyst "Who is the greatest Test bowler ever?"
uv run analyst "Compare Imran Khan and Kapil Dev in Tests" --trace
uv run analyst "Top 5 Indian batters in ODIs"
```

## Run the API locally

```bash
uv run uvicorn api.main:app --reload --port 8080
```

Then in another terminal:

```bash
curl -s -X POST http://localhost:8080/ask \
  -H 'content-type: application/json' \
  -d '{"question": "Who is the greatest Test bowler ever?"}' | jq .
```

## Deploy to Modal

```bash
pip install modal
modal token new                       # one-time, opens browser

modal secret create cricket-analyst \
  ANTHROPIC_API_KEY=sk-ant-... \
  LANGFUSE_PUBLIC_KEY=pk-lf-... \
  LANGFUSE_SECRET_KEY=sk-lf-...

modal deploy deploy/modal_app.py
```

Modal prints a public URL like
`https://you--cricket-analyst-fastapi-app.modal.run`. Set this on the
Cloudflare worker:

```bash
cd ../worker
npx wrangler secret put AGENT_ENDPOINT
# paste the modal URL
npx wrangler deploy
```

The Analyst tab on the live site will now stream answers from your hosted
agent. No further changes needed.

## Observability

Add LangFuse keys to your `.env` (local) or `modal secret create`
(production). Every run produces a hierarchical trace:

```
session (root)
├── planner          🕒 1.2s · 380 tokens
├── retriever        🕒 0.04s
├── tool_executor    🕒 3.1s · 1240 tokens
│   ├── tool: query_players
│   ├── tool: get_player(Tendulkar)
│   └── tool: analyze_career_arc(Tendulkar)
├── synthesizer      🕒 1.8s · 520 tokens
└── critic           🕒 0.9s · 220 tokens · grounded=true · final
```

The `trace_url` is returned in every API response and rendered as a "View
full trace" link on the frontend.

## Trade-offs & failure modes (the bit interviewers actually want)

### Choices I'd defend in an interview

1. **LangGraph over LangChain Expression Language (LCEL).** LCEL is a DAG;
   real agents need cycles (tool loop, critic loop, HITL pauses) and
   per-thread checkpointing for resumability. LangGraph's `StateGraph`
   gives me explicit nodes with typed state — easier to reason about,
   trace, and unit-test than LCEL chains.

2. **Pydantic structured outputs everywhere.** `with_structured_output(Plan)`
   replaces every "parse this JSON from the model" hack with validation at
   the boundary. The single biggest reliability win.

3. **Critic as a separate model call, not a retry-on-exception.** Retries
   on parse failure don't fix shallow / hallucinated answers. The critic
   explicitly checks grounding, intent fit, and structure, and feeds its
   issues back to the synthesizer for a targeted regen.

4. **Hard iteration caps before quality termination.** Tool loop capped at
   4 iterations, critic at 2 revisions. Cost containment first; once we
   have eval data we can replace caps with quality-based termination.

5. **BM25 before semantic retrieval.** Cricket queries are proper-noun
   heavy ("Imran Khan", "South African pacers", "1990s Pakistan"). Lexical
   retrieval works well for the majority; I left a clean `Retriever`
   protocol so a semantic implementation can land later with a one-line
   swap, after I've benchmarked it.

6. **Modal over Vercel/Railway.** Free tier credit covers thousands of
   agent runs, cold starts under 2s, `@asgi_app` makes deployment one line.
   Per-replica state via in-memory checkpointer; trivial to move to
   Redis/Postgres-backed checkpointing if I scale to multi-replica.

7. **Cloudflare Worker as gateway, not endpoint.** Origin lock, CORS,
   per-IP rate limit (with separate buckets for direct vs agent calls
   because the agent costs ~20× more per request), zero-cold-start.

### Failure modes already handled

- **Hallucinated numbers** → caught by critic + structured `cited_players`
- **Tool-call storm** → iteration cap; LangFuse alerts on >4 calls
- **Stale data** → agent reads the same JSON the site does, so staleness
  shows up on both surfaces; single source of truth
- **Model rate limit / network failure** → worker returns 502 cleanly;
  frontend renders a recoverable error

### Failure modes still open (transparent about them)

- **Tool-args malformed at the model layer** → currently swallowed by the
  tool wrapper (`except Exception → error dict`). Should surface to the
  agent so it can self-correct.
- **Critic agreement bias** → using the same model for synthesis and
  critique means agreement is over-rewarded. Mitigate by using a different
  model family for the critic (e.g. Sonnet for critic, Haiku for everything
  else) or by running self-consistency at the synthesis step.
- **Plan-time format inference** → the planner currently defaults to
  "tests" when context is ambiguous; should ask the user instead via the
  HITL gate.
- **No semantic retrieval yet** → BM25 misses queries like "best
  middle-order anchor in pressure chases". Easy upgrade path; not done.

### What I'd do differently at 100× scale

- Move checkpointer to Redis or Postgres (multi-replica HITL resume)
- Add a small router model before the planner ("does this even need
  agentic? answer directly if not") — saves ~80% on simple queries
- Cache plans on `embedding(question)` with cosine similarity; if a
  semantically-equivalent question was asked, reuse plan + retrieval
- Background-precompute popular questions overnight via the same agent
  and serve from cache on the hot path
- Move from `claude-haiku` to a tier matrix: cheap model for planner +
  critic, capable model for synthesizer only

## Cost notes

Haiku 4.5: ~$0.0008/1k input, $0.004/1k output. A typical 5-tool-call
agent run uses ~3.5k input + 1k output across all five LLM nodes, so
~$0.007/query. The worker's daily per-IP cap (30 agent / 60 direct) keeps
worst-case abuse cost at ~$0.20/IP/day.
