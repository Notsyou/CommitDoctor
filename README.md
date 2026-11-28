# Commit Doctor (ComDoc)

A GitHub webhook receiver that records commits from **one repository** (or, optionally, several) and turns each
day's activity into a short summary on a web dashboard: who committed, how many commits,
when, and how the day compares with recent days. It also tracks a user-set project
deadline per repository and flags notable deviations from the recent-activity baseline.

**Stack:** Node.js + Express, SQLite (Node's built-in `node:sqlite`, so nothing native to compile), and a plain HTML/CSS/JS dashboard (no framework, no build step).

## Quick start

```bash
# needs Node.js 22.13 or newer (check with: node -v)
npm install
cp .env.example .env # optional: needed for email (see "Setting up email"); the webhook secret is auto-generated
npm run seed # optional: two weeks of demo data
npm start # http://localhost:3000
npm test
```

Try it without GitHub (signs the request the same way GitHub does):

```bash
npm run simulate -- --author alice --count 3
npm run simulate -- --event ping
```

## Connecting a real repository

From the dashboard:

1. Type `owner/name` (or paste the GitHub URL) and click **Track via webhook**. The last 14 days of commits are pulled
   from GitHub's API right away (no token needed for public repos), and a setup panel opens for live updates.
2. **Public URL:** GitHub can't reach `localhost`. While developing, run `npx smee-client --target http://localhost:3000/webhook/github`
   (or `ngrok http 3000`) and paste the public URL into step 1 of the panel. On a public server it's filled in for you.
3. Open the panel's *Add webhook* link and paste the Payload URL and Secret shown there (content type `application/json`,
   just the push event).
4. The panel switches to "Live updates on" when GitHub's ping arrives, and shows the last push after that.

The webhook secret comes from `GITHUB_WEBHOOK_SECRET` if set; otherwise one is generated on first start and kept in the database.

## Deploying (Render)

