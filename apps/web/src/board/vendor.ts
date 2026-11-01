// ── Host libraries for AI-generated widgets (Slice 5b refinement) ────────────
// Generated widgets run in a sandboxed srcdoc iframe with no network, so
// anything beyond raw DOM/canvas must come from the host. These strings are
// the SAME libraries the web app itself uses (mathjs 15, three.js r186),
// prebuilt into browser-global bundles and imported at build time by Vite —
// they land in the app bundle as static assets, no network at runtime.
//
//   mathjs.umd.js  → UMD build of mathjs → window.math
//   three.iife.js  → esbuild IIFE bundle of three.module.js → THREE
//
// The generation prompt (apps/api/src/gemini.ts) tells the model these exist;
// the editor injects both <script> tags before the widget's own markup when
// the model references them. Injecting ALWAYS would double the bytes of every
// widget; the cheap sniff keeps light widgets light.

import mathjsBundle from "./mathjs.umd.js?raw";
import threeBundle from "./three.iife.js?raw";

/** Detects whether a generated spec references the host libraries (a word
 * boundary + `.` guards against a stray "three" in prose — the model is
 * told to use these names for actual API calls). */
export function usesHostLibraries(html: string): { math: boolean; three: boolean } {
  return {
    math: /\bmath\s*\./.test(html) || /\bmathjs\b/.test(html),
    three: /\bTHREE\s*\./.test(html) || /\bthree\.js\b/i.test(html),
  };
}

/** <script> tags for the libraries a spec uses, in dependency order. */
export function hostLibraryScripts(html: string): string {
  const use = usesHostLibraries(html);
  let out = "";
  if (use.three) out += `<script>${threeBundle}<\/script>`;
  if (use.math) out += `<script>${mathjsBundle}<\/script>`;
  return out;
}
