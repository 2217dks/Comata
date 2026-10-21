# MVP Architecture

> Stack + topology + costs: [mvp-stack.md](mvp-stack.md). Scope: [product-scope.md](product-scope.md).

## 1. Repo layout (pnpm workspaces, no Turborepo)

```
Comata/
├── apps/
│   ├── web/        # Vite + React SPA: editor, dashboard (deploy: Vercel/Netlify static)
│   ├── api/        # Hono serverless: REST + Liveblocks auth endpoint + /enqueue proxy
│   └── worker/     # BullMQ worker: Valkey queue → Judge0 → Supabase (deploy: VPS)
├── packages/
│   ├── schema/     # Zod: element payloads, API contracts, env loading — shared everywhere
│   ├── elements/   # element types + geometry helpers + doc projection + schema migrations
│   ├── crdt/       # Yjs doc shape, Liveblocks provider wiring, snapshot encode/decode
│   ├── format/     # .comata export/import (notebook-format.md): zip, manifest, asset remap
│   ├── canvas/     # react-konva renderer: consumes projected doc view only
│   ├── math-engine/# math.js eval/compile + MathBox viz, behind one interface
│   └── ui/         # shared React components (toolbar, panels, dialogs)
├── infra/          # docker-compose for VPS (Valkey + worker + Judge0), deploy scripts
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
| Code execution results | Prisma (`CodeRun`) + Liveblocks room event for live push | Supabase |
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

### 3.2 Run code (execute path)
```
Run click → apps/api POST /v1/runs
  → Zod-validate payload, check editor role
  → POST https://<vps>/enqueue (shared token)        # api never touches Valkey
     → VPS worker: BullMQ job → Judge0 POST /submissions
        → result → Prisma CodeRun row
        → Liveblocks room event `run:done:{elementId}` → clients update panes
```
Idempotency: one run per element at a time — worker rejects a second job for the same element while one is in flight (per-element lock key in Valkey).

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
- `/enqueue` endpoint: bearer token + Hono-issued HMAC payload (docId, elementId, userId, role) — the VPS never trusts the client.
- Judge0 bound to localhost on the VPS; language timeouts + CPU/memory limits per submission.
- Liveblocks room naming: `notebook:{Notebook.id}` — token check guarantees membership.

## 5. Deployment

| Unit | Where | How |
|---|---|---|
| `apps/web` | Vercel/Netlify | static build on push to `main` |
| `apps/api` | Vercel/Netlify | Node serverless functions (Hono `handle` adapter) |
| `apps/worker` + Valkey + Judge0 | VPS | `infra/docker-compose.yml`, deployed via SSH script in CI |

`infra/` contains: compose file (Valkey, worker, Judge0 CE), Caddy (TLS for the enqueue endpoint), and a bootstrap script. Keep it boring.
