# Setup — zero to running

> Prereqs: Node 22+, pnpm 9+ (`corepack enable`), Docker Desktop (VPS work only).

## 1. Accounts you need (all free)

| Service | For | What to grab |
|---|---|---|
| [Supabase](https://supabase.com) | Postgres + Storage | pooled `DATABASE_URL` (:6543), `DIRECT_URL` (:5432) |
| [Liveblocks](https://liveblocks.io) | collab | public key (`pk_…`) + secret key (`sk_…`) |
| [Vercel](https://vercel.com) or Netlify | hosting | — (connect repo at deploy time) |
| Oracle Cloud free tier *or* Hetzner | VPS: Valkey + worker + Judge0 | SSH access |

## 2. Environment variables

Root `.env.example` (committed) — copy to `.env` (never committed):

```bash
# ── Supabase (apps/api, apps/worker) ──────────────────────────
DATABASE_URL="postgresql://…:6543/postgres?pgbouncer=true&connection_limit=1"
DIRECT_URL="postgresql://…:5432/postgres"
SUPABASE_STORAGE_URL="https://<ref>.supabase.co/storage/v1"
SUPABASE_SERVICE_KEY="…"

# ── Liveblocks (apps/api: secret, apps/web: public) ───────────
LIVEBLOCKS_SECRET_KEY="sk_…"
VITE_LIVEBLOCKS_PUBLIC_KEY="pk_…"

# ── Better-Auth (apps/api) ────────────────────────────────────
BETTER_AUTH_SECRET="openssl rand -base64 32"
BETTER_AUTH_URL="http://localhost:5173"

# ── VPS bridge (apps/api → worker) ────────────────────────────
VPS_ENQUEUE_URL="http://localhost:8787/enqueue"   # prod: https://run.<yourdomain>/enqueue
VPS_ENQUEUE_TOKEN="openssl rand -hex 32"

# ── VPS only (apps/worker, infra/) ────────────────────────────
VALKEY_URL="redis://valkey:6379"
JUDGE0_URL="http://judge0:2358"
JUDGE0_AUTH=""                                     # set if you enable Judge0 auth
```

## 3. Local dev

```bash
pnpm install
cp .env.example .env                 # fill in Supabase + Liveblocks keys
pnpm --filter api prisma:migrate     # first migration (needs DIRECT_URL)
pnpm dev                             # runs web (5173) + api (8788) concurrently
```

- Web: `http://localhost:5173` — sign up, create a canvas, draw.
- Collab works locally immediately (Liveblocks is cloud-hosted — no local sync server).
- **Code execution needs the VPS.** Locally, either run `infra/docker-compose.yml`
  (Valkey + Judge0) and point `VPS_ENQUEUE_URL` at a locally-run worker, or accept
  Run buttons showing `RUNNER_OFFLINE` until the VPS is up. Build the board first; wire execution in Slice 4.

## 4. VPS bootstrap (Slice 4)

```bash
ssh root@<vps>
curl -fsSL https://get.docker.com | sh
git clone <repo> /opt/comata && cd /opt/comata/infra
cp .env.example .env                 # VALKEY_URL, JUDGE0_URL, VPS_ENQUEUE_TOKEN
docker compose up -d                 # valkey + judge0 + worker + caddy(TLS)
```

Caddy serves `https://run.<domain>/enqueue` → worker. DNS A-record → VPS IP. Done.

## 5. Deploy checklist

- [ ] Vercel/Netlify project connected to the repo; root dir per app (`apps/web`, `apps/api`)
- [ ] Env vars pasted into hosting dashboard (web: only `VITE_*`; api: the rest)
- [ ] `prisma migrate deploy` runs in api build step
- [ ] GitHub Actions: one workflow — typecheck + vitest + (on main) migrate + deploy hooks
- [ ] Smoke: open doc in two browsers → cursors visible → Run a Python hello-world
