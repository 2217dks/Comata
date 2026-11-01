# MVP Architecture

> Stack + topology + costs: [mvp-stack.md](mvp-stack.md). Scope: [product-scope.md](product-scope.md).

## 1. Repo layout (pnpm workspaces, no Turborepo)

```
Comata/
├── apps/
│   ├── web/        # Vite + React SPA: editor, dashboard (deploy: Vercel/Netlify static)
│   ├── api/        # Hono serverless: REST + Liveblocks auth + /runs (sync → Piston)
├── packages/
│   ├── schema/     # Zod: element payloads, API contracts, env loading — shared everywhere
│   ├── elements/   # element types + geometry helpers + doc projection + schema migrations
│   ├── crdt/       # Yjs doc shape, Liveblocks provider wiring, snapshot encode/decode
│   ├── format/     # .comata export/import (notebook-format.md): zip, manifest, asset remap
│   ├── canvas/     # react-konva renderer: consumes projected doc view only
│   ├── math-engine/# math.js eval/compile + MathBox viz, behind one interface
│   └── ui/         # shared React components (toolbar, panels, dialogs)
├── infra/          # runner host deploy scripts (Piston container + reverse proxy)
├── docs/           # this doc set
├── docs-future-implementation/  # archived production docs (git-ignored)
├── IDEA.md
└── AGENTS.md
```

**Dependency rule:** `apps/*` may import `packages/*`; `packages/*` never import app code or each other's internals (schema is the shared leaf).

## 2. State model — who owns what

| Data | Owner | Storage |
|---|---|---|
| Element geometry + payloads (live) | **Yjs doc** (via Liveblocks room) | Liveblocks cloud + periodic snapshot → Supabase |
| Presence (cursors, viewport, follow) | Liveblocks awareness | ephemeral |
| Users, sessions | Better-Auth (Prisma 7 models) | Supabase |
| Notebook rows, membership/roles | Prisma (`Notebook`, `NotebookMember`) | Supabase |
| Code execution results | **nowhere** — per-user, ephemeral, response-only (ADR-0003) | — |
| Images, thumbnails | Supabase Storage (content-hashed) | — |
| **Whole-notebook portability** | `packages/format` → `.comata` file (manifest + doc.yjs + assets) | user's disk |

**Invariant (from archived R1, kept):** SQL never stores element geometry. The Yjs
snapshot (binary) is stored as a blob column — restore = load snapshot into Yjs, done.
The same snapshot is the heart of the `.comata` export ([notebook-format.md](notebook-format.md)).

## 3. Request flows

### 3.1 Edit an element (collab path — no API server involved)
```
client ──Yjs update──► Liveblocks room ──► fan-out to peers + persisted doc
```
Liveblocks auth endpoint in `apps/api` issues room tokens, checking `NotebookMember.role` via Prisma. Viewer role → read-only room token.

### 3.2 Run code (execute path — per-user, ephemeral; ADR-0002/0003)
```
Run click → apps/api POST /v1/runs (Better-Auth session required)
  → check notebook role + allowViewerRuns setting
  → in-memory checks: per-user run lock (one in-flight run per user,
    notebook-wide) + per-user rate limit (5/min → RATE_LIMITED + retryAfter)
  → POST to self-hosted Piston (dev backend: the developer's Mac)   # sync call
     → result {stdout, stderr, exitCode, time} returned in the HTTP response
```
No queue, no worker, no Valkey, no persistence, no Liveblocks involvement:
results go only to the requester and are never stored. Viewers may run only
when the notebook's `allowViewerRuns` setting is on. The runner sits behind
`packages/runner` (Piston now, Judge0 later touches one module).

### 3.3 Present / follow mode
Presenter writes camera transform to Liveblocks awareness under `camera` key; viewers in follow mode apply it. No API calls.

### 3.4 Export / import a notebook (`.comata` — notebook-format.md)
```
Export: freeze Yjs doc → doc.yjs + collect asset:sha256 refs from Storage →
        manifest.json → zip client-side (packages/format) → download
Import: validate manifest → create Notebook row (new id, importer = owner) →
        upload assets (hash-keyed, idempotent) → create Liveblocks room →
        Y.applyUpdate(doc.yjs) → payloads re-render (code, math, viz all declarative)
```
No new backend surface: export/import is client-side over existing APIs (Storage + Prisma + Liveblocks).

## 4. Security notes (MVP-grade, not paranoia-grade)

- All secrets in env (see `setup.md`); no secrets in the SPA bundle — client only ever holds `VITE_`-prefixed public keys (Liveblocks public key is not enough by itself: room tokens come from the API).
- `/runs`: auth required (Better-Auth session); role + `allowViewerRuns` checked; per-user run lock + rate limit in memory. The runner host is never exposed to clients.
- Piston bound to localhost on the runner host; global caps (10s wall / 512MB) per submission.
- Liveblocks room naming: `notebook:{Notebook.id}` — token check guarantees membership.

## 5. Deployment

| Unit | Where | How |
|---|---|---|
| `apps/web` | Vercel/Netlify | static build on push to `main` |
| `apps/api` | Vercel/Netlify | Node serverless functions (Hono `handle` adapter) |
| Piston (runner) | cheap VPS (dev: the Mac) | Docker container, localhost-bound + reverse proxy — only at MVP deploy |

`infra/` contains: runner host deploy script + reverse-proxy config. Keep it boring.
