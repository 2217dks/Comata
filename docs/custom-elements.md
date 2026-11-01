# Custom Elements — NL-generated micro-simulations (Slice 5b)

> Natural language in → a small interactive simulator/visualizer out, living on
> the board as a first-class element. "Generate a slider which shows audio mix"
> → a working mixer widget every viewer can interact with.

## Status — design settled (ADR-0004); **implemented (Slice 5b)**

- **Landed:** full flow — AI Create dock tool → spawn popup (New prompt tab +
  "Your generated elements" library tab) → element spawns with
  `status: 'generating'` (wavy box, doc-shared so all viewers see it) →
  `POST /v1/ai/generate` (Gemini `gemini-2.0-flash` via the server's key,
  plain REST — no SDK) → sandboxed iframe render, double-click interaction
  gate, postMessage ready/error/resize bridge → regenerate + edit-prompt
  (properties bar) → immutable `GeneratedElement` library rows + re-spawn →
  `/ai-admin` allowlist page (deny by default).
- **Provider:** Gemini (user decision 2026-10-26). `GEMINI_API_KEY` in root
  `.env`. The model contract (system prompt, `apps/api/src/gemini.ts`): single
  self-contained HTML doc, two leading HTML-comment metadata lines
  (`title:`, `description:`), `postMessage` ready/error calls, responsive +
  dark theme.
- **DB:** `AiAllowlist` + `GeneratedElement` tables (migration
  `ai_allowlist_generated_element`).
- **Done (Slice 3 groundwork):** `custom` kind exists in the element union
  (`packages/elements/src/kinds.ts`) with `title` / `prompt` / `spec` /
  `specVersion` payload, registered in `ELEMENT_REGISTRY`
  (`packages/elements/src/registry.ts`). CRDT op: `addCustomElement`
  (`packages/crdt`). Renders as a placeholder card. Snapshots and future
  `.comata` export/import carry it for free because elements ride the Yjs doc
  (R1).

## Decisions

1. **Output format: generated HTML (Option B), declarative spec dropped.**
   The LLM returns a **single self-contained HTML file** (inline CSS + JS, no
   network calls — enforced by system prompt + sandbox + CSP meta), stored as a
   string in `spec.html`, rendered via `srcdoc` in a sandboxed iframe
   (`sandbox="allow-scripts"`, **no** `allow-same-origin`). A declarative JSON
   spec interpreter (old Option A) was cut: a full interpreter is more code and
   still less expressive than arbitrary HTML/JS, and the sandbox contains the
   risk regardless. Cheap validation: size cap (~200KB), non-empty.

2. **Generation: server's own key, allowlist-gated (ADR-0004).**
   `POST /v1/generate` proxies to a cheap model via our server-side key (Google
   AI Studio / OpenAI-style key in `.env`). No user keys — BYOK (client-held
   per-session keys, server pass-through) is deferred; key-storage research
   verdict for later: sessionStorage/memory-only, never plaintext localStorage.
   **Deny by default**: an `AiAllowlist { email }` table + minimal admin page
   gates who can generate; the owner adds emails live during demos. Guardrails:
   20 generations/hour/user, 120s timeout, max-tokens + prompt-length caps
   (~2000 chars). The system prompt (output contract) is a server-side constant
   in `apps/api`.

3. **Flow.** Dock tool **"AI Create"** (sparkles SVG) → click canvas → popup
   ("define your requirements" + send) → element is created in Yjs immediately
   with `status: 'generating'` → **wavy AI loading box visible to everyone**
   → replaced by the generated element when the spec lands. Failure → error
   card on the board (Retry / Edit prompt). One generation in flight per user.

4. **Payload.** `{ title, prompt, description?, spec: { html, specVersion } | null, status: 'generating' | 'ready' | 'error', errorMessage?, libraryId? }`.
   `specVersion` bumps on every generation/edit; the system prompt also asks the
   LLM for a short human-readable `description`.

5. **Interaction: per-user, edit-mode gated.** Generated code runs fully
   client-side in each viewer's own iframe — interaction state is local by
   construction (nothing to sync). Pointer events are captured by the board
   until **double-click** enters edit mode (same model as code elements); only
   then do the iframe's buttons/sliders work for that user. No collab locking.
   In edit mode a crashed app shows its error card.

6. **postMessage bridge v1.** host→iframe `resize {w,h}`; iframe→host `ready`
   and `error {message}` (window.onerror surfaced instead of a white frame).
   Generated apps are instructed (via system prompt) to be responsive; element
   resize just re-posts the new size. No state sync or control API in v1.

6b. **Host library injection.** The generation prompt tells the model about two
   libraries injected before the widget's own scripts when the spec references
   them (`apps/web/src/board/vendor.ts` sniffes `math.` / `THREE.` usage):
   - `math` — the full mathjs 15 instance (parse/evaluate/derivative/simplify/
     matrix/complex/unit) — UMD build from the app's own dependency
   - `THREE` — the full three.js r186 namespace — esbuild IIFE bundle
     (`node_modules/.pnpm/three@*/node_modules/three/build/three.module.js`,
     `--global-name=THREE`); regenerate with esbuild when three is upgraded
   Widgets get real math/3D power without hand-rolled reimplementation and
   without any network. Light widgets that reference neither stay byte-clean.

7. **Regenerate / edit-prompt.** Properties-bar affordance on selection; only
   the element's own generator can regenerate. Edit-prompt feeds the existing
   element + instruction back through generation → same loading state → new
   spec replaces old; both old and new specs are preserved in the library
   (immutable rows). ⌘Z (per-user UndoManager) also reverts spec changes for
   free since they're normal Yjs edits.

8. **Library: "Your generated elements" (Canva-uploads-style).** A
   `GeneratedElement` table (userId, title, prompt, description, html,
   specVersion, createdAt) — account-level, per-user. Every generation appends
   an immutable row; deleting a board element never removes the library entry;
   the spawn popup gets a browse tab to re-spawn any past generation instantly
   (no LLM call). Board payload keeps `libraryId?` pointing back.

9. **Export: unchanged.** Board elements carry `spec.html` inline (they must,
   to render), so Slice 6's `.comata` round-trip needs zero new work. The
   library is account-local, not part of portability.

## Open questions

- BYOK return path: when subscriptions/BYOK land, key storage should use
  sessionStorage/memory-only + server pass-through (researched — plaintext
  localStorage like imagen.yusufipek.me is the pattern to avoid).
- Optional presence-based "teacher demos a slider" broadcast later (spec is
  shared; interaction is local — a broadcast mode could mirror control state
  via awareness).
