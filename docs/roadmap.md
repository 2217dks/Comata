# MVP Roadmap — Vertical Slices

> Every slice ends with something clickable. Timeboxes assume part-time solo pace —
> cut scope, not the slice boundary. Order is dependency-driven; within a slice,
> build the demo-path first, polish later.

## Slice 0 — Walking skeleton (1–2 days)
- [ ] pnpm workspaces: `apps/web` (Vite+React), `apps/api` (Hono), `packages/schema`
- [ ] Web deploys to Vercel/Netlify; API hello-world route works
- [ ] CI: typecheck + build on PR
- **Demo:** deployed site shows a blank board.## Slice 1 — Board + live collab (3–4 days)
- [ ] `packages/elements`: element shell (id, kind, x/y/w/h/rotation/z) + Zod payloads
- [ ] `packages/crdt`: Yjs doc shape + `@liveblocks/yjs` provider + projection helper
- [ ] react-konva board: pan/zoom, create + drag a rectangle & sticky note, multiplayer cursors
- [ ] Liveblocks auth endpoint in API (anon-allowed for now)
- **Demo:** two browsers, shared board, both cursors move, both drag elements. *(Success criterion #1 half-met.)*

## Slice 2 — Auth + notebooks (2–3 days)
- [ ] Supabase project + Prisma 7 schema (data-model.md, ER-first) + first migration
- [ ] Better-Auth: email+password + Google OAuth
- [ ] Dashboard: notebook list / create (kind picker) / rename / delete; `NotebookMember` rows
- [ ] Liveblocks room tokens now require membership (`notebook:{id}`); Yjs snapshot → `Notebook.yjsSnapshot` on unload/timer
- **Demo:** sign in, create notebook, invite link opens the same notebook for a second user as editor.

## Slice 3 — Element system breadth (4–5 days)
- [ ] Unified element interactions: select, drag, resize, delete, duplicate, z-order, toolbar
- [ ] Ink (pen + highlighter), shapes (rect/ellipse/line/arrow/sticky), text (styling + inline KaTeX)
- [ ] Frame element; present mode = camera jumps between frames; **follow mode** via awareness
- **Demo:** sketch a lesson: title text, arrows, ink annotations, present it to a viewer following along. *(Criterion #4 met.)*

## Slice 4 — Code elements + execution (3–4 days)
- [ ] CodeMirror 6 element: language picker, stdin box, output pane; code string in Yjs payload
- [ ] VPS: infra compose (Valkey, Judge0, worker, Caddy) — see setup.md §4
- [ ] `POST /v1/runs` → `/enqueue` → worker → Judge0 → `CodeRun` row → Liveblocks room event → panes update
- [ ] Per-element run lock; run history (last 5) in output pane
- **Demo:** class watches teacher hit Run; output appears on everyone's board. *(Criterion #2 met.)*

## Slice 5 — Math elements (3–4 days)
- [ ] `packages/math-engine`: math.js compile + Zod expression validation
- [ ] 2D graph element: `y=f(x)` live re-plot (Konva or function-plot inside a Konva Group), pan/zoom, parameter sliders
- [ ] 3D surface `z=f(x,y)` via MathBox mounted in the element, rotate on drag
- [ ] Inline math rendering in text elements (KaTeX — already from Slice 3)
- **Demo:** slider `a` animates `y=a·sin(x)` while a student inks an annotation on top. *(Criterion #3 met.)*

## Slice 6 — Images + notebook export/import (3–4 days)
- [ ] Image element: upload → Supabase Storage (content-hashed) → place/scale/annotate
- [ ] `packages/format`: `.comata` export — freeze Yjs doc, collect hash-addressed assets, zip with manifest
- [ ] Import — validate manifest + schemaVersion, create notebook, upload assets idempotently, `Y.applyUpdate`
- [ ] Round-trip test: export → import → every element interactive (code runs, graphs re-plot, images resolve)
- **Demo:** build a lesson, export `.comata`, import it on a fresh account — everything works. *(Criterion #5 met.)*

## Slice 7 — Presentation kind (2–3 days)
- [ ] Presentation notebooks: 16:9 pages, ordered, page-flip in edit + present
- [ ] Viewer role hardening (read-only room tokens, UI affordances)
- **Demo:** full lecture prep → present → student solves on the board. **MVP done.**

## Post-MVP backlog (first picks)
Snapshot restore edge cases · Playwright smoke tests · Biome + pre-commit · commenter tier · PDF import · y-indexeddb offline · the `docs-future-implementation/` swap path.

## Parallelization notes
- Slice 4's VPS setup is independent — can run any time after Slice 0.
- Slices 5, 6, 7 are swappable among themselves if one lands late.
- Total: **~4 weeks part-time**, every week ends with a demo.
