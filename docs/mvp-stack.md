# MVP Tech Stack — Finalized

> Date: 2026-10-21. Deliberately diverges from the production decisions in
> `../docs-future-implementation/` for speed and cost. Per-layer deferrals are
> noted so the production swap path stays visible.

## 1. Stack

| Layer | MVP Choice | Production doc choice it defers |
|---|---|---|
| Language / runtime | TypeScript strict, Node 22 | same (D2) |
| Repo layout | **pnpm workspaces, no Turborepo** | pnpm + Turborepo (§5) |
| Frontend | **Vite + React 19 SPA** | Next.js 15 |
| Canvas renderer | **Konva + react-konva** | custom PixiJS 8 engine (D3) |
| State / CRDT | **Yjs** | same (D4/R1 — holds) |
| Collab transport | **Liveblocks Free** via `@liveblocks/yjs` | self-hosted Hocuspocus (RFC-004) |
| API | **Hono** (serverless functions on Vercel/Netlify) | Fastify 5 |
| Validation | **Zod 4** (`packages/schema`) | same |
| ORM | **Prisma 7 (stable)** + `@prisma/adapter-pg` (Rust-free driver-adapter runtime) | Drizzle (D16) |
| Database | **Supabase Postgres** (pooled connection, port 6543) | self-host Postgres 16 |
| Auth | **Better-Auth** (Prisma adapter) on Supabase | same (D15); D8 stub skipped for MVP |
| Code editor | **CodeMirror 6** | same (D11) |
| Math | **KaTeX + math.js** | same (D12) |
| Math viz | **Canvas2D (hand-rolled 2D) + raw three.js (3D)** — Slice 5 settled; MathBox cut (dormant upstream) | — |
| Sandbox | **Piston, self-hosted** (single Docker container) behind `packages/runner` | Docker + gVisor custom runner (D5/RFC-003) |
| Queue | **none** — runs are synchronous HTTP (ADR-0002) | Valkey + BullMQ (D17) if scale demands |
| Object storage | defer (Supabase Storage if needed) | MinIO/S3 (`packages/storage`) |
| Testing | **Vitest only** | + Playwright, k6, testcontainers (D19) |
| Lint/format | none during MVP | ESLint (coding-standards) — add Biome before first contributor |
| CI/CD | GitHub Actions, single deploy job | trunk-based + previews + canary (D20) |

### Prisma 7 specifics (why + how)

- **Why:** schema-first DX, instant migrations (`prisma migrate dev`), typed client — fastest iteration loop for a solo prototype. **Prisma 7 stable** — ESM-first `prisma-client` generator, Rust-free client; driver adapters are the standard runtime.
- **Serverless setup:** `@prisma/adapter-pg` + Supabase **pgBouncer pooled URL (port 6543)** as `DATABASE_URL` for runtime, direct URL (port 5432) as `DIRECT_URL` for migrations. Details in [data-model.md](data-model.md) §4.
- **Better-Auth:** Better-Auth's Prisma adapter so `User`/`Session`/`Account` live in the same schema — one migration source of truth.
- **Data model:** ER-first, models derived — see [data-model.md](data-model.md). Core entities: `User`, `Notebook` (the project container), `NotebookMember`.
- **Notebook portability:** export/import via `packages/format` → `.comata` file — see [notebook-format.md](notebook-format.md).

## 2. Deployment topology

```
┌──────────────────────────── Vercel / Netlify ────────────────────────────┐
│  apps/web    Vite + React SPA (static)                                   │
│  apps/api    Hono on Node serverless ── sync POST /runs ──┐              │
└───────────────────────────────────────────────────────│───┘──────────────┘
      │ Liveblocks realtime          │ Prisma → pgBouncer:6543  │ HTTPS
      ▼                              ▼                          ▼
┌─ Liveblocks cloud ─┐   ┌─ Supabase ────────────┐   ┌─ Runner host ─────────────────┐
│ rooms, presence,   │   │ Postgres: metadata,   │   │ Piston (Docker) — dev: Mac,   │
│ Yjs doc persistence│   │ snapshots, auth tables│   │ deploy: cheap VPS             │
└────────────────────┘   └───────────────────────┘   └───────────────────────────────┘
```

**Wiring rules:**
1. **Runs are synchronous** (ADR-0002): `apps/api` → self-hosted Piston, result in the HTTP response. No queue, no worker, no Valkey in MVP.
2. **Yjs is the state truth.** Liveblocks is transport + persistence only (`@liveblocks/yjs`). Supabase stores doc metadata + periodic Yjs snapshots, never geometry. Run results are never persisted (ADR-0003).
3. **Runner host:** the dev Mac during development (LAN users welcome); a cheap VPS only at MVP deploy.
4. **Piston stays internal:** bound to localhost / VPN on the host; only `apps/api` calls it.

## 3. Estimated cost

| Component | Cost |
|---|---|
| Vercel/Netlify hobby (static + functions) | $0 |
| Liveblocks Free (5–6 concurrent users) | $0 — Pro $25/mo if the per-room connection cap bites |
| Supabase free tier | $0 |
| Oracle free tier / Hetzner | $0 / ~$5 |
| **Total** | **~$0–5/mo** |

## 4. Accepted trade-offs

1. **Cloud services in core paths** (Liveblocks, Supabase) — deviates from D7 self-host-first. Accepted for MVP; both sit behind thin providers so the swap is contained.
2. **Konva ≠ custom PixiJS (D3)** — Konva renders the same projected doc view; the swap touches only the renderer package.
3. **Judge0 ≠ gVisor runner (D5)** — the worker wraps Judge0 behind the runner interface from RFC-003, so production hardening replaces one module.
4. **MathBox maintenance risk** — cut during Slice 5 grilling; 2D is a hand-rolled Canvas2D Desmos-lite plot, 3D is raw three.js + OrbitControls, both as DOM overlays reusing the Slice 4 overlay machinery.
5. **Liveblocks Free per-room connection cap** — verify the current limit during Slice 1; 5–6 users should fit.
