# Runs are per-user and ephemeral

Teaching use case: a class opens the same notebook; everyone sees the same shared
code, but each user runs it with their own stdin and gets their own output
(10 simultaneous users = 10 unrelated runs). Results therefore have no place in
the shared doc or the database.

We decided: run results go only to the requesting user's client and are never
persisted — no `CodeRun` table, no Liveblocks room events for runs, no run
history. A user has at most one in-flight run notebook-wide (per-user run lock);
a per-account rate limit (5/min) grays the Run button with a countdown. VIEWERs
may run code subject to an owner-controlled notebook setting
(`allowViewerRuns`, default off), editable in notebook settings (Canva-style
share controls).
