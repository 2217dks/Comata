# Generation runs on the server's own key, allowlist-gated

AI-generated custom elements (roadmap Slice 5b) call an LLM. Whose key pays is a
product decision: per-user BYOK (browser-held keys, like imagen-style tools)
means every user must configure a key before the feature works at all.

We decided: the API proxies generation through **our own server-side key**
(Google AI Studio / OpenAI-style key in `.env`, cheap models that produce an
element in one shot). No user key is stored anywhere — BYOK (client-held keys
per session, server pass-through) is explicitly deferred. Access is **deny by
default**: an `AiAllowlist` table gates `POST /v1/generate` by the
authenticated user's email; the owner grants access via a minimal admin page
(live-demo convenience). Guardrails protect the server key: per-user rate limit
(20 generations/hour), 120s timeout, max-tokens and prompt-length caps. The
system prompt (single self-contained HTML output contract) is a server-side
constant in `apps/api`.

Why: a demo-first product can't ask students to bring keys; "free access, owner
curated" matches the teaching flow and keeps key custody (and its XSS surface)
off the client entirely. The library (`GeneratedElement`) and board elements
carry specs inline, so switching to BYOK later touches only the generate
endpoint, not storage.
