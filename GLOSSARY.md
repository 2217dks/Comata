# Comata

Single context: an infinite-canvas + presentation teaching tool where code runs and everything is an element on the board.

## Language

### Notebook

**Notebook**:
A project container that behaves like an infinite canvas or a slide deck; owns membership and settings.
_Avoid_: project, board (board is the canvas surface itself)

**Member**:
A user attached to a notebook with a role: OWNER, EDITOR, or VIEWER.
_Avoid_: collaborator, participant

**Notebook settings**:
Owner-controlled notebook-level options (share/permission controls, viewer-run allowance).
_Avoid_: permissions panel, admin panel

**Canvas notebook**:
A notebook of the canvas kind: one infinite surface, no pages. Background (light or dark) is fixed at creation and cannot be changed afterward.
_Avoid_: whiteboard, freeform notebook

**Presentation notebook**:
A notebook of the presentation kind: an ordered deck of pages, each with its own coordinate space; the slide-deck surface (Canva-slides-like). Distinct product from the canvas notebook.
_Avoid_: slides project, deck (in prose), slide (a page is the thing; avoid "slide" as a noun for it)

**Page**:
One slide of a presentation notebook: a fixed 16:9 surface (1920×1080 world units) with its own coordinate space, per-page background color, and its own set of elements. Identified by number only (1, 2, 3…). Elements belong to exactly one page; moving between pages preserves element identity.
_Avoid_: slide, frame (the deprecated frame kind), canvas

### Elements

**Element**:
Any item on the board; a uniform geometry shell plus a per-kind payload, stored in the shared doc.
_Avoid_: block, object, shape (shape is a specific kind)

**Geometry element**:
An element whose payload is nothing beyond shell styling (shapes, ink, sticky, text); carries no DB row in a `.comata` file.
_Avoid_: simple element, basic shape

**Payload element**:
An element with structured content beyond the shell (code, math, image, custom), stored as a table row in a `.comata` file's `notebook.db`.
_Avoid_: rich element, content element

**Code element**:
An element that holds one named, single-file program (source, language, filename) which any write-permitted member can edit live and any signed-in member can run.
_Avoid_: code block, code file (reserved for export), script

**Filename**:
The user-facing name of a code element's program, e.g. `main.py`; the extension always follows the selected language.
_Avoid_: title, file name

**Stdin**:
The per-user input text fed to a run; never shared between users and never part of the shared doc.
_Avoid_: input box contents, console input

**Interactive element**:
A payload element with per-user local interaction (code: run + input; math: graph pan/zoom; custom: widget controls) that stays usable in present mode — no double-click needed — while geometry editing (drag/resize/modify) stays edit-mode-only. Viewer access to interactive parts follows the existing rules (runs gated by `allowViewerRuns`; equations never editable by viewers).
_Avoid_: live element, active element

**Default element color**:
The starting ink/text color for a new element, derived from background luminance — light background → dark ink, dark background → light ink. Derived per page in presentation notebooks, per notebook background in canvas notebooks.
_Avoid_: theme color, palette

### Runs

**Run**:
One per-user, ephemeral execution of a code element's current source; the result goes only to the user who triggered it.
_Avoid_: execution, submission (Judge0-internal), job

**Run lock**:
The rule that a user has at most one in-flight run at a time, across all code elements in their session.
_Avoid_: element lock, per-element lock

**Run rate limit**:
The per-account cap on runs per minute; exceeding it grays the run button with a countdown.
_Avoid_: throttle, quota

### Persistence & exchange

**Shared doc (Yjs doc)**:
The single source of truth for element state, carried by the Liveblocks room; SQL only ever stores snapshots of it.
_Avoid_: database, CRDT state

**Snapshot**:
A serialized copy of the shared doc stored in SQL; restore = load into the doc.
_Avoid_: backup, save

**`.comata` file**:
The single-file export/import format for a whole notebook.
_Avoid_: export archive, notebook file

**Code file**:
A real program file (e.g. `main.py`) materialized from a code element when writing a `.comata` file.
_Avoid_: code element (that's the board item)

### Modes

**Edit mode**:
The default working state of a presentation notebook: full editing interactions on the current page, page sidebar visible, zoom/pan available within the page.
_Avoid_: design mode, canvas mode

**Present mode**:
The per-user full-screen playback of a presentation notebook: current page fit to viewport, no zoom/pan, chrome hidden to arrows + page counter, geometry locked (nothing draggable), interactive elements stay interactive without double-click, and pen/highlighter/eraser still lay shared ink on the page. Local — presenting has no effect on other participants; live edits by others still appear.
_Avoid_: presenting (that's the *action*; avoid as a mode name), slideshow, broadcast
