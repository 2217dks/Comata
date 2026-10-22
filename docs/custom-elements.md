# Custom Elements — NL-generated micro-simulations (Slice 5b)

> Natural language in → a small interactive simulator/visualizer out, living on
> the board as a first-class element. "Generate a slider which shows audio mix"
> → a working mixer widget every viewer can interact with.

## Status

- **Done (Slice 3 groundwork):** `custom` kind exists in the element union
  (`packages/elements/src/kinds.ts`) with `title` / `prompt` / `spec` /
  `specVersion` payload, registered in `ELEMENT_REGISTRY`
  (`packages/elements/src/registry.ts`). CRDT op: `addCustomElement`
  (`packages/crdt`). Renders as a placeholder card. Snapshots and future
  `.comata` export/import carry it for free because elements ride the Yjs doc
  (R1).

## Design sketch

1. **Generation flow** — user types a prompt into the element's config panel →
   API endpoint `POST /v1/generate-element` → LLM returns a **versioned spec**:
   - Option A: declarative JSON spec (controls: slider/toggle/select; a viz
     description: bar/needle/waveform; a pure function `state → viz`) —
     interpreted by our own runtime. Deterministic, safe, limited expressiveness.
   - Option B: generated HTML/JS single-file app — rendered in a **sandboxed
     iframe** (`sandbox="allow-scripts"`, no same-origin), sized to the element,
     bridged via postMessage. Fully expressive, needs careful sandboxing.
   - Likely: A for MVP breadth, B as escape hatch.
2. **Runtime** — the element renders the spec; each user's interactions are
   local (control state does NOT sync by default — the *spec* is shared, not
   the live values). Optional later: broadcast interaction state via presence
   for teacher-demos-a-slider moments.
3. **Regeneration** — `specVersion` increments on each edit; old spec kept in
   payload history for undo. Prompt is stored so "try again" is reproducible.
4. **Import/export** — spec + prompt are plain strings in the Yjs map, so the
   Yjs-snapshot-based export (Slice 6) handles them; no extra manifest work
   beyond a sanity check.

## Open questions (for the user)

1. **LLM provider/budget** — hosted API (OpenAI/Anthropic/Google) vs local?
   Cost per generation is negligible either way; which account/key do we use?
2. **Expressiveness vs safety** — declarative spec (safe, limited) or generated
   code in a sandboxed iframe (full JS)? Lean: start declarative, add iframe
   runner when a prompt genuinely needs it?
3. **Where does generation run** — API server (key stays server-side, works
   for everyone including viewers) or client-direct? Server-side is the plan.
4. **Interactivity scope for MVP** — sliders/toggles feeding a parameterized
   viz enough? (e.g., audio-mix slider → animated level bars). Arbitrary JS
   simulations can wait for the iframe runner.
