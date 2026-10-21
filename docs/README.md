# Comata — MVP Documentation

**An infinite canvas + presentation tool for teaching, where code runs, math comes alive, and everything is just another element on the board.**

> See `../IDEA.md` for the full product vision. These docs cover the **MVP only**:
> ship a working prototype for 5–6 concurrent users at ~$0–5/mo hosting cost.
> **Core concept:** users create **Notebooks** (projects, Canva-style) that work
> like infinite canvases or slide decks — and export/import as a single `.comata`
> file carrying every element and asset.

## Doc map (read in order)

| Doc | What it gives you |
|---|---|
| [mvp-stack.md](mvp-stack.md) | The finalized tech stack + deployment topology + costs |
| [product-scope.md](product-scope.md) | What's IN the MVP, what's deferred, element checklist |
| [architecture.md](architecture.md) | How the pieces talk to each other, wiring rules, data flow |
| [data-model.md](data-model.md) | ER diagram + Prisma 7 schema (Notebook-centric) |
| [notebook-format.md](notebook-format.md) | The `.comata` export/import format (the `.fig` equivalent) |
| [setup.md](setup.md) | From zero to running locally + deploy checklist |
| [roadmap.md](roadmap.md) | Vertical-slice build order with timeboxes |

## Fast-MVP doc rules

1. **Docs are checklists, not essays.** If a doc can't change code behavior this week, it doesn't belong here.
2. **Vertical slices over layers.** Every milestone ends with something a user can click.
3. **Thin interfaces around every cloud service** (Liveblocks, Supabase, Judge0) so the production swap (see `../docs-future-implementation/`) touches one file, not the codebase.
4. **No specs for deferred features.** When a feature enters scope, write its doc then.

## Non-negotiables carried over from the archived docs

Even at MVP speed, two invariants from the production architecture hold — they're cheap to keep and expensive to retrofit:

- **R1:** Yjs is the only state truth. Postgres (Supabase) stores metadata and snapshots, never element geometry.
- **Element model:** every board item is an element with uniform geometry/lifecycle fields + a typed payload (RFC-001 spirit). The Konva renderer consumes a projected doc view, so swapping Konva → PixiJS later touches one package.
