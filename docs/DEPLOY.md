# Deploying for always-on alerts

The app's **server-side alert poller** (Settings → _Server-side watching_) only runs while
the server process is up. To get alerts **even when your computer is off**, run the server
on a small always-on box — any cheap VPS or container host works. The repo ships a
production `Dockerfile` and `docker-compose.yml`, so this is a copy-paste exercise.

> This is decision-support tooling that **never places trades**. It still holds your
> journal, positions, and provider key — treat the deployment as private. **Read the
> security section before exposing anything.**

---

## ⚠️ Security first — protect access

By default the app has **no accounts**. Anyone who can reach the port can read your
trades, settings, and trigger provider calls. So either keep it private **or** turn on the
built-in login:

0. **App login (simplest for a public URL).** Set a password and the app gates every data
   route behind it, so you can safely keep the public HTTPS URL:

   ```bash
   # local: in server/.env →  APP_PASSWORD=your-long-passphrase
   # Fly:
   fly secrets set APP_PASSWORD='your-long-passphrase' -a your-stock-app
   ```

   Use a long, unique passphrase. It's one shared password (no usernames). The session is
   an HttpOnly cookie; sign out from **Settings → Account**. If you reach the app over
   plain http (e.g. `fly proxy`), also set `AUTH_SECURE_COOKIE=false`.

   For a second factor, enable **two-factor (TOTP)** in **Settings → Account** — login then
   also asks for an authenticator-app code. If you ever lose the authenticator, set
   `fly secrets set DISABLE_MFA=true` to log in with the password only, then re-enroll.

Or keep it off the public internet entirely (you can combine these with the login):

1. **Tailscale.** Install it on the VPS and on your phone/laptop; reach the app at
   `http://<tailscale-ip>:3001` over your private tailnet. Nothing is exposed publicly. The
   webhook still goes _out_ to Slack/Discord/ntfy, so phone alerts work regardless.
2. **SSH tunnel.** Leave the port closed and forward it when you need the UI:
   `ssh -L 3001:localhost:3001 you@your-vps` → open `http://localhost:3001`.
3. **Reverse proxy with auth + HTTPS.** Put Caddy or nginx in front with HTTP basic-auth
   and a TLS cert, and firewall 3001 so only the proxy reaches it.

At a minimum, run a firewall (e.g. `ufw allow OpenSSH` then `ufw enable`) so only SSH —
and your chosen access method — is reachable. The compose file maps `3001:3001`; if you
rely on Tailscale/SSH only, change it to `127.0.0.1:3001:3001` so Docker doesn't punch it
through the host firewall.

---

## What you need

- A VPS with **1 vCPU / 1 GB RAM** (plenty) — any provider works (~$5/mo). A Raspberry Pi
  or any always-on machine is fine too.
- **Docker + Docker Compose** installed (`curl -fsSL https://get.docker.com | sh`).
- This repo on the box (`git clone …`).

## Steps

```bash
# 1. On the VPS, get the code
git clone https://github.com/nns50/stock_app.git
cd stock_app

# 2. Create the env file consumed by docker compose (root .env, NOT server/.env)
cp .env.example .env
nano .env
```

Set at least:

```ini
# Free live data, no key (Yahoo) — or use tradier with a token. mock = demo only.
MARKET_DATA_PROVIDER=yahoo

# Where always-on alerts get pushed (secrets — never commit). Set any/all; they
# fire at once. A fired alert can hit Slack AND Discord AND your phone together.
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/xxxx
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/000/xxxx
ALERT_WEBHOOK_URL=https://ntfy.sh/your-private-topic   # generic/phone push (optional)
ALERT_WEBHOOK_FORMAT=json                              # body shape for ALERT_WEBHOOK_URL
```

> **Getting the URLs:** Slack → _Incoming Webhooks_ app → "Add to Slack", pick a
> channel, copy the URL. Discord → _Server Settings → Integrations → Webhooks → New
> Webhook_, pick a channel, copy. Paste them above; no format flag needed for these two.

```bash
# 3. Build and start (detached, restarts on crash/reboot)
docker compose up -d --build

# 4. Verify
docker compose ps
curl -s localhost:3001/api/health        # {"ok":true,...}
docker compose logs -f app               # Ctrl-C to stop following
```

## Turn on the watcher

Open the UI (via Tailscale/SSH per above) → **Settings → Server-side watching**:

1. **Enable the background alert poller.**
2. Pick an interval. **1m or 5m** is friendly to free providers; 30s can get you
   rate-limited on Yahoo.
