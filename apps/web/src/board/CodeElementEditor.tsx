import { memo, useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap, drawSelection, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import {
  type CompletionContext,
  type CompletionResult,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap, search } from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { python } from "@codemirror/lang-python";
import { javascript, javascriptLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import type { CodeShape } from "@comata/elements";
import { codeDisplayName } from "@comata/elements";
import { api } from "../lib/api";
import type { CodeRunError, CodeRunResult, NotebookSettings } from "@comata/schema";

// ── Code element (Slice 4) ───────────────────────────────────────────────────
// There is no preview/edit split: the code element IS this DOM node, mounted
// inside the camera-transformed board container (same coordinate space as the
// Konva stage's world group). Position/size come from element geometry only —
// the camera transform handles pan/zoom live, and resizing the element
// reflows the layout in realtime (Figma auto-layout feel). Chrome (toolbar,
// tabs) stays at constant pixel size while the code area flexes.

const LANGUAGES: { id: string; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "java", label: "Java" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
];

// lang-javascript's built-in completions cover keywords/snippets + document
// identifiers only — no runtime globals (that's why `console.` never pops up).
// This source layers the standard globals on top.
const JS_GLOBALS = [
  "console", "window", "document", "Math", "JSON", "Object", "Array", "String",
  "Number", "Boolean", "Symbol", "BigInt", "Date", "RegExp", "Error", "TypeError",
  "RangeError", "SyntaxError", "Promise", "Map", "Set", "WeakMap", "WeakSet",
  "Proxy", "Reflect", "Function", "globalThis", "undefined", "NaN", "Infinity",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "structuredClone", "setTimeout", "setInterval",
  "clearTimeout", "clearInterval", "queueMicrotask", "alert", "fetch", "localStorage",
  "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame",
].map((name) => ({ label: name, type: "variable" }));

const JS_GLOBAL_COMPLETIONS = (ctx: CompletionContext): CompletionResult | null => {
  const before = ctx.matchBefore(/[\w$]+/);
  if (!before || (before.from === before.to && !ctx.explicit)) return null;
  return {
    from: before.from,
    options: JS_GLOBALS,
    validFor: /^[\w$]*$/,
  };
};

export const CODE_SCALE_STEPS = [0.8, 1, 1.25, 1.5];

type RunState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: CodeRunResult }
  | { phase: "error"; message: string; code: string; retryAfter?: number };

function languageExtension(language: string) {
  switch (language) {
    case "python":
      return python();
    case "javascript":
      return [javascript(), javascriptLanguage.data.of({ autocomplete: JS_GLOBAL_COMPLETIONS })];
    case "typescript":
      return [
        javascript({ typescript: true }),
        typescriptLanguage.data.of({ autocomplete: JS_GLOBAL_COMPLETIONS }),
      ];
    case "c":
    case "cpp":
      return cpp();
    case "java":
      return java();
    case "rust":
      return rust();
    case "go":
      return go();
    default:
      return [];
  }
}

/** Full editor toolkit: syntax highlighting, auto-indent on input, bracket
 * matching + auto-close, autocompletion, fold gutter, line numbers, search,
 * selection-match highlights. One Dark keeps the editor in sync with the
 * app's dark theme — swap the theme extension here when themes arrive. */
const editorToolkit = [
  oneDark,
  lineNumbers(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion({ activateOnTyping: true, maxRenderedOptions: 20 }),
  foldGutter(),
  lintGutter(),
  highlightSelectionMatches(),
  search({ top: true }),
  drawSelection(),
  highlightSpecialChars(),
  EditorView.lineWrapping,
];

export const CodeElementEditor = memo(function CodeElementEditor({
  el,
  notebookId,
  canWrite,
  interactive,
  dataElId,
  style,
  onChange,
  onWindowDragStart,
  focusRequest,
}: {
  el: CodeShape;
  notebookId: string;
  canWrite: boolean;
  /** False while a creation tool is active — the element stays visible but
   * never steals the pointer, so pen/shapes/arrows draw right over it. */
  interactive: boolean;
  /** Element id stamped on the DOM node — the board reads it to forward
   * right-clicks into the element context menu. */
  dataElId: string;
  /** World-space geometry (position/size/scale) from the board — computed
   * there so a live resize mirror can override the CRDT values mid-gesture. */
  style: React.CSSProperties;
  onChange: (patch: { filename?: string; language?: string; source?: string; scale?: number }) => void;
  /** OS-window move: called on a pointerdown on the toolbar background (never
   * on its controls) — the board drags the element by its title bar. */
  onWindowDragStart: (e: React.PointerEvent) => void;
  /** Edit-entry focus signal: a fresh object per request. {x,y} in screen
   * coords places the caret at that point (double-click entry); {} focuses
   * at the existing cursor position. Undefined when not editing. */
  focusRequest?: { x?: number; y?: number };
}) {
  const [stdin, setStdin] = useState("");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [tab, setTab] = useState<"input" | "output" | "error">("input");
  const [settings, setSettings] = useState<NotebookSettings | null>(null);
  const [rateCountdown, setRateCountdown] = useState(0);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sourceRef = useRef(el.source);
  sourceRef.current = el.source;
  const elRef = useRef(el);
  elRef.current = el;
  const langCompartment = useMemo(() => new Compartment(), []);

  /** Enter typing mode directly: focus the CodeMirror view and (when a screen
   * point is given) place the cursor exactly where the double-click landed —
   * no third click needed. Positions are clamped into the doc bounds. */
  const focusAtPoint = (screenX?: number, screenY?: number) => {
    const view = viewRef.current;
    if (!view) return;
    if (screenX !== undefined && screenY !== undefined) {
      const host = editorHostRef.current;
      const rect = host?.getBoundingClientRect();
      if (rect) {
        try {
          const pos = view.posAtCoords({ x: screenX, y: screenY });
          if (pos !== null && pos >= 0) view.dispatch({ selection: { anchor: pos } });
        } catch {
          // Outside the rendered content — keep whatever cursor position the
          // view already has; focus alone is enough.
        }
      }
    }
    view.focus();
  };

  /** Board-driven focus: the board hands a fresh object on every edit-mode
   * entry ({x,y} for double-click, {} for toolbar/context-menu entries) and
   * this effect turns it into focus + cursor placement. Writers only — a
   * viewer never gets a caret. */
  useEffect(() => {
    if (!focusRequest || !interactive || !canWrite) return;
    focusAtPoint(focusRequest.x, focusRequest.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, interactive, canWrite]);

  // ── CodeMirror lifecycle: one view, language reconfigured on change ────────
  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: sourceRef.current,
        extensions: [
          history(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          ...editorToolkit,
          indentUnit.of("  "),
          EditorView.editable.of(canWrite),
          EditorState.readOnly.of(!canWrite),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && canWrite) onChange({ source: u.state.doc.toString() });
          }),
          langCompartment.of(languageExtension(elRef.current?.language ?? "python")),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-create only when the element identity changes — source flows in via
    // remote sync below, never as an effect dep (would fight the user's typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el.id, canWrite]);

  // Language reconfiguration on the live view (state effect compartment).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompartment.reconfigure(languageExtension(el.language)),
    });
  }, [el.language, langCompartment]);

  // Remote edits (collaborators) flow in when the local view is untouched —
  // CodeMirror is the source of pixels while focused; Yjs syncs when idle.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (el.source !== current && document.activeElement !== view.contentDOM) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: el.source } });
    }
  }, [el.source]);

  // Notebook settings (viewer-run rule surfaces on the Run button).
  useEffect(() => {
    let cancelled = false;
    api<NotebookSettings>(`/v1/notebooks/${notebookId}/settings`)
      .then((s) => !cancelled && setSettings(s))
      .catch(() => !cancelled && setSettings({ allowViewerRuns: false }));
    return () => {
      cancelled = true;
    };
  }, [notebookId]);

  // Rate-limit countdown ticker.
  useEffect(() => {
    if (rateCountdown <= 0) return;
    const t = window.setInterval(() => setRateCountdown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(t);
  }, [rateCountdown]);

  const doRun = async () => {
    if (run.phase === "running" || rateCountdown > 0) return;
    setRun({ phase: "running" });
    setTab("output");
    try {
      const result = await api<CodeRunResult>(`/v1/runs?notebookId=${notebookId}`, {
        method: "POST",
        body: JSON.stringify({
          elementId: el.id,
          filename: codeDisplayName(el),
          language: el.language,
          code: sourceRef.current,
          stdin,
        }),
      });
      setRun({ phase: "done", result });
      setTab(result.stderr || result.exitCode ? "error" : "output");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let code = "RUN_FAILED";
      let retryAfter: number | undefined;
      const m = /API (\d+): (.*)/.exec(message);
      if (m) {
        try {
          const body = JSON.parse(m[2] as string) as CodeRunError;
          code = body.error;
          retryAfter = body.retryAfter;
        } catch {
          code = m[1] === "429" ? "RATE_LIMITED" : m[1] === "503" ? "RUNNER_OFFLINE" : code;
        }
      }
      setRun({ phase: "error", message, code, retryAfter });
      setTab("error");
      if (retryAfter) setRateCountdown(retryAfter);
    }
  };

  // Scale stepper: element-wide text zoom ([- +] control).
  const stepScale = (dir: 1 | -1) => {
    const idx = CODE_SCALE_STEPS.indexOf(el.scale);
    const next = CODE_SCALE_STEPS[Math.min(CODE_SCALE_STEPS.length - 1, Math.max(0, (idx < 0 ? 1 : idx) + dir))];
    if (next !== undefined && next !== el.scale) onChange({ scale: next });
  };

  const viewerBlocked = !canWrite && settings !== null && !settings.allowViewerRuns;
  const runDisabled =
    run.phase === "running" || rateCountdown > 0 || viewerBlocked || !settings;

  const runLabel = run.phase === "running"
    ? "Running…"
    : rateCountdown > 0
      ? `${rateCountdown}s`
      : viewerBlocked
        ? "Runs off"
        : "▶ RUN";

  return (
    <div
      className={`code-editor ${interactive ? "" : "code-editor-passive"}`}
      data-el-id={dataElId}
      style={style}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="code-toolbar"
        onPointerDown={(e) => {
          // Controls handle their own pointer events; a press on the bar
          // background (not a button/input) starts an OS-window drag.
          if ((e.target as HTMLElement).closest("input, select, button")) return;
          onWindowDragStart(e);
        }}
      >
        <input
          className="code-filename"
          value={el.filename}
          disabled={!canWrite}
          title="File name"
          onChange={(e) => canWrite && onChange({ filename: e.target.value })}
          spellCheck={false}
        />
        <select
          className="code-language"
          value={el.language}
          disabled={!canWrite}
          title="Language"
          onChange={(e) => canWrite && onChange({ language: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="code-scale">
          <button title="Smaller text" onClick={() => stepScale(-1)} disabled={el.scale <= (CODE_SCALE_STEPS[0] ?? 1)}>
            −
          </button>
          <button title="Larger text" onClick={() => stepScale(1)} disabled={el.scale >= (CODE_SCALE_STEPS[CODE_SCALE_STEPS.length - 1] ?? 1)}>
            +
          </button>
        </span>
        <button
          className="code-run"
          disabled={runDisabled}
          title={viewerBlocked ? "The notebook owner disabled runs for viewers" : "Run (10s / 512MB caps)"}
          onClick={doRun}
        >
          {runLabel}
        </button>
      </div>      <div ref={editorHostRef} className="code-mirror-host" />
      <div className="code-tabs">
        {(["input", "output", "error"] as const).map((t) => (
          <button
            key={t}
            className={`code-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "input" ? "Input" : t === "output" ? "Output" : "Error"}
          </button>
        ))}
      </div>
      <div className="code-pane">
        {tab === "input" && (
          <textarea
            className="code-stdin"
            placeholder="Program input (stdin) — yours alone, never shared"
            value={stdin}
            disabled={!settings}
            onChange={(e) => setStdin(e.target.value)}
          />
        )}
        {tab === "output" && (
          <pre className="code-stdout">
            {run.phase === "done" ? run.result.stdout : run.phase === "running" ? "Running…" : "—"}
          </pre>
        )}
        {tab === "error" && (
          <pre className="code-stderr">
            {run.phase === "done"
              ? run.result.stderr || (run.result.exitCode ? `exit code ${run.result.exitCode}` : "")
              : run.phase === "error"
                ? `${run.message}`
                : run.phase === "running"
                  ? ""
                  : "—"}
          </pre>
        )}
      </div>
    </div>
  );
});
