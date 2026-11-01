# Setup — zero to running

> Prereqs: Node 22+, pnpm 9+ (`corepack enable`), Docker Desktop (code-runner container).

## 1. Accounts you need (all free)

| Service | For | What to grab |
|---|---|---|
| [Supabase](https://supabase.com) | Postgres + Storage | pooled `DATABASE_URL` (:6543), `DIRECT_URL` (:5432) |
| [Liveblocks](https://liveblocks.io) | collab | public key (`pk_…`) + secret key (`sk_…`) |
| [Vercel](https://vercel.com) or Netlify | hosting | — (connect repo at deploy time) |
| Oracle Cloud free tier *or* Hetzner | runner host: self-hosted Piston (only at MVP deploy) | SSH access |

## 2. Environment variables

Root `.env.example` (committed) — copy to `.env` (never committed):

```bash
# ── Supabase (apps/api) ───────────────────────────────────────
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

# ── Code runner (apps/api → Piston) — Slice 4 ─────────────────
PISTON_RUNNER_URL="http://localhost:2000/api/v2"   # self-hosted Piston (ADR-0002)
```

## 3. Local dev

```bash
pnpm install
cp .env.example .env                 # fill in keys (see §1) — .env lives at the REPO ROOT
pnpm --filter api prisma:migrate     # first migration (needs DIRECT_URL) — Slice 2
pnpm dev                             # runs web (5173) + api (8788) concurrently
```

> **Env loading is automatic from the repo root:** the API runs with Node's
> `--env-file=../../.env` and Vite reads the same file (`envDir: "../../"`).
> Only `VITE_`-prefixed vars reach the browser bundle — server keys never do.

- Web: `http://localhost:5173` — sign up, create a canvas, draw.
- Collab works locally immediately (Liveblocks is cloud-hosted — no local sync server).
- **Code execution needs the runner container.** Locally (Piston's isolate
  sandbox needs `--privileged`, and a named volume keeps installed languages
  across restarts — an empty bind-mount over `/piston` yields a runtimes list
  of `[]`, i.e. "unsupported language" for everything):
  ```bash
  docker run -d --name piston \
    --privileged \
    -p 2000:2000 \
    -v piston-packages:/piston/packages \
    --tmpfs /tmp:exec \
    -e PISTON_RUN_TIMEOUT=10000 \
    -e PISTON_COMPILE_TIMEOUT=10000 \
    ghcr.io/engineer-man/piston:latest
  # first boot with an empty packages volume — install the languages the
  # language selector offers (the image ships no `piston` CLI; use the API):
  for lang in python node typescript gcc java rust go; do
    curl -s -X POST localhost:2000/api/v2/packages \
      -H "Content-Type: application/json" \
      -d "{\"language\": \"$lang\", \"version\": \"*\"}"; echo
  done
  ```
  Verify: `curl -s localhost:2000/api/v2/runtimes | head -c 300` (a long JSON
  list, not `[]`). Run buttons show `RUNNER_OFFLINE` until it's up.
- **AI Create (Slice 5b) needs a Gemini key.** Put `GEMINI_API_KEY=…` in the
  root `.env` (Google AI Studio, free tier is fine — the API proxies generation
  through this server-side key, ADR-0004). Without it the Run-style generate
  call answers 502 `GENERATION_FAILED`. Access is deny-by-default: grant your
  own email at `/ai-admin` (link in the dashboard topbar) before first use.
- **`/ai-admin` is admin-only.** The allowlist API rejects non-admins with 403;
  admins are the comma-separated `ADMIN_EMAILS` list in `.env` (e.g.
  `ADMIN_EMAILS=dhruv220107@gmail.com`). Non-admins opening the page see a
  locked-out notice; the dashboard link is visible to all but useless without
  the role.

## 4. Runner host bootstrap (MVP deploy only)

```bash
ssh root@<vps>
curl -fsSL https://get.docker.com | sh
docker run -d --privileged -p 2000:2000 -v piston-packages:/piston/packages --tmpfs /tmp:exec \
  ghcr.io/engineer-man/piston:latest   # bind to localhost + reverse proxy
```

Point `PISTON_RUNNER_URL` at the host. DNS A-record → host IP. Done.

## 5. Deploy checklist

- [ ] Vercel/Netlify project connected to the repo; root dir per app (`apps/web`, `apps/api`)
- [ ] Env vars pasted into hosting dashboard (web: only `VITE_*`; api: the rest)
- [ ] `prisma migrate deploy` runs in api build step
- [ ] GitHub Actions: one workflow — typecheck + vitest + (on main) migrate + deploy hooks
- [ ] Smoke: open doc in two browsers → cursors visible → Run a Python hello-world
