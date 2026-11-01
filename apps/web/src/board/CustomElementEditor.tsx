import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CustomShape } from "@comata/elements";
import { api } from "../lib/api";
import { hostLibraryScripts } from "./vendor";

// ── Custom element (AI-generated widget, Slice 5b) ───────────────────────────
// Same DOM-overlay contract as CodeElementEditor/MathElementEditor: this
// component IS the element's pixels, mounted inside the camera-transformed
// board container. Three visual states, all visible to every viewer (status
// rides the doc):
//   generating → wavy animated box (prompt echoed under the waves)
//   ready      → sandboxed iframe (srcdoc, allow-scripts, NO same-origin)
//   error      → readable error card (the iframe would be a white frame)
//
// Interaction is per-user and edit-mode gated: the board captures the pointer
// until double-click enters edit mode (code-element model) — only then do the
// widget's controls receive events for THIS user. Interaction state is local
// by construction; nothing to sync (docs/custom-elements.md §5).
//
// postMessage bridge v1 (§6): iframe→host `ready` / `error {message}`; the
// system prompt instructs generated apps to send both. Host→iframe `resize`
// fires on element resize so responsive widgets re-layout.

export const CustomElementEditor = memo(function CustomElementEditor({
  el,
  interactive,
  editing,
  style,
  onChange,
  onWindowDragStart,
  onExitEdit,
}: {
  el: CustomShape;
  /** False while a creation tool is active — never steals the pointer. */
  interactive: boolean;
  /** Edit mode: iframe receives pointer events (double-click gate). */
  editing: boolean;
  style: React.CSSProperties;
  onChange: (patch: {
    status?: "generating" | "ready" | "error";
    errorMessage?: string;
  }) => void;
  onWindowDragStart: (e: React.PointerEvent) => void;
  onExitEdit: () => void;
}) {
  const [appError, setAppError] = useState("");
  const [ready, setReady] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // Reset per-spec local state when a new spec lands (regenerate/edit).
  useEffect(() => {
    setAppError("");
    setReady(false);
  }, [el.spec, el.specVersion]);

  // postMessage bridge: generated apps report ready / runtime errors.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // srcdoc iframes have origin "null"; accept only messages from our
      // own frame (source check), then read the payload.
      if (e.source !== frameRef.current?.contentWindow) return;
      const data = e.data as { type?: string; message?: string } | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "ready") setReady(true);
      if (data.type === "error" && typeof data.message === "string") {
        setAppError(data.message);
        // A crashed app is an element-level error state (visible to all).
        onChange({ status: "error", errorMessage: data.message });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onChange]);

  // Resize bridge: the iframe must always hold the CURRENT box so responsive
  // widgets lay out to it. A ResizeObserver on the body catches every source
  // of size change — element resize gestures (live Transformer rects), scale
  // changes, first mount — and posts only when the measured size actually
  // moved. (The old effect keyed on el.w/el.h missed mid-gesture mirror
  // sizes and never sent the initial size.)
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || el.status !== "ready") return;
    const post = () => {
      const win = frameRef.current?.contentWindow;
      if (!win) return;
      const w = Math.round(body.clientWidth);
      const h = Math.round(body.clientHeight);
      if (w === lastSizeRef.current.w && h === lastSizeRef.current.h) return;
      lastSizeRef.current = { w, h };
      win.postMessage({ type: "resize", w, h }, "*");
    };
    const ro = new ResizeObserver(post);
    ro.observe(body);
    // First size lands on the next frame — the iframe may not exist yet on
    // the initial observe callback.
    const t = window.setTimeout(post, 0);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [el.status, el.spec, el.specVersion]);

  const isGenerating = el.status === "generating";
  const isError = el.status === "error";
  const showIframe = el.status === "ready" && el.spec !== "";

  return (
    <div
      className={`custom-editor ${interactive ? "" : "custom-editor-passive"} ${editing ? "custom-editor-editing" : ""}`}
      data-el-id={el.id}
      style={style}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (interactive && !editing) onExitEdit(); // replaced below — see board
      }}
    >
      {/* Title bar — doubles as the OS-window drag handle (code/math model). */}
      <div
        className="custom-toolbar"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          onWindowDragStart(e);
        }}
      >
        <span className="custom-title" title={el.description || el.prompt}>
          ✦ {el.title}
        </span>
        <span className="custom-flex" />
        {editing && (
          <button
            className="custom-done"
            title="Exit interaction (back to board)"
            onClick={onExitEdit}
          >
            Done
          </button>
        )}
      </div>

      <div className="custom-body" ref={bodyRef}>
        {isGenerating && (
          <div className="custom-generating">
            <div className="custom-waves" aria-hidden="true">
              <span /><span /><span /><span /><span />
            </div>
            <div className="custom-gen-label">Generating…</div>
            {el.prompt && <div className="custom-gen-prompt">{el.prompt}</div>}
          </div>
        )}

        {isError && (
          <div className="custom-error-card">
            <div className="custom-error-head">This widget crashed</div>
            <div className="custom-error-msg">{el.errorMessage || appError || "Generation failed"}</div>
          </div>
        )}

        {showIframe && (
          <>
            {/* Interaction gate: pointer-events none until edit mode. */}
            <iframe
              ref={frameRef}
              className="custom-frame"
              srcDoc={hostLibraryScripts(el.spec) + el.spec}
              title={el.title}
              sandbox="allow-scripts"
              style={{ pointerEvents: editing ? "auto" : "none", opacity: ready ? 1 : 0.35 }}
            />
            {!editing && !ready && <div className="custom-loading">loading…</div>}
            {!editing && ready && (
              <div className="custom-interact-hint">Double-click to interact</div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

/** Modal instruction input for edit-prompt regeneration (§7). Portaled to
 * <body> — the board tree is camera-transformed, which breaks position:fixed. */
export function EditPromptDialog({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (instruction: string) => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return createPortal(
    <div
      className="edit-prompt-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="edit-prompt-dialog" onKeyDown={(e) => e.stopPropagation()}>
        <h4>Change this widget</h4>
        <textarea
          ref={inputRef}
          value={text}
          maxLength={2000}
          placeholder="e.g. make the sliders vertical and add a master volume knob"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
              e.preventDefault();
              onSubmit(text.trim());
            }
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="edit-prompt-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="ai-create-send" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
            ✦ Regenerate
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Regenerate an existing element with an instruction (edit-prompt flow).
 * The instruction alone is thin context — the request carries the element's
 * title/prompt/description alongside the HTML so the model knows WHAT the
 * widget is, not just what its code looks like. */
export async function regenerateCustomElement(
  el: CustomShape,
  instruction: string,
  patch: (p: Partial<CustomShape>) => void,
  isAlive: () => boolean,
) {
  patch({ status: "generating", errorMessage: "" });
  try {
    const res = await api<{
      title: string;
      description: string;
      html: string;
      libraryId: string;
    }>("/v1/ai/generate", {
      method: "POST",
      body: JSON.stringify({
        instruction,
        baseHtml: el.spec,
        // Schema caps at 2000 chars — truncate the context line.
        prompt: `Widget "${el.title}"${el.description ? ` — ${el.description}` : ""}. Original request: ${el.prompt}`.slice(0, 2000),
      }),
    });
    if (!isAlive()) return;
    patch({
      status: "ready",
      title: res.title,
      description: res.description,
      spec: res.html,
      specVersion: el.specVersion + 1,
      libraryId: res.libraryId,
      prompt: instruction ? `${el.prompt}\n[edit] ${instruction}` : el.prompt,
    });
  } catch (err) {
    if (!isAlive()) return;
    patch({ status: "error", errorMessage: err instanceof Error ? err.message : String(err) });
  }
}
