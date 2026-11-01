import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import type { LibraryEntry } from "@comata/schema";

// ── AI Create modal (Slice 5b) ───────────────────────────────────────────────
// Centered modal with a dimmed backdrop, opened by clicking the canvas with
// the AI Create tool. Two tabs: "New" (NL prompt → generate) and "Library"
// (re-spawn a past generation without an LLM call — Canva-uploads style).
// The caller owns spawn+generation; this component only collects the prompt /
// entry pick. Backdrop click / Esc closes; the canvas is unreachable while
// open (the element spawns where the tool was clicked, stored by the caller).

export function AiCreateModal({
  onSpawn,
  onSpawnFromLibrary,
  onClose,
}: {
  /** NL prompt → fire generation. */
  onSpawn: (prompt: string) => void;
  /** Library entry → spawn instantly with the stored spec (no LLM call). */
  onSpawnFromLibrary: (entry: LibraryEntry) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"new" | "library">("new");
  const [prompt, setPrompt] = useState("");
  const [library, setLibrary] = useState<LibraryEntry[] | null>(null);
  const [libError, setLibError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const loadLibrary = async () => {
    setLibrary(null);
    setLibError("");
    try {
      const res = await api<{ entries: LibraryEntry[] }>("/v1/ai/library");
      setLibrary(res.entries);
    } catch (err) {
      setLibError(err instanceof Error ? err.message : String(err));
      setLibrary([]);
    }
  };

  useEffect(() => {
    if (tab === "library" && library === null) loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const canSend = prompt.trim().length > 0;

  // Portal to <body>: the board tree is camera-transformed, which turns
  // position:fixed into position:absolute against that ancestor — the overlay
  // would size to the board and push the page around instead of covering the
  // viewport. Escaping to body makes it a true viewport modal.
  return createPortal(
    <div
      className="ai-create-overlay"
      onPointerDown={(e) => {
        // Backdrop click closes; clicks inside the dialog don't.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ai-create-popup"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="ai-create-tabs">
          <button className={tab === "new" ? "active" : ""} onClick={() => setTab("new")}>
            ✦ New
          </button>
          <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>
            Your generated elements
          </button>
        </div>

        {tab === "new" ? (
          <div className="ai-create-new">
            <textarea
              ref={inputRef}
              value={prompt}
              maxLength={2000}
              placeholder="Describe a small interactive widget… e.g. “a mixer with 3 sliders showing audio levels as bars”"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (canSend) onSpawn(prompt.trim());
                }
              }}
            />
            <div className="ai-create-actions">
              <span className="ai-create-hint">{canSend ? "⌘↵ to generate" : "⌘↵ to generate · esc to cancel"}</span>
              <button className="ai-create-send" disabled={!canSend} onClick={() => onSpawn(prompt.trim())}>
                ✦ Generate
              </button>
            </div>
          </div>
        ) : (
          <div className="ai-create-library">
            {library === null && <div className="ai-lib-status">Loading…</div>}
            {library !== null && library.length === 0 && (
              <div className="ai-lib-status">Nothing generated yet — your generations are saved here.</div>
            )}
            {libError && <div className="ai-lib-status ai-lib-error">{libError}</div>}
            {library?.map((entry) => (
              <button
                key={entry.id}
                className="ai-lib-entry"
                title={entry.description || entry.prompt}
                onClick={() => onSpawnFromLibrary(entry)}
              >
                <span className="ai-lib-title">{entry.title}</span>
                <span className="ai-lib-desc">{entry.description || entry.prompt}</span>
                <span className="ai-lib-meta">
                  {new Date(entry.createdAt).toLocaleDateString()} · v{entry.specVersion}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