`render.yaml` is a Render Blueprint: in Render choose **New > Blueprint** and pick this repo.
Render serves the app over HTTPS and generates `ADMIN_TOKEN` and `GITHUB_WEBHOOK_SECRET`
(both are kept in Render's environment, not in the repo). Set `TOKEN_ENCRYPTION_KEY` and the
`SMTP_*` values yourself in the Render dashboard. Your webhook Payload URL is
`https://<service>.onrender.com/webhook/github`.

Free-plan limits: the service sleeps after about 15 minutes idle (GitHub retries failed
deliveries, and the poller looks back 14 days), and **the disk is wiped on every deploy or
restart, so the SQLite database is lost**. For anything beyond a demo, attach a persistent disk
and point `DB_PATH` at it.

Vercel and Netlify are not supported: they run short-lived serverless functions, while
Commit Doctor needs a long-running process (scheduler, poller) and a writable disk.

## Who uses it: access and email

Commit Doctor has **no user accounts or logins**. One running copy serves one team:

- **Viewers.** Anyone who can open the page sees the dashboard. Everyone sees the same repository: which one is shown is a server-wide setting, not a per-person choice, so switching it switches it for everyone.
- **Admin.** Every change (repositories, deadline, settings, subscribers, test email) needs `ADMIN_TOKEN`, entered once in Settings. Whoever has the token is the admin. With no token set, changes are allowed only from the server machine itself.
- **Email recipients.** Each repository has a subscriber list (name + email) that the admin manages in Settings. Subscribers don't log in or install anything; they only receive the emails.
- **One sender.** All email goes out from the single SMTP account in `.env`. Run **one** copy per team: every copy has its own database and subscriber list, so two copies subscribing the same people send every email twice.

`.env` is git-ignored because it holds secrets (SMTP password, admin token). Anyone who clones the repo gets only `.env.example` and must fill in their own.

### Setting up email (Gmail)

Email works on a local computer as well as on a server: it only needs outgoing internet access. It is off until `SMTP_HOST` is set.

1. On the Google account that will send the emails, turn on **2-Step Verification** (myaccount.google.com/security).
2. Create an **App Password** at myaccount.google.com/apppasswords (name it e.g. "Commit Doctor") and copy the 16-letter code. Your normal Gmail password does not work: Gmail rejects it with `535 Username and Password not accepted`. The same error appears if the App Password was made on a different account than `SMTP_USER`.
3. In `.env` set:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=you@gmail.com
   SMTP_PASS=<the 16-letter App Password>
   SMTP_FROM=Commit Doctor <you@gmail.com>
   ```
4. Restart. The startup banner should say `Email : on (smtp.gmail.com)`.
5. Add subscribers in Settings. `POST /api/notifications/test` (admin) with `{"to": "..."}` sends a test email.

An App Password can be deleted at any time without touching the account's real password; do that if it ever leaks.

### When emails are sent

Emails only go out **while the server is running**. On a laptop that is off, nothing is sent until it starts again.

- **Deadline emails** (checked every 30 seconds). Need a deadline set for the repository. If the team is on pace (or there isn't enough history yet), a reminder goes out only when the deadline is exactly 7, 3 or 1 day(s) away. If it is at-risk or behind, one goes out every day of the final week (reminder at 4-7 days, urgent at 2-3, final at 0-1). At most one email per repository, per day, per level; a failed send is retried after 15 minutes. `POST /api/notifications/check` (admin) runs the check immediately.
- **Flag emails** (at midnight in `TIMEZONE`). When a day ends and its summary has flags (activity clearly above/below baseline, a contributor gone quiet), the flags are emailed. Generating a summary by hand does not send email.

Every send is logged in the terminal (`[notify] sent ...` or `[notify] failed to email ...`).

## How it works


- **One repo at a time (default), or several.** In **single** mode Commit Doctor follows one repository. Connecting another one pauses and hides the old one; its history is kept, and it can be switched back to from Settings (switching back catches up on the commits it missed). In **multiple** mode every connected repository keeps receiving commits, daily summaries, flags and emails, and the top bar's selector hops between them. There is no combined view: everything on the dashboard (summary, trend, contributors, flags, deadline prediction) is scoped to the shown repository, and saved summaries, flags, deadlines and subscribers are stored per repository. Removing a repository deletes all of its data.
- **Signature check.** Every delivery is verified with HMAC-SHA256 (`X-Hub-Signature-256`) against the raw body. Unsigned or wrongly signed requests get `401` and are logged.
- **No double counting.** `UNIQUE(sha)` means redeliveries and repeated pushes store a commit once. Commits GitHub flags `distinct: false` (already in the repo, e.g. branch commits re-listed when a PR is merged) are skipped. Merge commits are stored and flagged.
- **What a "day" is.** A calendar day in `TIMEZONE` (default `Asia/Manila`), based on the commit's own timestamp.
- **Daily summary.** A small scheduler notices when the local date changes and saves the finished day. If the server was off at midnight, a catch-up pass on the next start summarizes the missed days. Today is always shown live; past days show the saved snapshot.
- **Rolling-baseline flags.** Each time a summary is (re)generated, the day is compared against the average of the preceding `SUMMARY_COMPARISON_DAYS` days. A day counts as above or below that baseline only when it differs by 25% **and** by at least `SUMMARY_MIN_DIFFERENCE` commits (default 3), so a small repo isn't flagged for one extra commit. For a quiet repo the wording uses rates ("well above the usual 0.3 a day") rather than huge percentages. Notable deviations (activity clearly above/below baseline, or a contributor gone quiet for a full comparison window) are stored as discrete flags rather than just embedded in the summary text.
- **Deadline tracking.** Each repository has its own deadline, set in Settings (`POST /api/settings` with `deadline_date`). `GET /api/prediction` judges whether the recent pace will make it.
- **Notifications.** Each repository has its own subscriber list. Flags and deadline reminders are emailed to it; on the dashboard, "unread" is remembered per browser.
- **Privacy.** Committer emails from push payloads are never stored; a commit with no name or username is labelled with a masked email (`j***@example.com`).
- **One person, one contributor.** GitHub attaches a username only when the author's email is linked to an account, so early commits can arrive with just a git name. A name-only commit is attributed to the username whose commits in the same repo use the same git name (ignoring case), but only when exactly one username does; two accounts sharing a name stay separate. Existing data is repaired on startup (`src/identity.js`), including inactivity flags that the split had raised. Subscriber emails are masked in the API and in logs.
- **Commit intent (NLP).** Each commit message is labelled feature, fix, docs, refactor, test or chore by a TF-IDF + logistic-regression model trained in `nlp/` and run in Node by `src/intent.js` (no Python needed at runtime). Labels below 0.45 confidence are shown with a `?` (on the held-out test set, labels at or above it were right 83% of the time), and the daily summary says what kind of work dominated.
- **Background sync.** A webhook-tracked public repo is also re-pulled through GitHub's API every `SYNC_INTERVAL_MS` (5 min), so the dashboard stays current even when webhooks can't reach the server.
- **Summaries are rule-based, not AI-generated.** Same commits in, same summary out, which keeps the prototype easy to evaluate.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | auto-generated | If empty, a random secret is generated and stored in the database. |
| `GITHUB_REPO` | any | `owner/name` to show on a fresh install. After that the dashboard's Settings decide; a repo that was stopped or removed never comes back on its own. |
| `TIMEZONE` | `Asia/Manila` | Defines where a day starts and ends. |
| `SUMMARY_MIN_COMMITS` | `1` | Days with fewer commits are not saved (the skip is logged). |
| `SUMMARY_COMPARISON_DAYS` | `7` | Length of the "recent days" rolling baseline, used for both the summary comparison and inactivity flags. |
| `SUMMARY_MIN_DIFFERENCE` | `3` | Fewest commits a day must differ from its baseline to count as above/below it (and raise an activity flag). |
| `CHURN_WINDOW_DAYS` | `21` | Rolling window for the deadline prediction's commit rate and code churn. |
| `SYNC_INTERVAL_MS` | `300000` | Re-pull the tracked repo through GitHub's API this often (5 min), so it stays current without a working webhook. `0` turns it off. |
| `DB_PATH` | `./data/commitdoctor.db` | SQLite file. |
| `ADMIN_TOKEN` | none | Required as `Authorization: Bearer <token>` for every write endpoint. If empty, writes are accepted only from the server machine itself (loopback, local `Host`/`Origin`, no proxy headers), so a tunnel or host such as ngrok or Render can't bypass it. **Set it on any public deploy.** |
| `SMTP_HOST` | none | SMTP server, e.g. `smtp.gmail.com`. Empty turns email off. See [Setting up email](#setting-up-email-gmail). |
| `SMTP_PORT` | `587` | `587` (STARTTLS) or `465` (TLS). |
| `SMTP_USER` / `SMTP_PASS` | none | Login for the sending account. For Gmail, `SMTP_PASS` is an App Password, not the account password. |
| `SMTP_FROM` | `SMTP_USER` | Sender shown to recipients, e.g. `Commit Doctor <you@gmail.com>`. |
| `PORT` | `3000` | |

## API

| Method and path | Returns |
|---|---|
| `POST /webhook/github` | GitHub delivery endpoint |
| `GET /api/overview` | Shown repo, `repo_mode`, followed repositories, timezone, totals, last push, active rules, settings |
| `GET /api/trend?days=14` | Commits per day, zero-filled |
| `GET /api/summaries/:date` | Summary for a day (`source`: `saved` or `live`) |
| `GET /api/summaries?limit=30` | Saved summaries, newest first |
| `POST /api/summaries/:date/generate` | Save (or re-save) a summary now — admin |
| `GET /api/commits?date=YYYY-MM-DD` | Commits of a day |
| `GET /api/commits/:sha` | One commit (4–40 hex characters of its SHA), with its day and related commits by the same contributor |
| `GET /api/contributors?date=YYYY-MM-DD` | Everyone who has committed, with last commit and 7-day count |
| `GET /api/prediction` | Deadline pace for the shown repo |
| `GET /api/settings` | The shown repo's deadline, plus `repo_mode` |
| `POST /api/settings` | Set/clear `deadline_date` (optional `repo`, default the shown one) and/or set `repo_mode` (`single` or `multi`; switching to single pauses the other repos) — admin |
| `GET /api/repository` | Shown repo, how it's connected (webhook / poll), sync status, mode and all repositories |
| `GET /api/repositories` | Every known repository: followed, paused or hidden |
| `POST /api/repository` | Connect a repo (`repo`, `method`: `public`, `webhook` or `poll`, optional `token`, `payload_url`). In single mode, replacing a shown repo needs `replace: true` (otherwise `409 needs_replace`) — admin |
| `POST /api/repository/active` | Show (and follow) a known repo (`repo`); a paused one catches up first — admin |
| `POST /api/repository/scan` | Pull the shown repo's recent commits now — admin |
| `DELETE /api/repository` | Stop following the shown repo (history kept, poll token deleted) — admin |
| `DELETE /api/repositories/:owner/:name` | Remove a repo and delete all of its data — admin |
| `GET /api/webhook-setup` | Secret and values to paste into GitHub — admin |
| `POST /api/admin/ping` | `{ok:true}` if the caller may make changes; used by the dashboard to show Open / Locked / Unlocked — admin |
| `GET /api/subscribers` | The shown repo's notification recipients |
| `POST /api/subscribers` | Add a recipient (`name`, `email`) to the shown repo — admin |
| `DELETE /api/subscribers/:id` | Remove a recipient — admin |
| `GET /api/analytics?days=30\|60\|90` | For the shown repo: commits per day with the rolling baseline and flags, the weekly work mix (intent labels) and churn, each contributor's commits per week, and (with a deadline) the pace prediction recomputed for every day |
| `GET /api/flags?date=YYYY-MM-DD` | Rolling-baseline deviations of the shown repo, optionally filtered by day (`limit` for the newest) |
| `GET /api/activity` | Webhook deliveries, summary runs and emails (the prototype's own log) |
| `POST /api/views/events`, `GET /api/views/stats` | Anonymous usage of the Digest / Team / Timeline views |
| `/api/study/*` | Feasibility study: sessions, answers, SUS, results and `export.csv` (results are admin) |

## Database

`commits` (one row per unique SHA), `summaries` (one JSON snapshot per repo per day),
`webhook_events` (every delivery: accepted, ignored or rejected), `summary_runs`
(every summary attempt: saved or skipped, and what triggered it), `subscribers`
(notification recipients, per repo), `repositories` (every known repo: followed or
paused, its deadline and sync status), `project_settings` (single row: shown repo and
`repo_mode`), `flags` (discrete rolling-baseline deviations, one row per flag per day),
`notifications` (every email attempt: sent, failed or skipped) and `tracked_repos` (private repos checked with a token).

## Layout

- `src/`: server (`server.js`, `api.js`, `webhook.js`, `repository.js` for single/multi repo state, `analytics.js`, `summary.js`, `predict.js`, `notify.js`, `scheduler.js`, `study.js`, `views.js`, `db.js`).
- `public/`: the dashboard, plain HTML/CSS/JS with no build step.
  - Pages: `index.html` (Dashboard: the day's summary, Digest / Team / Timeline views, commits per day, notable changes), `repository.html`, `commit.html` (a day's commits, or one commit with `?sha=`), `notifications.html` (flags, daily and weekly digests), `analytics.html` (activity vs. baseline, work mix, pace vs. deadline, code churn, contributor activity over 30/60/90 days), `settings.html` (repositories, mode, deadline, email alerts, admin token, system log) and `study.html` (the standalone feasibility study).
  - `css/styles.css`; `js/api.js` (fetch wrapper and admin-token prompt), `js/core.js` (shared shell and helpers), `js/tour.js` (the guided tour: offered once on the first visit, replayable from **Tutorial** in the sidebar; it walks Dashboard → Repositories → Commits → Notifications → Analytics → Settings and points at elements marked `data-tour`) and one script per page.
- `test/`: `npm test`.
- `nlp/`: training for the commit-intent model.