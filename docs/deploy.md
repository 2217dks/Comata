# Deploy Guide — Slice 0

> **Rule: nothing here is executed by the agent without explicit approval.**
> Deployments, production builds, and git push are user-driven.

## What's deployable right now

| Unit | Content | Target |
|---|---|---|
| `apps/web` | Branded landing page (live API status pill) | Vercel (static, SPA rewrite) |
| `apps/api` | Hono API, `GET /v1/health` | Vercel (Node serverless) |

Both include their own `vercel.json` — no build config needed in the dashboard beyond the root directory.

## Steps (Vercel — recommended for the MVP)

1. **Push the repo to GitHub** (ask the agent to commit first, then push yourself or approve it).
2. In Vercel: **Add New → Project → import the repo**, then create **two projects**:
   - **web**: Root Directory = `apps/web` · Framework Preset = Vite (auto-detected) · nothing else to set.
   - **api**: Root Directory = `apps/api` · Framework Preset = Other. The `vercel.json` wires `api/index.ts` as the function; every route hits it.
3. Note the two URLs, e.g. `comata-web.vercel.app` and `comata-api.vercel.app`.
4. In the **web** project → Settings → Environment Variables:
   - `VITE_API_URL` = `https://<api-url>` (e.g. `https://comata-api.vercel.app`)
   - Redeploy web after adding it.
5. Verify: open the web URL → status pill shows **API online**; `https://<api-url>/v1/health` returns JSON.

### Custom domain (you already own one)

- web project → Domains → add e.g. `comata.yourdomain.com` (or root domain).
- api project → Domains → add `api.yourdomain.com`.
- Update `VITE_API_URL` to `https://api.yourdomain.com`, redeploy web. DNS records are auto-suggested by Vercel.

### Netlify alternative

- web: deploy `apps/web`, build command `pnpm build`, publish `dist` — the SPA redirect needs a `_redirects` file (`/* /index.html 200`) instead of `vercel.json` (say the word and it'll be added).
- api: Netlify functions need a small adapter (`serverless-http` style) — Vercel is the zero-friction path for Hono; recommended for MVP.

## CI

`.github/workflows/ci.yml` runs on every push/PR: pnpm install → typecheck (all packages) → web build. No deploy step — deployment stays manual per the rule above.

## Not needed yet (later slices)

| Slice | Adds |
|---|---|
| 1 | `VITE_LIVEBLOCKS_PUBLIC_KEY` (web), `LIVEBLOCKS_SECRET_KEY` (api) |
| 2 | Supabase URLs, `BETTER_AUTH_SECRET`, Prisma `migrate deploy` in api build |
| 4 | VPS: Valkey + Judge0 + worker + Caddy (`infra/`, see `setup.md` §4) |

Full env reference: `.env.example`.