3. Click **Send test notification** — you should get a hit on your webhook/phone.

Then create your alerts as usual (stock or option, entry/exit). They'll now be evaluated
on the server around the clock and pushed to your webhook when they fire — no browser
needed. (Quotes are still delayed per your provider, and triggers remain rule-based
heuristics you set — not buy signals.)

## Persistence, backups, updates

- **Data** lives in the named volume `stockdb` (mounted at `/app/data`), so it survives
  restarts and image rebuilds.
- **Back up** from the UI (**Settings → Data → export**), or snapshot the volume:
  `docker run --rm -v stock_app_stockdb:/d -v "$PWD":/out alpine tar czf /out/backup.tgz -C /d .`
- **Update** to the latest code:
  ```bash
  git pull
  docker compose up -d --build      # volume (your data) is preserved
  ```
- **Stop / restart:** `docker compose down` / `docker compose restart`.

## Deploy to Fly.io

The repo ships a ready `fly.toml` (always-on machine, persistent volume, health
check, builds from the Dockerfile). Minimum footprint: **one `shared-cpu-1x` / 512 MB
machine + a 1 GB volume** — roughly a few dollars a month (check Fly's current pricing).

```bash
# 1. Install flyctl and sign in
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. From the repo root, edit fly.toml → set `app` and `primary_region`, then:
fly apps create your-stock-app          # must match `app` in fly.toml

# 3. Create the 1 GB volume in the SAME region as primary_region
fly volumes create stock_data --size 1 --region <your-region>

# 4. Set your secrets (NEVER put these in fly.toml)
fly secrets set \
  SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
  DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
#   optional: ALERT_WEBHOOK_URL=https://ntfy.sh/your-topic
#   if MARKET_DATA_PROVIDER=tradier:  fly secrets set TRADIER_API_TOKEN=...
#   for the auto-trading backtest harness (docs/AUTOTRADING_SPEC.md):
#     fly secrets set POLYGON_API_KEY=...

# 5. Deploy
fly deploy
```

**Protect access.** `fly deploy` gives you a public `*.fly.dev` URL, which would expose
your journal. Two ways to secure it — easiest first:

**Keep the public URL, add a login** (recommended for convenience):

```bash
fly secrets set APP_PASSWORD='your-long-passphrase' -a your-stock-app
```

Now the URL prompts for a password before serving any data; sign out from **Settings →
Account**. (Alerts keep firing — they push outbound regardless.)

**Or take it off the public internet** — since alerts are outbound, the app doesn't need
to be publicly reachable; release the IPs and proxy in when you want the UI:

```bash
fly ips list
fly ips release <public-ipv4> <public-ipv6>     # drop the public IPs
fly proxy 3001:3001 -a your-stock-app           # then open http://localhost:3001
# over plain http, also: fly secrets set AUTH_SECURE_COOKIE=false -a your-stock-app
```

Then in the UI: **Settings → Server-side watching → enable the poller**, pick an
interval, and **Send test** — you should get a hit in Slack/Discord. From now on alerts
fire 24/7 with nothing open.

**Notes**
- **One machine only** — SQLite is single-node, so don't `fly scale count` above 1. The
  `fly.toml` pins `min_machines_running = 1` and disables auto-stop so the poller never
  sleeps.
- **Resize** if needed: `fly scale memory 512` (or `1024`), `fly scale vm shared-cpu-1x`.
- **Logs / status:** `fly logs`, `fly status`. **Update:** `git pull && fly deploy`
  (the volume, and your data, persist).
- **Back up** from the UI (**Settings → Data → export**) — simplest for a single volume.

### Running the maintenance scripts on Fly

**`npm run check:journal` (and the other `npm run` scripts) do not work on Fly.** They
run `tsx src/scripts/…`, and the runtime image copies `server/dist` but not
`server/src` — so there is no TypeScript there to run. Call `node` on the built file
instead:

```bash
fly ssh console -a your-stock-app -C \
  "env DATABASE_PATH=/app/data/stock_app.db node /app/server/dist/scripts/checkJournal.js"
```

| Locally | On Fly (`/app/server/dist/scripts/…`) |
|---|---|
| `npm run check:journal` | `checkJournal.js` — read-only journal audit |
| `npm run check:provider` | `checkProvider.js` — probe the configured market-data provider |
| `npm run capture:broker` | `captureBrokerFields.js` — dump raw Webull field shapes |
| `npm run backfill:exits` | `backfillExitPrices.js` — dry run unless you add `--apply` |

Flags pass through the same way, minus the `--` separator npm needs: append `--json`,
`--apply`, `--force` directly. Prefer `fly ssh console` with no `-C` if you want a shell
to poke around in.

**`npm run research` is the exception — it's an HTTP client, not a DB script.** The
walk-forward sweeps execute server-side (your deployed app's Polygon key and bar
cache), so the script runs wherever is convenient and just needs the API's URL:

```bash
# From a local clone, tunneled (robust for the slow first, cache-warming variant):
fly proxy 3001:3001 -a your-stock-app          # terminal 1
npm run research -- --base http://localhost:3001 --password 'your-APP_PASSWORD' \
  --symbols AAPL,MSFT,NVDA --from 2024-08-01 --to 2026-07-25 --split 2025-12-01

# Or on the machine itself (compiled, like the scripts above; results print to stdout):
fly ssh console -a your-stock-app -C \
  "node /app/server/dist/scripts/researchSweep.js --base http://localhost:3001 \
   --password 'your-APP_PASSWORD' --symbols AAPL,MSFT,NVDA \
   --from 2024-08-01 --to 2026-07-25 --split 2025-12-01"
```

An instance with MFA enforced needs the current TOTP too: add `--code 123456` next to
`--password` (the login is a single request at script start, well inside one code's
validity window).

If the public URL is live you can point `--base` straight at `https://your-app.fly.dev`;
should the first (cache-warming) variant time out at the edge, just re-run — the bar
cache persisted, so the retry is pure local compute.

**Never run `seed.js` against a real volume** — it adds demo trades to your journal.

#### Always pass `DATABASE_PATH` explicitly

`config.ts` falls back to `./data/stock_app.db` *relative to the server package*, and
creates it if absent. So a session that doesn't carry the image's env resolves to
`/app/server/data/stock_app.db` — **not** your volume — and the script cheerfully makes
an empty database and audits that:

```
Journal integrity — 0 position(s), 0 exit(s) …
No problems found.
```

A clean bill of health from a file it just created. `fly ssh console` usually does
inherit the image env, so this often works by accident; the failure is silent and reads
as good news, so don't rely on it. **Sanity-check the position count in the first line
of output** — if it's 0, you read the wrong file.

#### Safe to run against the live app?

Yes. The database is opened in WAL mode, so a second process reading while the server
runs is fine. `initDb()` isn't strictly read-only — it runs `CREATE TABLE IF NOT EXISTS`
and the migrations — but those are idempotent and already applied, so in practice it
takes a brief lock and reads. The journal audit itself writes nothing, by design.

For the journal audit specifically there's a simpler route that needs no `flyctl` at
all: `GET /api/positions/integrity` returns the same report as JSON, behind the same
`APP_PASSWORD` login as the rest of the app. Open it in a browser you're signed into.

### Auto-deploy from GitHub (CI/CD)

The repo includes `.github/workflows/fly-deploy.yml`, which deploys to Fly **after CI
passes on `main`** (so a red build never ships). This is the same thing Fly's "Deploy
from GitHub" button sets up — you can use either; with the workflow already in the repo
you only need to add the token. One-time setup:

1. **Do the manual setup above first** (`fly apps create`, the volume, and `fly secrets
   set`). The GitHub deploy builds and releases the image; it does **not** create the app,
   volume, or Fly secrets. Set `app` in `fly.toml` to your real app name and do an initial
   `fly deploy` from your machine to confirm it all works.
2. **Create a deploy token:** `fly tokens create deploy` (copy the whole
   `FlyV1 ...` string).
3. **Add it to GitHub:** repo → **Settings → Secrets and variables → Actions → New
   repository secret** → name `FLY_API_TOKEN`, value = the token.
4. Push to `main` (or merge a PR). CI runs; on success the deploy workflow builds on Fly's
   remote builders and releases. Until the secret exists, the deploy job runs and **skips
   cleanly** (no red X).

Your Fly secrets (webhook URLs, any provider token) live on Fly, not GitHub — set/rotate
them with `fly secrets set`. The only GitHub secret is `FLY_API_TOKEN`.

### Other managed platforms

The same image runs on Railway, Render, etc.: point them at this `Dockerfile`, attach a
persistent volume at `/app/data`, set the env/secrets above, and keep it private (the
no-auth caveat applies everywhere).

---

See the [README](../README.md) for environment variables and the
[User Guide](USER_GUIDE.md) for how alerts and the poller behave.
