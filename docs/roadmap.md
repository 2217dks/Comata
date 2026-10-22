# MVP Roadmap — Vertical Slices

> Every slice ends with something clickable. Timeboxes assume part-time solo pace —
> cut scope, not the slice boundary. Order is dependency-driven; within a slice,
> build the demo-path first, polish later.

## Slice 0 — Walking skeleton (1–2 days)
- [ ] pnpm workspaces: `apps/web` (Vite+React), `apps/api` (Hono), `packages/schema`
- [ ] Web deploys to Vercel/Netlify; API hello-world route works
- [ ] CI: typecheck + build on PR
- **Demo:** deployed site shows a blank board.## Slice 1 — Board + live collab (3–4 days)
- [x] `packages/elements`: element shell (id, kind, x/y/w/h/rotation/z) + Zod payloads
- [x] `packages/crdt`: Yjs doc shape + `@liveblocks/yjs` provider + projection helper
- [x] react-konva board: pan/zoom, create + drag a rectangle & sticky note, multiplayer cursors
- [x] Liveblocks auth endpoint in API (anon-allowed for now)
- [ ] **Demo:** two browsers, shared board, both cursors move, both drag elements. *(Success criterion #1 half-met.)*

## Slice 2 — Auth + notebooks (2–3 days)
- [x] Supabase project + Prisma 7 schema (data-model.md, ER-first) + first migration *(migrations go via the IPv4 session pooler — direct :5432 is IPv6-only on the free plan)*
- [x] Better-Auth: email+password (Google OAuth wired — activates when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are added to `.env`)
- [x] Dashboard: notebook list / create (kind picker) / rename / delete; `NotebookMember` rows; open-by-link enrolls as EDITOR
- [x] Liveblocks room tokens now require membership (`notebook:{id}`); Yjs snapshot → `Notebook.yjsSnapshot` on unload/timer
- **Demo:** sign in, create notebook, invite link opens the same notebook for a second user as editor.

## Slice 3 — Element system breadth (4–5 days) ✅ DONE
- [x] Unified element interactions — tldraw-model pointer state machine (`board/interactions.ts`): 3-state select (hover/press+move/click), multi-select group moves (incl. selection-box background), marquee **touch**-select + lasso (sub-popup), Transformer on its own always-listening layer, ⌘D/⌫/z-order (`]`/`[` one-level ops), left tool dock with sub-popups, topbar properties bar (selection-first, tool-defaults-second)
- [x] Elements: pen + highlighter (smooth ink, click-dots, click-immune selection), rect/ellipse (combined Shape tool + flyout, outer/middle/inner border align, exact-edge hitbox), line/arrow (stroke-shaped hitbox), sticky, text (placeholder model, align/valign, inline KaTeX DOM overlay), custom stub. Frames removed (kind kept for legacy docs)
- [x] Performance: identity-stabilized CRDT projections + memoized ElementView, Konva perf flags, live throttled drag sync
- [x] Present mode gated to presentation notebooks (dormant until Slice 7 slides); **follow mode** via presence camera broadcast (follow any peer from their avatar or the presenter pill)
- [x] **Demo:** user-tested over several rounds — sketch lesson flow, draw-over-elements, marquee/lasso selection, group drags, text-on-box, pan/zoom (two-finger/space/middle). *(Criterion #4 met.)*

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

## Slice 5b — Custom elements: NL-generated micro-simulations (3–4 days)
- [x] `custom` element kind in the CRDT union + element registry (`title`, NL `prompt`, versioned `spec` payload) — renders as a placeholder card until the generation flow lands
- [ ] Generation flow: prompt → LLM → versioned spec (declarative controls + viz, or sandboxed HTML/JS)
- [ ] Runtime: spec interpreter renders interactive controls (sliders/toggles) + visualization inside the element bounds; interaction state stays local per user, spec is shared via Yjs
- [ ] Sandboxing: generated code runs in a sandboxed iframe (postMessage bridge) — never in the app's origin
- [ ] Export/import: `.comata` round-trips custom elements (prompt + spec) — see Slice 6
- **Demo:** "slider showing audio mix" → a small mixer simulator generated onto the board, interactive for every viewer. 

## Slice 6 — Images + notebook export/import (3–4 days)
- [ ] Image element: upload → Supabase Storage (content-hashed) → place/scale/annotate
- [ ] `packages/format`: `.comata` export — freeze Yjs doc (incl. custom elements: prompt + versioned spec), collect hash-addressed assets, zip with manifest
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
