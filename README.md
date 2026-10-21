# Comata

**An infinite canvas + presentation tool for teaching, where code runs, math comes alive, and everything is just another element on the board.**

- Vision: [IDEA.md](IDEA.md)
- Docs: [docs/](docs/README.md) (MVP stack, data model, roadmap, deploy guide)
- Archived production architecture: `docs-future-implementation/` (git-ignored)

## Repo layout (Slice 0)

```
apps/
  web/     Vite + React 19 SPA — landing page now, board next   → Vercel (static)
  api/     Hono serverless API — GET /v1/health                  → Vercel (functions)
packages/
  schema/  Zod contracts + shared types (workspace leaf)
```

## Develop

```bash
corepack enable            # once — activates pnpm
pnpm install
cp .env.example .env       # keys not needed until Slice 1
pnpm dev                   # web :5173 · api :8788
pnpm typecheck
```

## Rules of engagement

The agent never runs `git commit`/`push`, production builds, or deployments without explicit approval — see [docs/deploy.md](docs/deploy.md).
