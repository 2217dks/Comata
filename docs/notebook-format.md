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
├── notebook.db            # SQLite: element payloads (code, math config, custom specs)
├── doc.yjs                # the element GRAPH (geometry + z-order) as binary Yjs update
└── assets/
    └── <sha256>.<ext>     # images etc., deduplicated by content hash
```

> Per ADR-0001: element **payloads for payload elements** (code source/language/
> filename, math viz config, custom-element specs, image refs) live in
> `notebook.db` — one table per structured kind + a generic fallback table, so
> future kinds slot in without breaking the format. **Geometry elements**
> (shapes, ink, sticky, text — styling is shell) get no DB rows: they travel
> entirely in `doc.yjs`, which carries the element graph (shell geometry, kind,
> z-order). Import restores `doc.yjs` first, then rehydrates payloads from the
> DB by element id.

### `notebook.db` schema

```sql
-- one table per structured payload kind
CREATE TABLE code_elements (
  element_id TEXT PRIMARY KEY,   -- matches doc.yjs element id
  filename   TEXT NOT NULL,      -- e.g. "Untitled-1.py"
  language   TEXT NOT NULL,      -- runner language id, e.g. "python"
  source     TEXT NOT NULL
);

CREATE TABLE math_elements (
  element_id    TEXT PRIMARY KEY,
  expression    TEXT NOT NULL,   -- math.js source
  config_json   TEXT NOT NULL    -- sliders, camera, viz settings (declarative)
);

CREATE TABLE image_elements (
  element_id TEXT PRIMARY KEY,
  asset_hash TEXT NOT NULL,      -- sha256 → assets/ folder + manifest
  caption    TEXT
);

-- fallback for future/custom kinds until they earn a real table
CREATE TABLE element_payloads (
  element_id   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,    -- e.g. "custom"
  payload_json TEXT NOT NULL
);
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
| Shapes, ink, sticky, text (+ inline LaTeX), frames | `doc.yjs` only — **geometry elements, no DB rows** | styling is shell; LaTeX travels as source — KaTeX re-renders on import |
| **Code elements** | `notebook.db` `code_elements` | filename, language, source. Stdin and outputs are **not exported** — per-user, never part of the doc (ADR-0003) |
| **Math equations / graphs / visualizers** | `notebook.db` `math_elements` | math.js/MathBox **re-compile on import** — plots rebuild themselves |
| **Images** | `notebook.db` `image_elements` + `assets/<sha256>.<ext>` | payloads reference `asset:sha256-…`; import remaps to uploaded URLs |
| **Custom (AI) elements** | `notebook.db` `element_payloads` (kind = `custom`) | prompt + versioned spec — promoted to a real table when stable |
| Run results / stdin | **not exported** | runs are per-user and ephemeral (ADR-0003) — never notebook content |

**Key design rule:** every element payload is **declarative data** (source text,
expressions, config — never rendered blobs). That's what makes export/import lossless:
the importing app re-renders everything from payloads, exactly like opening a `.fig`.

## 3. Export flow

1. Freeze the room's Yjs doc → element graph → `doc.yjs`; walk payloads → rows in `notebook.db` (ADR-0001).
2. Collect `asset:` refs → copy blobs from Supabase Storage into `assets/` (dedupe by hash).
3. Emit `manifest.json` (counts act as a cheap integrity check).
4. Zip → download. No server round-trip beyond asset fetches; assembled client-side in `packages/format`.

## 4. Import flow

1. Unzip, validate `manifest.format` + `formatVersion` ≤ current, verify counts vs contents.
2. Create `Notebook` row (reassign new id; owner = importer).
3. Upload `assets/*` to Supabase Storage keyed by hash (idempotent — same hash = same object).
4. Create the Liveblocks room, `Y.applyUpdate(doc.yjs)`, apply `notebook.db` rows to element payloads — `asset:sha256` refs resolve against the just-uploaded set (hash-addressed, so remap is a lookup, not a rewrite).
5. Open the notebook. Everything is pixel-equal; code elements carry source but no stdin/output (per-user, ADR-0003).

## 5. Rules that keep the format stable

- **`schemaVersion` gates everything:** import of an older `schemaVersion` runs the element-model migrations from `packages/elements` (same migrations used when opening old snapshots). Newer-than-app files are rejected with a clear message.
- **Assets are content-addressed** (sha256) — dedupe, integrity, and import remap all fall out of one choice.
- **`formatVersion` ≠ `schemaVersion`:** container-level vs element-model-level versioning, bumped independently.
- **ZIP, not JSON blobs:** large base64 images inside a single JSON would balloon memory; the zip keeps `doc.yjs` binary and `notebook.db` a real SQLite file.
- **Implementation home:** `packages/format` — no app imports; apps call `exportNotebook(doc, assets)` / `importNotebook(file)`.

## 6. MVP scope guard

- Export/import of **canvas + presentation** kinds and the 8 element types in product-scope.md — all included (they're all declarative payloads).
- **Not** in the file: sharing/permission state, run history, thumbnails (regenerated), user avatars.
- `formatVersion` stays `1` for the whole MVP; bump rules documented above.
