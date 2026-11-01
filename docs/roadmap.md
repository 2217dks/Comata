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

## Slice 4 — Code elements + execution (3–4 days) ✅ DONE
- [x] Code element (in-element editing per wireframe): CodeMirror 6 DOM overlay in the element bounds — filename chip (`Untitled-1.py`, auto-numbered), language selector (Python/JS/TS/C/C++/Java/Rust/Go), RUN button, always-visible Input/Output/Error tabs, `[- +]` element-wide scale steps
- [x] Full editor toolkit: One Dark theme (theme swap point for future themes), line numbers, auto-close brackets, bracket matching, autocompletion (language built-ins + JS globals source), auto-indent on input, fold gutter, search panel, selection-match highlights, 2-space indent unit
- [x] Code + filename + language shared via Yjs payload; stdin per-user local-only; output per-user (ADR-0003)
- [x] `packages/runner`: runner interface + Piston implementation (dev backend = dev Mac, LAN-accessible)
- [x] `POST /v1/runs`: auth required → role check (`allowViewerRuns` for VIEWERs) → in-memory per-user run lock (notebook-wide) + per-minute rate limit → sync Piston call → result in response. Caps 10s wall / 512MB (ADR-0002)
- [x] Notebook settings API: owner-managed incl. `allowViewerRuns` (viewer rule surfaces on the Run button; settings UI toggle deferred)
- [x] Canva-style layering rework: z-sorted bands split at code blocks (DOM order = exact global z), single input stage with manual hit-testing, TransformerProxy gesture mirroring with single commit; z-aware bring forward/backward (skips non-overlapping neighbors); edit mode keeps true z-order; double-click no longer places sticky notes
- **Demo:** shared code element on the board, each user edits + runs their own input and sees only their own output. *(Criterion #2 met.)*

## Slice 5 — Math element (3–4 days)
- [x] `packages/math-engine`: math.js compile + Zod expression validation
- [x] `math` element ("mathblock"): Desmos-lite — expression sidebar (add/remove rows, per-row color + visibility), Canvas2D 2D plot and three.js 3D view as DOM overlays in one z-band unit (ADR: overlay machinery from Slice 4)
- [x] 2D↔3D toggle, automatic: `y=f(x)` → curve-on-plane in 3D; `z=f(x,y)` → shaded surface; OrbitControls drag-rotate + zoom
- [x] Params: unknown variables auto-offer Desmos-style sliders — default values shared via Yjs, live values per-user local (+ reset-to-default)
- [x] Graph view (pan/zoom/rotate) per-user local, never synced (ADR-0003 pattern); debounced compile-once re-plot, last-good retained on parse error
- [x] Inline math in text elements: hardening only ($...$ / $$...$$ conventions, inline error rendering, size fitting)
- **Demo:** slider `a` animates `y=a·sin(x)` while a student inks an annotation on top. *(Criterion #3 met.)*

## Slice 5b — AI Create: NL-generated micro-simulations (3–4 days)
- [x] `custom` element kind in the CRDT union + element registry (`title`, NL `prompt`, versioned `spec` payload) — renders as a placeholder card until the generation flow lands
- [x] Generation (ADR-0004): "AI Create" dock tool → click canvas → prompt popup → element spawned with `status: 'generating'` (wavy loading box visible to all) → Gemini (server's own key, allowlist-gated) returns single self-contained HTML spec
- [x] Access gate: `AiAllowlist` table + minimal admin page (`/ai-admin`, deny by default, owner grants per email); guardrails: 20 gen/hour/user, 120s timeout, prompt ≤2000 chars, spec ≤200KB
- [x] Runtime: spec HTML rendered in sandboxed iframe (`allow-scripts`, no same-origin) via srcdoc; interaction per-user, gated behind double-click edit mode; postMessage bridge (resize / ready / error)
- [x] Regenerate + edit-prompt (properties bar, own elements only) → bumps `specVersion`, old + new specs preserved (immutable library rows)
- [x] Library: `GeneratedElement` table + "Your generated elements" browse tab in spawn popup; immutable version rows; re-spawn without regenerating
- [ ] Export/import: board elements carry `spec.html` inline — `.comata` round-trips with no extra work (see Slice 6)
- **Demo:** "slider showing audio mix" → a small mixer simulator generated onto the board, interactive for every viewer. 

## Slice 6 — Images + notebook export/import (3–4 days)
- [ ] Image element: upload → Supabase Storage (content-hashed) → place/scale/annotate
- [ ] `packages/format`: `.comata` export — freeze Yjs doc (incl. custom elements: prompt + versioned spec), collect hash-addressed assets, zip with manifest
- [ ] Import — validate manifest + schemaVersion, create notebook, upload assets idempotently, `Y.applyUpdate`
- [ ] Round-trip test: export → import → every element interactive (code runs, graphs re-plot, images resolve)
- **Demo:** build a lesson, export `.comata`, import it on a fresh account — everything works. *(Criterion #5 met.)*

## Slice 7 — Presentation kind (2–3 days) ✅ DONE
- [x] Presentation notebooks rebuilt (ADR-0005): pure pages, 1920×1080 world units, per-page coordinate space (`pageId` on the element shell — deliberate invariant bend), page list in a `Y.Array`; frame kind + Slice 3 broadcast-present/follow machinery removed
- [x] Edit mode: one page fit-to-viewport (zoom/pan inside it), Canva-style page sidebar — thumbnails, add/duplicate/delete (last-page guard, page+elements one undo step), drag-reorder, per-page background color (element default colors derive from background luminance — ADR-0006)
- [x] Identity-preserving cross-page move (right-click "Move to page ▸"); copy/paste stays a copy
- [x] Present mode: per-user local playback (nothing broadcast) — fullscreen page fit, no zoom/pan, geometry locked, arrows + page counter; pen/highlighter annotate live (shared ink); code/math/custom interactive in one click (no double-click), for viewers too (runs still gated by `allowViewerRuns`)
- [x] Viewers: read-only room tokens (existing) + pdf-style read-only page sidebar; canvas notebooks pick light/dark background at creation (immutable; drives element color defaults)
- [x] Live collab across pages: edits by others appear live during present (Yjs); undo manager tracks the page list (page deletion undoes as one step)
- **Demo:** full lecture prep → present locally → annotate + run widgets while students (editors) ink alongside. **MVP done.**

## Post-MVP backlog (first picks)
Snapshot restore edge cases · Playwright smoke tests · Biome + pre-commit · commenter tier · PDF import · y-indexeddb offline · BYOK generation keys (client-held per-session, server pass-through — see ADR-0004) · AI admin dashboard polish · the `docs-future-implementation/` swap path.

## Parallelization notes
- Slice 4's Piston container can be pulled any time after Slice 0 (one `docker run` on the dev Mac — no VPS needed until MVP deploy).
- Slices 5, 6, 7 are swappable among themselves if one lands late.
- Total: **~4 weeks part-time**, every week ends with a demo.
