#  IssueRadar

> **AI-powered GitHub issue triage** — IssueRadar monitors your GitHub Issues, PR comments, and Slack threads, uses Oxlo AI to classify severity, detect duplicates, and auto-draft structured tickets, then sends your team a daily zero-noise digest.

Built for **OxBuild** by [your-name] · [your-registered-oxlo-email@example.com]

**Live Demo:** [issueradar-demo.vercel.app](https://issueradar-demo.vercel.app)

---

## The Problem

Every developer team has:
- 40+ open GitHub issues with no severity labels
- Bug reports buried in Slack that never become tickets
- The same bug filed 3 times by different users
- No idea which issue to fix first

IssueRadar solves all of this with four sequential Oxlo AI calls per issue.

---

## How It Works

### The 4-Call Oxlo Pipeline

Every issue or Slack message runs through four Oxlo model calls:

| # | Call | Input → Output | Purpose |
|---|------|----------------|---------|
| 1 | **Classify** | Raw text → `{type, confidence}` | Determine: bug / feature / question / noise |
| 2 | **Extract** | Raw text + type → structured fields | Pull title, description, steps, expected/actual, affected module |
| 3 | **Score** | Structured fields → `{score 1–5, reason, label}` | Rate severity with one-line justification |
| 4 | **Deduplicate** | New issue + existing summaries → `{duplicateIds[]}` | Cross-source duplicate detection |

Calls 1–2 run sequentially. Calls 3 and 4 run in parallel via `Promise.all` — cutting latency without sacrificing accuracy.

### Oxlo Model Used

**Model:** `oxlo-1` (configured via `OXLO_MODEL` env var)

Chosen because it offers the best balance of JSON instruction-following accuracy and response speed for structured extraction tasks. Each call uses a tightly-scoped system prompt — the model never needs to reason about context beyond the single task it's given.

---

## Features

| Feature | Oxlo API Calls | Purpose |
|---------|---------------|---------|
| Issue type classification | Call 1 | Filters noise before running the full pipeline |
| Structured field extraction | Call 2 | Produces clean, normalized bug reports |
| Severity scoring 1–5 | Call 3 | Auto-labels GitHub issues with `severity/*` |
| Semantic deduplication | Call 4 | Detects duplicate issues across GitHub + Slack |
| Auto-comment on GitHub | Uses Call 2+3 output | Posts structured analysis as a GitHub comment |
| Git blame assignee suggestion | GitHub Commits API | Suggests assignee based on recent committers |
| Slack listener | Bolt.js | Captures bug reports from Slack channels |
| Daily digest | Cron + Slack | Zero-noise summary posted at 9am |
| Web dashboard | Next.js + Vercel | Stats, live demo, digest viewer |

---

## Installation

### Prerequisites
- Node.js 20+
- A GitHub App or Personal Access Token
- A Slack App with Socket Mode enabled
- An Oxlo API key from [portal.oxlo.ai](https://portal.oxlo.ai)

### Backend

```bash
git clone https://github.com/your-username/issueradar
cd issueradar
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

### Web Dashboard

```bash
cd web
npm install
cp .env.example .env.local
# Set OXLO_API_KEY, BACKEND_URL
npm run dev
# Open http://localhost:3001
```

### Vercel Deploy (Dashboard)

```bash
cd web
npx vercel
# Set env vars in Vercel dashboard:
# OXLO_API_KEY, OXLO_BASE_URL, OXLO_MODEL, GITHUB_TOKEN, BACKEND_URL
```

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `OXLO_API_KEY` | Yes | Your Oxlo API key |
| `OXLO_BASE_URL` | No | Defaults to `https://portal.oxlo.ai/v1` |
| `OXLO_MODEL` | No | Defaults to `oxlo-1` |
| `GITHUB_TOKEN` | Yes | GitHub PAT (repo + issues scopes) |
| `GITHUB_WEBHOOK_SECRET` | Yes | Webhook secret from your GitHub App |
| `SLACK_BOT_TOKEN` | Yes | `xoxb-...` bot token |
| `SLACK_APP_TOKEN` | Yes | `xapp-...` for Socket Mode |
| `SLACK_SIGNING_SECRET` | Yes | From Slack App settings |
| `SLACK_CHANNEL_IDS` | Yes | Comma-separated channel IDs to monitor |
| `DIGEST_SLACK_CHANNEL` | Yes | Channel ID for daily digest |
| `DIGEST_CRON` | No | Cron schedule, default `0 9 * * *` (9am UTC) |
| `DB_PATH` | No | SQLite file path, default `./issueradar.db` |

---

## Project Structure

```
issueradar/
├── src/
│   ├── index.ts              # Entry point: Express + Slack + cron
│   ├── pipeline.ts           # Wires all 4 Oxlo calls (3+4 parallel)
│   ├── oxlo/
│   │   ├── client.ts         # OxloClient: chat + chatStream
│   │   ├── classifier.ts     # Call 1: type classification
│   │   ├── extractor.ts      # Call 2: structured field extraction
│   │   ├── scorer.ts         # Call 3: severity scoring
│   │   └── deduplicator.ts   # Call 4: duplicate detection
│   ├── github/
│   │   ├── webhook.ts        # HMAC verification + event dispatch
│   │   ├── issues.ts         # Label issues, post AI comments
│   │   └── blame.ts          # Suggest assignee from commit history
│   ├── slack/
│   │   ├── listener.ts       # Bolt app: monitor channels
│   │   └── digest.ts         # Format + post daily digest
│   └── storage/
│       ├── db.ts             # SQLite: store issues, digests, stats
│       └── embeddings.ts     # TF-IDF similarity for dedup pre-filtering
└── web/                      # Next.js dashboard (Vercel)
    ├── app/
    │   ├── page.tsx          # Dashboard: stats + severity breakdown
    │   ├── demo/page.tsx     # Live demo: paste URL → watch pipeline
    │   ├── digest/page.tsx   # Today's digest
    │   └── api/
    │       ├── analyze/      # SSE stream: runs 4-call pipeline
    │       ├── stats/        # Proxies backend stats
    │       └── digest/       # Proxies backend digest
    └── lib/                  # Oxlo client + pipeline modules for web
```

---

## Demo Script

1. Open [issueradar-demo.vercel.app/demo](https://issueradar-demo.vercel.app/demo)
2. Paste any public GitHub issue URL
3. Watch four Oxlo calls fire with live step indicators:
   - `Classifying…` → `bug (94%)`
   - `Extracting…` → structured fields appear
   - `Scoring…` + `Deduplicating…` (in parallel) → `4/5 — major feature broken`
4. See the full structured output: severity, affected module, steps to reproduce, suggested label
5. Check GitHub — IssueRadar has auto-labeled the issue and posted an analysis comment

---

## Architecture Diagram

```
GitHub Issue / PR Comment
        │
        ▼
   Express Webhook
        │
        ▼
  [Pipeline: analyzeIssue()]
        │
   ┌────┴────┐
   │ Call 1  │ classify
   └────┬────┘
        │
   ┌────┴────┐
   │ Call 2  │ extract
   └────┬────┘
        │
   ┌────┴──────────────┐
   │ Call 3  │ Call 4  │ (Promise.all)
   │  score  │  dedup  │
   └────┬────┴────┬────┘
        │         │
        └────┬────┘
             │
    ┌────────┼────────┐
    │        │        │
  SQLite  GitHub   Slack
  store   label+  (if bug)
          comment
```

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend in watch mode |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled output |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier format |
| `cd web && npm run dev` | Start dashboard on :3001 |
| `cd web && npx vercel` | Deploy dashboard to Vercel |

---

## Registered Oxlo Email

[your-registered-oxlo-email@example.com]

---

## License

MIT
