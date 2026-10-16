# Automation Architect

A web app that runs a structured, five-phase operations discovery conversation and ends with an interactive HTML dashboard: scored automation opportunities, workflow maps with flagged handoffs, a system architecture map, a phased roadmap, and KPIs.

Powered by OpenRouter (default model: `anthropic/claude-fable-5.1`). No database — each browser keeps its own session in localStorage.

## Layout

```
server.js                      Express server; streams /api/chat to OpenRouter, serves /public
prompt/system-prompt.md        The Automation Architect system prompt (edit freely)
public/index.html, app.js      Chat UI, phase tracker, dashboard builder
public/dashboard-template.html Self-contained dashboard; the app injects the model's JSON into its DATA block
render.yaml                    Render blueprint
```

## Run locally

```bash
npm install
cp .env.example .env     # add your OpenRouter key
export $(cat .env | xargs) && npm start
# open http://localhost:3000
```

## Deploy on Render

1. Push this folder to a GitHub repo.
2. Render → New → Blueprint → pick the repo (it reads `render.yaml`), or New → Web Service with build `npm install`, start `npm start`.
3. In the service's **Environment** tab set:
   - `OPENROUTER_API_KEY` — your key (required)
   - `OPENROUTER_MODEL` — defaults to `anthropic/claude-fable-5.1`
   - `APP_PASSWORD` — optional shared password so the service isn't open to the world
   - `APP_URL` — your Render URL (optional; sent to OpenRouter as the referer)
4. Deploy. Health check is `/healthz`.

## How a session works

1. User describes org, tool stack, and top three bottlenecks.
2. The architect runs Discovery → Workflow Mapping → Opportunity Audit → Architecture & Planning, gating each phase on the user's confirmation. The sidebar tracks the phase.
3. In Phase 5 the model emits one ` ```json ` block matching the schema in `prompt/system-prompt.md` §7. The client detects it, hides the raw JSON, and shows a **Dashboard ready** card with Open / Download.
4. Open renders the dashboard in a new tab from `dashboard-template.html`; Download saves a single `.html` file anyone can open offline. Roadmap checkboxes and phase statuses persist in the viewer's browser.

## Customizing

- **Prompt** — edit `prompt/system-prompt.md`. If you change the JSON schema in §7, mirror the change in the `DATA` sample and renderer in `public/dashboard-template.html`.
- **Model** — set `OPENROUTER_MODEL` to any OpenRouter chat model ID.
- **Look** — colors live in `:root` at the top of `index.html` and `dashboard-template.html`.
