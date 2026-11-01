# Per-page coordinate space; `pageId` joins the element shell

Presentation notebooks (roadmap Slice 7) are a distinct product from canvas
notebooks — Canva's whiteboard-vs-slides split. A presentation notebook is an
ordered deck of fixed 16:9 pages (1920×1080 world units), each page its own
coordinate space: every element carries a `pageId`, and there is no camera in
presentation notebooks (edit mode shows one page fit-to-viewport with
zoom/pan inside it; present mode is a per-user local playback of the same).

We considered the frame model — pages as regions on one infinite canvas, camera
jumps between them (the Slice 3 dormant implementation) — and rejected it: it
cannot express "this ink belongs to slide 3" (elements straddle frames
ambiguously), and the product explicitly follows the Canva two-surface model.

This deliberately bends the documented "never reshape the element shell"
invariant (CLAUDE.md / packages/elements): the shell gains one structural
field, `pageId`. The invariant guarded against per-kind payload bloat;
`pageId` is not payload — it is a structural field every kind shares, like
`z`. Consequences:

- Elements stay in the single `elements` Y.Map; page order lives in a
  `Y.Array` of page records. Cross-page moves keep element identity (one
  field flips) — separate Y.Maps per page would force delete+recreate,
  breaking undo and multiplayer selection.
- Every consumer (projections, hit-testing, clipboard, marquee, `nextZ`,
  `.comata` export in Slice 6) filters by the current page. Missing
  `pageId` (legacy docs) is tolerated on read only — no migration was built;
  old presentation-kind notebooks may break by design (owner opted to
  discard them).
- The frame element kind is removed outright (schema union, registry,
  CRDT factory, Board present-over-frames code, Slice 3 follow-mode /
  presenter-pill presence machinery — presentation is local, so broadcast
  presence has no remaining consumer; canvas notebooks never had Present).
