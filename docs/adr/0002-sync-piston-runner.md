# Code execution: synchronous self-hosted Piston, no queue/worker

MVP code execution needs to be free, runnable on the dev Mac (including LAN
users), and cheap to deploy. Public Piston no longer issues keys; Vercel/Netlify/
Replit cannot run sandboxes; the documented Valkey + BullMQ worker + Judge0 VPS
machinery is disproportionate for 5–6 users with per-user ephemeral runs.

We decided: `POST /v1/runs` calls a **self-hosted Piston** (single Docker
container, dev backend = the developer's Mac) synchronously and returns the
result in the HTTP response. The runner sits behind a thin interface
(`packages/runner`) so a Judge0 swap later touches one module. Rate limiting and
the per-user run lock live in in-memory API counters; Valkey/queue/worker are
out of MVP scope entirely.

Rejected: Judge0 + worker + queue now (infra weight, no free hosted option),
public Piston (closed to new keys).
