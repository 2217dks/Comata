# .comata export: SQLite database for element payloads

The `.comata` file must carry element payloads for current kinds (code) and future
kinds (math viz configs, AI-generated custom-element specs) that are per-user or
rendered client-side, and must survive kinds we haven't invented yet. A raw Yjs
snapshot blob (the previous design in `notebook-format.md`) is opaque and can't
represent structure cleanly.

We decided: a `.comata` file is a zip containing `manifest.json` plus a
`notebook.db` SQLite database holding **structured payloads for payload elements**
(code source/language/filename, math viz config, custom element specs, image
references) mapped to element ids, plus an assets folder. Geometry elements
(shapes, ink, sticky, text — payload = styling only) get **no DB rows**: they
travel entirely in `doc.yjs`. Import restores `doc.yjs` (the graph) first, then
rehydrates payloads from the DB by element id; a missing row degrades that one
element, never the import. One DB, multiple tables — one per structured kind,
plus a generic `element_payloads` fallback for future kinds until they earn a
real table. The live side is unchanged — Yjs remains the only state truth; the
DB exists only inside the export.

Rejected: loose files + manifest (filename collisions, weaker mapping), Yjs blob
(opaque, diff-unfriendly, no per-payload structure), DB-per-kind (breaks the
one-file-open-validate-import guarantee), one generic table only (contents
become opaque strings).
