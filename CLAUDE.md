# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Comata — an infinite-canvas + presentation tool for teaching (Canva/tldraw-style). Docs live in `docs/` (read `docs/README.md` for the doc map); `IDEA.md` is the product vision; `docs/roadmap.md` tracks vertical-slice progress.

## Commands

```bash
corepack enable            # once — activates pnpm (packageManager: pnpm@12, Node >=22)
pnpm install
pnpm dev                   # web :5173 + api :8788 in parallel
pnpm typecheck             # runs tsc --noEmit in every workspace
```

- API runs with `--env-file=../../.env`; Vite reads the same root `.env` (`envDir: "../../"`). Only `VITE_`-prefixed vars reach the browser.
- First migration: `pnpm --filter api prisma:migrate`. DB tasks live in `packages/db` (`db:generate`, `db:migrate`, `db:deploy`, `db:studio`).
- No test framework is configured yet (planned: vitest per setup.md).
- **Never** `git commit`/`push`, run production builds, or deploy without explicit approval (docs/deploy.md).

## Architecture

pnpm workspaces, no Turborepo:

- `apps/web` — Vite + React 19 + react-konva SPA. Board lives in `src/board/`: `interactions.ts` is a pure, render-agnostic pointer state machine (tldraw model: idle/pan/marquee/lasso/ink/pointShape/create; `DRAG_THRESHOLD` 5px); `useBoard.ts` owns the Liveblocks room + presence (cursors, camera, follow/present); `Board.tsx` translates DOM events into machine transitions; `ElementView.tsx` is the memoized per-kind Konva renderer.
- `apps/api` — Hono app mounted at `/v1`, transport-agnostic (`src/server.ts` = local Node, `api/index.ts` = Vercel). Routes: `/health`, `/auth/**` (Better-Auth), `/notebooks` (membership-enforced CRUD + snapshots), `/liveblocks/auth` (room tokens).
- `apps/worker` — empty placeholder for Slice 4 (BullMQ → Judge0).
- `packages/schema` — Zod contracts + shared types. The shared leaf: everything may import it; it imports nothing.
- `packages/elements` — element system. `kinds.ts` holds the discriminated union (uniform shell `id/kind/x/y/w/h/rotation/z` + per-kind payload; **never reshape the shell** — add kinds only by extending the union). `registry.ts` (`ELEMENT_REGISTRY`) is the single source of truth the dock, properties bar, and renderer read; adding a kind = schema + factory + one registry entry.
- `packages/crdt` — Yjs doc shape (`elements` Y.Map + `meta` Y.Map) and all doc mutations. All local changes go through transactions with `LOCAL_ORIGIN` so the per-user UndoManager (Canva behavior — your undo never reverts others' edits) tracks only your own edits. `RESTORE_ORIGIN` for bulk snapshot loads.
- `packages/db` — Prisma 7 with driver adapter (`PrismaPg` over pooled `DATABASE_URL` :6543; migrations use `DIRECT_URL` :5432). Generated client is checked in under `src/generated`.

Dependency rule: `apps/*` may import `packages/*`; packages never import app code or each other's internals.

### State model (invariant R1)

Yjs is the only state truth for element geometry/payloads — it flows client↔Liveblocks room (`notebook:{Notebook.id}`) and is snapshotted as a **blob** into `Notebook.yjsSnapshot` (Supabase via Prisma). SQL never stores element geometry. Live collab needs no API server; the API only issues room tokens, mapping `NotebookMember.role` → scopes (OWNER/EDITOR → `room:write`, VIEWER → `room:read`). Presence (cursors, camera, follow mode) rides Liveblocks awareness, not the doc.

Element `w/h` for line/arrow are **signed endpoint offsets**, so bounding boxes need `bboxOf()` normalization (`apps/web/src/board/interactions.ts`).
