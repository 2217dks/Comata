# Notebook Format — `.comata` (export/import)

> The notebook is a portable project file, like Figma's `.fig`: one file carries
> the **entire notebook** — every element (text, ink, shapes, code blocks, math
> equations, interactive visualizers, images, frames) plus assets — and can be
> re-imported into any Comata instance.

## 1. Container

**Extension:** `.comata` · **Container:** ZIP (ubiquitous, streamable, debuggable)

```
my-lesson.comata
├── manifest.json          # metadata + integrity
├── doc.yjs                # the ENTIRE element graph (binary Yjs update)
└── assets/
    └── <sha256>.<ext>     # images etc., deduplicated by content hash
```

### `manifest.json`

```jsonc
{
  "format": "comata/notebook",
  "formatVersion": 1,              // bump on breaking element-model changes
  "app": { "name": "Comata", "generator": "1.0.0-mvp" },
  "notebook": {
    "id": "uuid (original id — import may reassign)",
    "title": "Quadratic Equations — Week 4",
    "kind": "canvas",              // canvas | presentation
    "schemaVersion": 1,            // element-model version (matches Notebook.schemaVersion)
    "exportedAt": "2026-10-21T12:00:00Z"
  },
  "counts": { "elements": 42, "assets": 3 },   // quick integrity check
  "assets": [
    { "hash": "sha256-…", "file": "assets/sha256-….png", "mime": "image/png", "bytes": 182044 }
  ]
}
```

## 2. What travels where

| Content | Location in file | Notes |
|---|---|---|
| Text elements (+ inline LaTeX) | `doc.yjs` (element payload) | LaTeX travels as source — KaTeX re-renders on import |
| Ink strokes, shapes, frames | `doc.yjs` | pure geometry — nothing else needed |
| **Code blocks** | `doc.yjs` (payload: lang, source, stdin, last output) | the code is *content*, not a live process — imports cleanly |
| **Math equations / graphs** | `doc.yjs` (payload: expression, sliders, view config) | math.js/MathBox **re-compile on import** — plots rebuild themselves |
| **Interactive visualizers (3D)** | `doc.yjs` (payload: expression + camera/scene config) | MathBox state is declarative config, re-instantiated on import |
| **Images** | `assets/<sha256>.<ext>` | element payloads reference `asset:sha256-…`; import remaps to uploaded URLs |
| Run history | **not exported** | execution history is instance-local, not notebook content |

**Key design rule:** every element payload is **declarative data** (source text,
expressions, config — never rendered blobs). That's what makes export/import lossless:
the importing app re-renders everything from payloads, exactly like opening a `.fig`.

## 3. Export flow

1. Freeze the room's Yjs doc → `Y.encodeStateAsUpdate(ydoc)` → `doc.yjs`.
2. Walk element payloads, collect `asset:` refs → copy blobs from Supabase Storage into `assets/` (dedupe by hash).
3. Emit `manifest.json` (counts act as a cheap integrity check).
4. Zip → download. No server round-trip beyond asset fetches; assembled client-side in `packages/format`.

## 4. Import flow

1. Unzip, validate `manifest.format` + `formatVersion` ≤ current, verify counts vs contents.
2. Create `Notebook` row (reassign new id; owner = importer).
3. Upload `assets/*` to Supabase Storage keyed by hash (idempotent — same hash = same object).
4. Create the Liveblocks room, `Y.applyUpdate(doc.yjs)` — payloads' `asset:sha256` refs resolve against the just-uploaded set (hash-addressed, so remap is a lookup, not a rewrite).
5. Open the notebook. CodeRun history starts empty; everything else is pixel-equal.

## 5. Rules that keep the format stable

- **`schemaVersion` gates everything:** import of an older `schemaVersion` runs the element-model migrations from `packages/elements` (same migrations used when opening old snapshots). Newer-than-app files are rejected with a clear message.
- **Assets are content-addressed** (sha256) — dedupe, integrity, and import remap all fall out of one choice.
- **`formatVersion` ≠ `schemaVersion`:** container-level vs element-model-level versioning, bumped independently.
- **ZIP, not JSON blobs:** large base64 images inside a single JSON would balloon memory; the zip keeps `doc.yjs` a clean binary.
- **Implementation home:** `packages/format` — no app imports; apps call `exportNotebook(doc, assets)` / `importNotebook(file)`.

## 6. MVP scope guard

- Export/import of **canvas + presentation** kinds and the 8 element types in product-scope.md — all included (they're all declarative payloads).
- **Not** in the file: sharing/permission state, run history, thumbnails (regenerated), user avatars.
- `formatVersion` stays `1` for the whole MVP; bump rules documented above.
