# MVP Product Scope

> Source of truth for what gets built. Everything not listed here is deferred.
> Vision: `../IDEA.md`. Archived production specs: `../docs-future-implementation/`.

## The core concept: Notebooks

A user creates a **Notebook** — the project container, exactly like creating a
project in Canva. The app *works inside a notebook*: everything below (elements,
collab, present mode) happens within one. Notebooks are **portable**: export any
notebook as a single `.comata` file (like a `.fig`) containing all elements and
assets, and import it anywhere — see [notebook-format.md](notebook-format.md).

## The MVP in one sentence

A signed-in user creates a **notebook** (infinite canvas or presentation), adds
**ink, shapes, text, code, math, and interactive-visualizer elements** alongside
other users in real time, **runs code live**, and can **export/import the whole
notebook as a file**.

## In scope

### Notebooks (project container)
- [ ] "New notebook" picker (Canva-style: kind + title)
- [ ] **Infinite canvas** kind — pan/zoom board, frame elements as camera stops for present mode
- [ ] **Presentation** kind — fixed 16:9 pages, ordered, page-flip edit + present
- [ ] Notebook dashboard: list, rename, delete, open
- [ ] **Export → `.comata`** (all elements + assets, single file)
- [ ] **Import ← `.comata`** (validate, remap assets, reopen fully interactive)

### Element system (uniform behavior — IDEA §3)
Every element: drag, resize, select, delete, duplicate, z-order. Per-type payload behind a common geometry shell. All payloads are **declarative data** — which is what makes `.comata` export/import lossless.

| Element | MVP feature bar | Type |
|---|---|---|
| **Ink** | pen + highlighter, pressure-optional, color/width | `ink` |
| **Shapes** | rect, ellipse, line, arrow, sticky note | `shape` |
| **Text** | basic styling (bold/italic/size/color) + inline LaTeX via KaTeX | `text` |
| **Code** | In-element CodeMirror editor, auto-named file (e.g. `Untitled-1.py`), language selector (runner-provided runtimes), RUN button, always-visible Input/Output/Error tabs, per-user stdin + output (never shared/persisted), Run → self-hosted Piston | `code` |
| **Math equation/graph** | 2D `y=f(x)` plot with live re-plot, parameter sliders; 3D surface `z=f(x,y)` via MathBox; standalone equation rendering via KaTeX | `math` |
| **Interactive visualizer** | MathBox-driven 2D/3D scene from declarative config (expression + camera + sliders) — rebuilds itself on import | `math` (viz payload) |
| **Frame** | named rectangle = camera stop (canvas kind) / page container (presentation kind) | `frame` |
| **Image** | place + scale + annotate on top (upload → Supabase Storage, content-hashed) | `image` |

### Collaboration (IDEA §4)
- [ ] Liveblocks rooms per notebook (`notebook:{id}`): live cursors (name + color), presence avatars
- [ ] Shared Yjs doc via `@liveblocks/yjs` — concurrent element edits just work
- [ ] Permission tiers: owner / editor / viewer (commenter-tier deferred — see below)
- [ ] Share link → join as viewer or editor (owner decides)
- [ ] **Follow mode**: viewer viewport locks to presenter's camera

### Auth & accounts
- [ ] Better-Auth (Prisma 7 adapter): email+password, Google OAuth, magic link
- [ ] Ownership enforced at the API boundary (Hono middleware) and at Liveblocks auth

### Code execution pipeline (per-user, ephemeral — ADR-0002/0003)
- [ ] Self-hosted Piston (single Docker container; dev backend = dev Mac), behind `packages/runner` interface
- [ ] Flow: Run button → `POST /v1/runs` → in-memory run lock + rate limit (5/min/user) → Piston → result in the HTTP response
- [ ] Global caps: 10s wall / 512MB; runtimes list fetched from the runner
- [ ] Per-user stdin (local only, never shared/exported); code + filename + language shared via Yjs
- [ ] `allowViewerRuns` notebook setting (owner toggle in settings; viewers run when on)
- [ ] Editor stays editable during a run; Run button states: idle → spinner → result / rate-limited countdown

## Explicitly deferred (do NOT build in MVP)

| Feature | Where it lives later |
|---|---|
| PDF / DOCX / PPTX import & annotation | production `rfc-006`; needs object storage + worker rasterize |
| Commenter tier + comment threads | needs comment layer design (archived R3) |
| Handwriting → text recognition | stretch goal, no schema impact |
| Per-user theming of shared notebooks | production D5 styling rules |
| VFS full file manager (multi-file notebooks) | MVP: code element = single inline file per element; real VFS in production R2 |
| Offline support / IndexedDB persistence | production `y-indexeddb` integration |
| Notebook templates / community gallery | post-MVP (export format makes this trivial later) |
| Mobile/touch polish | react-konva touch events work; UX tuning later |
| E2E tests, load tests, lint/format | post-MVP hardening (archived D19/D20) |
| Self-hosted collab (Hocuspocus), gVisor sandbox, Turborepo | `../docs-future-implementation/` swap path |

## Success criteria (definition of done for the MVP)

1. Two users in different browsers see each other's cursors and edits on the same notebook in < 500 ms.
2. A teacher draws an arrow at a code element's bug, edits the code, hits Run, and the class sees the new output.
3. A math element re-plots live while a slider animates a parameter, with ink annotations on top of it.
4. Present mode drives all viewers' viewports from the presenter's.
5. A notebook exported as `.comata` imports on another account with **every element intact and interactive** — code runs, graphs re-plot, images resolve.
6. Total monthly hosting bill ≤ $5.
