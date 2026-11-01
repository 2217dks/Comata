-- Slice 4 (ADR-0002/0003): runs are per-user and ephemeral.
-- CodeRun is dropped — results are never persisted. Notebook gains the
-- owner-controlled allowViewerRuns setting.

DROP TABLE IF EXISTS "CodeRun" CASCADE;

ALTER TABLE "Notebook" ADD COLUMN "allowViewerRuns" BOOLEAN NOT NULL DEFAULT false;
