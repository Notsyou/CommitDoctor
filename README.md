# Commit Doctor (ComDoc)

A GitHub webhook receiver that records commits from **one repository** and turns each
day's activity into a short summary on a web dashboard: who committed, how many commits,
when, and how the day compares with recent days. It also tracks a user-set project
deadline and flags notable deviations from the recent-activity baseline.

**Stack:** Node.js + Express, SQLite (Node's built-in `node:sqlite`, so nothing native to compile), and a plain HTML/CSS/JS dashboard (no framework, no build step).

## Quick start

```bash
# needs Node.js 22.13 or newer (check with: node -v)
npm install
cp .env.example .env # optional: GITHUB_WEBHOOK_SECRET is auto-generated if left empty
npm run seed # optional: two weeks of demo data
npm start # http://localhost:3000
npm test # 39 tests
```

Try it without GitHub (signs the request the same way GitHub does):

```bash
npm run simulate -- --author alice --count 3
npm run simulate -- --event ping
```

## Connecting a real repository

From the dashboard:

1. Type `owner/name` (or paste the GitHub URL) and click **Track via webhook**. A setup panel opens.
2. **Public URL:** GitHub can't reach `localhost`. While developing, run `npx smee-client --target http://localhost:3000/webhook/github`
   (or `ngrok http 3000`) and paste the public URL into step 1. On a public server it's filled in for you.
3. Then either:
   - **2a. Automatic:** paste a GitHub token with webhook access (classic `admin:repo_hook`, or fine-grained
     *Webhooks: read and write*) and click **Create webhook on GitHub**. The token is used once and not stored.
   - **2b. Manual:** open the linked *Add webhook* page and copy the Payload URL and Secret shown in the panel.
4. The panel switches to "Connected" when GitHub's ping arrives, and shows the last push after that.

The webhook secret comes from `GITHUB_WEBHOOK_SECRET` if set; otherwise one is generated on first start and kept in the database.

## How it works


- **Signature check.** Every delivery is verified with HMAC-SHA256 (`X-Hub-Signature-256`) against the raw body. Unsigned or wrongly signed requests get `401` and are logged.
- **No double counting.** `UNIQUE(sha)` means redeliveries and repeated pushes store a commit once. Commits GitHub flags `distinct: false` (already in the repo, e.g. branch commits re-listed when a PR is merged) are skipped. Merge commits are stored and flagged.
- **What a "day" is.** A calendar day in `TIMEZONE` (default `Asia/Manila`), based on the commit's own timestamp.
- **Daily summary.** A small scheduler notices when the local date changes and saves the finished day. If the server was off at midnight, a catch-up pass on the next start summarizes the missed days. Today is always shown live; past days show the saved snapshot.
- **Rolling-baseline flags.** Each time a summary is (re)generated, the day is compared against the average of the preceding `SUMMARY_COMPARISON_DAYS` days. Notable deviations (activity clearly above/below baseline, or a contributor gone quiet for a full comparison window) are stored as discrete flags rather than just embedded in the summary text.
- **Deadline tracking.** A team enters a deadline date (and, optionally, which repo to track) via `POST /api/settings`; `GET /api/settings` returns days remaining.
- **Summaries are rule-based, not AI-generated.** Same commits in, same summary out, which keeps the prototype easy to evaluate.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | auto-generated | If empty, a random secret is generated and stored in the database. |
| `GITHUB_REPO` | any | `owner/name`. Fallback default; can be overridden at runtime via `POST /api/settings`. |
| `TIMEZONE` | `Asia/Manila` | Defines where a day starts and ends. |
| `SUMMARY_MIN_COMMITS` | `1` | Days with fewer commits are not saved (the skip is logged). |
| `SUMMARY_COMPARISON_DAYS` | `7` | Length of the "recent days" rolling baseline, used for both the summary comparison and inactivity flags. |
| `CHURN_WINDOW_DAYS` | `21` | Rolling window for the deadline prediction's commit rate and code churn. |
| `DB_PATH` | `./data/commitdoctor.db` | SQLite file. |
| `ADMIN_TOKEN` | none | If set, required as `Authorization: Bearer <token>` for write endpoints (`/api/summaries/:date/generate`, `/api/settings`, `/api/subscribers`, `/api/webhook-setup`). |
| `PORT` | `3000` | |

## API

| Method and path | Returns |
|---|---|
| `POST /webhook/github` | GitHub delivery endpoint |
| `GET /api/overview` | Repo, timezone, totals, last push, active rules, current settings |
| `GET /api/trend?days=14` | Commits per day, zero-filled |
| `GET /api/summaries/:date` | Summary for a day (`source`: `saved` or `live`) |
| `GET /api/summaries?limit=30` | Saved summaries, newest first |
| `POST /api/summaries/:date/generate` | Save (or re-save) a summary now — admin |
| `GET /api/commits?date=YYYY-MM-DD` | Commits of a day |
| `GET /api/settings` | Current deadline and tracked repo, plus days remaining |
| `POST /api/settings` | Set/clear `deadline_date` and/or `tracked_repo` — admin |
| `GET /api/webhook-setup` | Secret and values to paste into GitHub — admin |
| `POST /api/webhook-setup/connect` | Create/update the GitHub webhook with a one-time token (`repo`, `token`, `payload_url`) — admin |
| `GET /api/subscribers` | Notification recipients |
| `POST /api/subscribers` | Add a recipient (`name`, `email`) — admin |
| `DELETE /api/subscribers/:id` | Remove a recipient — admin |
| `GET /api/flags?date=YYYY-MM-DD` | Rolling-baseline deviations, optionally filtered by day |
| `GET /api/activity` | Webhook deliveries and summary runs (the prototype's own log) |

## Database

`commits` (one row per unique SHA), `summaries` (one JSON snapshot per day),
`webhook_events` (every delivery: accepted, ignored or rejected), `summary_runs`
(every summary attempt: saved or skipped, and what triggered it), `subscribers`
(notification recipients), `project_settings` (single row: deadline and tracked
repo), and `flags` (discrete rolling-baseline deviations, one row per flag per day).

## Layout