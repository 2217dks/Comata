import {
  AI_GEN_TIMEOUT_MS,
  AI_PROMPT_MAX_CHARS,
  AI_SPEC_MAX_BYTES,
  type GenerateResult,
} from "@comata/schema";

// ── Gemini client (Slice 5b, ADR-0004) ──────────────────────────────────────
// Plain REST fetch — no SDK dep. One cheap model, one shot, JSON response.
// The key lives server-side only (GEMINI_API_KEY in .env); BYOK is deferred.

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

/** Cheap, fast, solid one-shot HTML generation. */
const MODEL = "gemini-3.5-flash-lite";

/**
 * The output contract (docs/custom-elements.md §1): a single self-contained
 * HTML file — inline CSS+JS, no network, responsive, dark-theme friendly,
 * reports runtime errors via postMessage. Server-side constant by design.
 */
export const GENERATION_SYSTEM_PROMPT = `You generate small interactive teaching widgets for a collaborative whiteboard. The user describes a simulation, visualizer, or mini-app in natural language; you return ONE complete, self-contained HTML document that implements it.

Hard requirements:
- Output ONLY the HTML document, nothing else. No markdown fences, no explanation before or after.
- Everything inline: CSS in a <style> tag, JS in a <script> tag. No external requests of any kind — no CDN scripts, no fonts, no images, no fetch/XHR/WebSocket. Pure canvas/SVG/DOM only.
- Responsive: the widget must fill its container and re-layout when the host resizes it. Use viewport-relative or container-relative sizing, never fixed pixel dimensions for the root.
- Dark theme: assume a dark background (#12141a-ish). Choose readable contrasting colors.
- Keep it small: aim for well under 300 lines. A crisp, delightful micro-simulation beats a sprawling app.
- The widget must be immediately interactive and self-demonstrating: sensible defaults, no setup steps, no buttons that lead nowhere.
- Robustness: wrap init in try/catch. On any runtime error, call parent.postMessage({ type: 'error', message: String(e) }, '*') so the host can show a readable error card.
- When the widget is ready (DOM laid out, first frame drawn), call parent.postMessage({ type: 'ready' }, '*').
- No alert/confirm/prompt. No localStorage or cookies. No iframes inside.

Host-provided libraries (already injected before your script runs — do NOT redeclare or recreate them, and do not load your own copies):
- \`math\` — the full mathjs instance (parse, evaluate, derivative, simplify, matrix, complex, unit, ...). Use it for ANY math beyond trivial arithmetic: parsing user expressions, symbolic differentiation, statistics, unit conversion. Example: math.parse('x^2 + a').evaluate({x: 2, a: 3}); math.derivative('sin(x)', 'x').
- \`THREE\` — the full three.js r186 namespace (WebGLRenderer, Scene, PerspectiveCamera, Mesh, BufferGeometry, ...). Use it for ANY 3D or advanced visualization instead of hand-rolling projections on 2D canvas: orbiting cameras, meshes, lights, level-set-style surfaces. Create the renderer with canvas: document.querySelector('canvas') and size it to the container; do not call setSize with hardcoded pixels.

Prefer these over reimplementing: a pendulum with symbolic derivatives, a 3D vector-field or surface plot, a statistics demo, a unit-conversion tool — all become small, robust widgets. If the widget is purely 2D DOM/canvas and needs no math library, just don't reference them (they cost nothing).

Also output metadata as HTML comments on the first two lines:
<!-- title: <3-6 word title> -->
<!-- description: <one sentence describing what this widget shows> -->
These must be the very first lines, before <!DOCTYPE html>.`;

export type GeminiOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
};

type GeminiPart = { text?: string };
type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  error?: { message?: string };
};

export class GenerationError extends Error {
  kind: "timeout" | "api" | "empty" | "too_large";
  constructor(kind: "timeout" | "api" | "empty" | "too_large", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Extract the HTML document out of the model output (strip fences, prose). */
function extractHtml(text: string): string {
  let t = text.trim();
  const fence = /```(?:html)?\s*([\s\S]*?)```/.exec(t);
  if (fence?.[1]) t = fence[1].trim();
  const doctype = t.search(/<!DOCTYPE html>/i);
  if (doctype > 0) t = t.slice(doctype);
  else if (doctype === -1 && !/<html[\s>]/i.test(t)) {
    // No doctype and no <html> — the model returned prose, not a document.
    throw new GenerationError("empty", "model returned no HTML document");
  }
  return t.trim();
}

function extractMeta(html: string): { title: string; description: string } {
  const title = /<!--\s*title:\s*(.+?)\s*-->/.exec(html)?.[1] ?? "";
  const description = /<!--\s*description:\s*(.+?)\s*-->/.exec(html)?.[1] ?? "";
  return { title: title.slice(0, 80), description: description.slice(0, 300) };
}

/** One generation call: prompt (+ optional base HTML + edit instruction). */
export async function generateWidget(
  opts: GeminiOptions,
  prompt: string,
  edit?: { baseHtml: string; instruction: string },
): Promise<GenerateResult> {
  const userText = edit
    ? `${prompt}\n\nExisting widget HTML:\n\`\`\`html\n${edit.baseHtml}\n\`\`\`\n\nApply ONLY the requested change (keep everything else as-is) and return the COMPLETE updated document:\n${edit.instruction}`
    : prompt;

  const model = opts.model ?? MODEL;
  const base = opts.baseUrl ?? GEMINI_URL;
  let res: Response;
  try {
    res = await fetch(`${base}/${model}:generateContent?key=${opts.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: GENERATION_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 16384,
        },
      }),
      signal: AbortSignal.timeout(AI_GEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GenerationError(
      err instanceof Error && err.name === "TimeoutError" ? "timeout" : "api",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as GeminiResponse | null;
    throw new GenerationError("api", body?.error?.message ?? `gemini ${res.status}`);
  }

  const body = (await res.json()) as GeminiResponse;
  const text =
    body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw new GenerationError("empty", "gemini returned an empty response");
  }

  const html = extractHtml(text);
  if (html.length > AI_SPEC_MAX_BYTES) {
    throw new GenerationError("too_large", `generated HTML exceeds ${AI_SPEC_MAX_BYTES} bytes`);
  }
  const meta = extractMeta(html);
  return {
    title: meta.title || "Custom element",
    description: meta.description,
    html,
  };
}
