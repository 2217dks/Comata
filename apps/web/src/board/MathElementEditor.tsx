import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { parse, type MathNodeCommon } from "mathjs";
import type { MathExpressionRow, MathParamDef, MathShape } from "@comata/elements";
import { MATH_CURVE_COLORS } from "@comata/elements";

// ── Math element ("mathblock", Slice 5) ──────────────────────────────────────
// Same DOM-overlay contract as CodeElementEditor: this component IS the
// element's pixels, mounted inside the camera-transformed board container.
// Shared state (expressions, params, mode) flows through onChange patches;
// view state (pan/zoom/rotate) and live slider values are per-user local and
// never enter the doc (ADR-0003 pattern, same as stdin).
//
// Equation model (Desmos-faithful — no classification, no symbolic solving):
//   Every expression is a RELATION f(vars) = lhs − rhs.
//   2D — bare `expr` means y = expr; `y=f(x)` / `x=g(y)` (LHS a bare axis the
//        RHS doesn't mention, RHS free of z) render as smooth analytic curves
//        sampled over the correct free axis — x=y draws just like y=x. Every
//        other relation is implicit: marching squares over f(x,y)=0, so
//        x²+y²=4 draws the full circle and x=y² draws both branches.
//   3D — every relation is a level set rendered by surface nets over the
//        fixed domain: y=x and z=x are distinct perpendicular planes,
//        x+y+z=0 is a plane, z²=4−x²−y² gets its dome. `y = x` in 3D is the
//        vertical plane y−x=0 (math-y = depth); `z = x` the tilted plane
//        height−x = 0.
// World convention (math, z-up): math x → world X, math y → world Z (depth),
// math z → world Y (height). Axis sprites are labeled accordingly.

const EPSILON = 1e-6;
const AXES = new Set(["x", "y", "z"]);
const MATH_CONSTS = new Set(["pi", "e", "tau", "phi", "i"]);

type Ev = (scope: Record<string, number>) => number;

type CompiledExpr = {
  row: MathExpressionRow;
  error: string | null;
  /** Non-axis free variables — slider candidates (a in y=a·sin(x)). */
  params: string[];
  /** Relation references z (renders nothing in 2D mode). */
  needs3d: boolean;
  /** Analytic 2D form: LHS is a bare axis symbol absent from the RHS and the
   * RHS references exactly one other 2D axis. `free` = sampled axis. */
  explicit: { out: "x" | "y"; free: "x" | "y"; f: Ev } | null;
  /** Level set f(x,y[,z]) = lhs − rhs — used by 3D for everything and by 2D
   * for implicit curves and constants (y=3). */
  implicit: Ev | null;
};

/** Collect axis / free-variable symbols in a parsed node. Uses traverse —
 * mathjs 15's forEach only walks one level deep (misses sin(x)'s argument). */
function scanSymbols(node: MathNodeCommon): { axes: Set<string>; params: Set<string> } {
  const axes = new Set<string>();
  const params = new Set<string>();
  node.traverse(function walk(n) {
    const s = n as unknown as { isSymbolNode?: boolean; name?: string };
    if (s.isSymbolNode && s.name && !(s.name in Math)) {
      if (AXES.has(s.name)) axes.add(s.name);
      else if (!MATH_CONSTS.has(s.name)) params.add(s.name);
    }
  });
  return { axes, params };
}

/** Parse one sidebar row into its relation. */
function compileRelation(row: MathExpressionRow, mode: "2d" | "3d"): CompiledExpr {
  const fail = (error: string): CompiledExpr => ({
    row, error, params: [], needs3d: false, explicit: null, implicit: null,
  });
  const text = row.text.trim();
  if (!text) return { row, error: null, params: [], needs3d: false, explicit: null, implicit: null };
  try {
    const eq = text.split("=");
    let lhsN: MathNodeCommon;
    let rhsN: MathNodeCommon;
    if (eq.length === 1) {
      // Bare expression: 2D → y = expr · 3D → z = expr (Desmos semantics).
      lhsN = parse(mode === "2d" ? "y" : "z");
      rhsN = parse(text);
    } else if (eq.length === 2) {
      lhsN = parse(eq[0] ?? "");
      rhsN = parse(eq[1] ?? "");
    } else {
      return fail("Too many '=' signs");
    }

    // Function definitions f(x) = … / f(x,y) = … map to y = / z =.
    const lhsFa = lhsN as unknown as {
      type?: string; args?: unknown[]; expr?: MathNodeCommon;
    };
    if (lhsFa.type === "FunctionAssignmentNode") {
      const nArgs = lhsFa.args?.length ?? 0;
      if (nArgs === 1 || nArgs === 2) {
        lhsN = parse(nArgs === 1 ? "y" : "z");
        rhsN = lhsFa.expr ?? rhsN;
      } else {
        return fail("Only f(x) and f(x,y) are supported");
      }
    }

    const lhsSym = lhsN as unknown as { type?: string; name?: string };
    const lhsIsAxis =
      lhsSym.type === "SymbolNode" && lhsSym.name !== undefined && AXES.has(lhsSym.name);
    const rhsScan = scanSymbols(rhsN);
    const lhsScan = scanSymbols(lhsN);
    const params = [...new Set([...lhsScan.params, ...rhsScan.params])];

    // Level set: lhs − rhs.
    const lEv = lhsN.compile().evaluate;
    const rEv = rhsN.compile().evaluate;
    const implicit: Ev = (s) => (lEv(s) as number) - (rEv(s) as number);

    const outName = lhsSym.name;
    const needs3d = lhsScan.axes.has("z") || rhsScan.axes.has("z");

    // Analytic 2D curve: y = f(x) / x = g(y) — LHS a bare axis the RHS never
    // mentions, RHS references exactly one other 2D axis and no z. This is
    // symmetric, so x = y compiles exactly like y = x (out/free swap).
    let explicit: CompiledExpr["explicit"] = null;
    if (lhsIsAxis && outName && outName !== "z" && !rhsScan.axes.has(outName) && !rhsScan.axes.has("z")) {
      const free = [...rhsScan.axes].filter((a) => a !== outName);
      if (free.length === 1) {
        const fn = rhsN.compile();
        explicit = {
          out: outName as "x" | "y",
          free: free[0] as "x" | "y",
          f: (s) => fn.evaluate(s) as number,
        };
      }
    }

    return { row, error: null, params, needs3d, explicit, implicit };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Invalid expression");
  }
}

// ── Marching squares (2D implicit curves) ────────────────────────────────────
// Returns polyline segments in world coords for f=0 over the view rect.
function marchingSquares(
  f: Ev,
  scope: Record<string, number>,
  xMin: number, xMax: number, yMin: number, yMax: number,
  res: number,
): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];
  const dx = (xMax - xMin) / res;
  const dy = (yMax - yMin) / res;
  const s = { ...scope };
  const val = new Float64Array((res + 1) * (res + 1));
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      s.x = xMin + i * dx;
      s.y = yMin + j * dy;
      let v: number;
      try {
        v = f(s);
      } catch {
        v = NaN;
      }
      val[j * (res + 1) + i] = v;
    }
  }
  const lerp = (a: number, b: number) => {
    const t = Math.abs(a) / (Math.abs(a) + Math.abs(b) + 1e-12);
    return t;
  };
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const v00 = val[j * (res + 1) + i]!;
      const v10 = val[j * (res + 1) + i + 1]!;
      const v01 = val[(j + 1) * (res + 1) + i]!;
      const v11 = val[(j + 1) * (res + 1) + i + 1]!;
      if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) continue;
      const c = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const x0 = xMin + i * dx;
      const y0 = yMin + j * dy;
      // Edge crossing points (bottom, right, top, left).
      const bottom: [number, number] = [x0 + lerp(v00, v10) * dx, y0];
      const right: [number, number] = [x0 + dx, y0 + lerp(v10, v11) * dy];
      const top: [number, number] = [x0 + lerp(v01, v11) * dx, y0 + dy];
      const left: [number, number] = [x0, y0 + lerp(v00, v01) * dy];
      const push = (a: [number, number], b: [number, number]) => segs.push([a[0], a[1], b[0], b[1]]);
      switch (c) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(right, top); break;
        case 5: push(left, top); push(bottom, right); break;
        case 6: case 9: push(bottom, top); break;
        case 7: case 8: push(left, top); break;
        case 10: push(left, bottom); push(right, top); break;
      }
    }
  }
  return segs;
}

// ── Surface nets (3D level sets) ─────────────────────────────────────────────
// Dual contouring lite: one vertex per sign-changing cell (mean of edge
// crossings), quads bridging cells across sign-changing axis edges. Grid runs
// over math (x, y, z) in [-DOMAIN, DOMAIN]³; vertices are mapped to world
// (X=x, Y=z, Z=−y — a proper rotation) by the caller. Quad winding is
// oriented along the gradient (∇f) so DoubleSide lighting stays consistent.
const SURFACE_DOMAIN = 5;
/** Full-resolution grid (typing/mode changes): 64³ cells — dense enough that
 * fine surface detail survives. ≈ 262k evals per relation, still fast
 * (<30ms for typical expressions) since it only runs on a typing pause. */
const SURFACE_RES = 64;
/** Slider-drag grid: rebuilt once per animation frame during a drag — light
 * enough to track the pointer in real time. */
const SURFACE_RES_SLIDER = 40;

function surfaceNets(
  f: Ev,
  scope: Record<string, number>,
  res: number = SURFACE_RES,
): { positions: number[]; indices: number[]; normals: number[] } {
  const R = res;
  const D = SURFACE_DOMAIN;
  const N = R + 1;
  const step = (2 * D) / R;
  const values = new Float64Array(N * N * N);
  const s = { ...scope };
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        s.x = -D + i * step;
        s.y = -D + j * step;
        s.z = -D + k * step;
        let v: number;
        try {
          v = f(s);
        } catch {
          v = NaN;
        }
        if (!Number.isFinite(v)) v = 1; // NaN → outside
        values[k * N * N + j * N + i] = v;
      }
    }
  }
  const at = (i: number, j: number, k: number) => values[k * N * N + j * N + i];
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const cellVertex = new Int32Array(R * R * R).fill(-1);

  // Level-set normal = the gradient of f. Winding-based normals are wrong
  // here: the quads' winding is inconsistent, so computeVertexNormals()
  // shades some faces inward. ∇f is the true surface normal — evaluated in
  // WORLD(math) space by central differences of f itself around the vertex.
  const gradW = (x: number, y: number, z: number) => {
    const s = { ...scope };
    const ev = (px: number, py: number, pz: number) => {
      s.x = px;
      s.y = py;
      s.z = pz;
      try {
        const v = f(s) as number;
        return Number.isFinite(v) ? v : NaN;
      } catch {
        return NaN;
      }
    };
    const h = step * 0.5;
    const nx = (ev(x + h, y, z) - ev(x - h, y, z)) / (2 * h);
    const ny = (ev(x, y + h, z) - ev(x, y - h, z)) / (2 * h);
    const nz = (ev(x, y, z + h) - ev(x, y, z - h)) / (2 * h);
    return [nx, ny, nz] as const;
  };

  // One vertex per sign-changing cell.
  for (let k = 0; k < R; k++) {
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const v000 = at(i, j, k) ?? 1;
        let signChanges = 0;
        for (let dk = 0; dk <= 1; dk++)
          for (let dj = 0; dj <= 1; dj++)
            for (let di = 0; di <= 1; di++)
              if ((at(i + di, j + dj, k + dk) ?? 1) > 0 !== v000 > 0) signChanges++;
        if (signChanges === 0) continue;
        // Mean of the zero crossings on the 12 cube edges.
        let px = 0;
        let py = 0;
        let pz = 0;
        let count = 0;
        const edge = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
          const a = at(x1, y1, z1) ?? 1;
          const b = at(x2, y2, z2) ?? 1;
          if (a > 0 === b > 0) return;
          const t = a / (a - b);
          px += -D + (x1 + t * (x2 - x1)) * step;
          py += -D + (y1 + t * (y2 - y1)) * step;
          pz += -D + (z1 + t * (z2 - z1)) * step;
          count++;
        };
        edge(i, j, k, i + 1, j, k); edge(i, j, k, i, j + 1, k); edge(i, j, k, i, j, k + 1);
        edge(i + 1, j, k, i + 1, j + 1, k); edge(i + 1, j, k, i + 1, j, k + 1);
        edge(i, j + 1, k, i + 1, j + 1, k); edge(i, j + 1, k, i, j + 1, k + 1);
        edge(i, j, k + 1, i + 1, j, k + 1); edge(i, j, k + 1, i, j + 1, k + 1);
        edge(i + 1, j + 1, k, i + 1, j + 1, k + 1);
        edge(i + 1, j, k + 1, i + 1, j + 1, k + 1);
        edge(i, j + 1, k + 1, i + 1, j + 1, k + 1);
        if (count === 0) continue;
        cellVertex[k * R * R + j * R + i] = positions.length / 3;
        const vx = px / count;
        const vy = py / count;
        const vz = pz / count;
        positions.push(vx, vy, vz);
        // ∇f at the vertex in math space — the true level-set normal.
        let [nx, ny, nz] = gradW(vx, vy, vz);
        const len = Math.hypot(
          Number.isFinite(nx) ? nx : 0,
          Number.isFinite(ny) ? ny : 0,
          Number.isFinite(nz) ? nz : 0,
        );
        if (len > 1e-12 && Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz)) {
          normals.push(nx / len, ny / len, nz / len);
        } else {
          normals.push(0, 0, 1);
        }
      }
    }
  }

  // Quads across sign-changing axis edges (the 4 cells sharing the edge).
  // Winding is oriented by the GRADIENT: the quad's geometric normal (from
  // its actual vertex positions, via the diagonals) is aligned against ∇f —
  // the surface faces the f < 0 (interior) side consistently everywhere, so
  // DoubleSide never has to "fix" back faces and lighting stays smooth.
  const quad2 = (cells: [number, number, number][]) => {
    const ids = cells.map(([i, j, k]) =>
      i >= 0 && j >= 0 && k >= 0 && i < R && j < R && k < R ? cellVertex[k * R * R + j * R + i] : -1,
    );
    if (ids.some((id) => (id ?? -1) < 0)) return;
    const P = (n: number) => n * 3;
    // Quad as v0 v1 v2 v3 (ring order); diagonals give its geometric normal.
    const v0 = ids[0]!;
    const v1 = ids[1]!;
    const v2 = ids[2]!;
    const v3 = ids[3]!;
    const d1x = positions[P(v2)]! - positions[P(v0)]!;
    const d1y = positions[P(v2) + 1]! - positions[P(v0) + 1]!;
    const d1z = positions[P(v2) + 2]! - positions[P(v0) + 2]!;
    const d2x = positions[P(v3)]! - positions[P(v1)]!;
    const d2y = positions[P(v3) + 1]! - positions[P(v1) + 1]!;
    const d2z = positions[P(v3) + 2]! - positions[P(v1) + 2]!;
    let gx = d1y * d2z - d1z * d2y;
    let gy = d1z * d2x - d1x * d2z;
    let gz = d1x * d2y - d1y * d2x;
    const glen = Math.hypot(gx, gy, gz);
    if (glen < 1e-12) {
      // Degenerate quad — keep default winding, nothing to orient.
      indices.push(v0, v1, v2, v0, v2, v3);
      return;
    }
    gx /= glen;
    gy /= glen;
    gz /= glen;
    // ∇f at the quad center decides which side is "outside".
    const cx = (positions[P(v0)]! + positions[P(v2)]!) / 2;
    const cy = (positions[P(v0) + 1]! + positions[P(v2) + 1]!) / 2;
    const cz = (positions[P(v0) + 2]! + positions[P(v2) + 2]!) / 2;
    const [nx, ny, nz] = gradW(cx, cy, cz);
    const dot = gx * nx + gy * ny + gz * nz;
    if (Number.isFinite(dot) && Math.abs(dot) > 1e-12 && dot < 0) {
      // Geometric normal opposes ∇f → flip so triangles face −∇f consistently.
      indices.push(v0, v2, v1, v0, v3, v2);
    } else {
      indices.push(v0, v1, v2, v0, v2, v3);
    }
  };
  for (let k = 0; k < R; k++) {
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const v0 = at(i, j, k) ?? 1;
        // Edge along x from (i,j,k): cells (i, j, k), (i, j-1, k), (i, j-1, k-1), (i, j, k-1)
        if (i < R && (v0 > 0 !== (at(i + 1, j, k) ?? 1) > 0)) {
          quad2([[i, j, k], [i, j - 1, k], [i, j - 1, k - 1], [i, j, k - 1]]);
        }
        // Edge along y
        if (j < R && (v0 > 0 !== (at(i, j + 1, k) ?? 1) > 0)) {
          quad2([[i, j, k], [i - 1, j, k], [i - 1, j, k - 1], [i, j, k - 1]]);
        }
        // Edge along z
        if (k < R && (v0 > 0 !== (at(i, j, k + 1) ?? 1) > 0)) {
          quad2([[i, j, k], [i - 1, j, k], [i - 1, j - 1, k], [i, j - 1, k]]);
        }
      }
    }
  }
  return { positions, indices, normals };
}

/** Callback-ref measure: re-observes whenever the measured node remounts
 * (the 2D↔3D toggle swaps the plot element — an observe-once ref would
 * freeze on the detached node and blank the plot). */
function useMeasure<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(node);
    setSize({ w: node.clientWidth, h: node.clientHeight });
    return () => ro.disconnect();
  }, [node]);
  return [setNode, size] as const;
}

export type MathPatch = {
  mode?: "2d" | "3d";
  expressions?: MathExpressionRow[];
  params?: MathParamDef[];
};

export const MathElementEditor = memo(function MathElementEditor({
  el,
  canWrite,
  interactive,
  dataElId,
  style,
  onChange,
  onWindowDragStart,
}: {
  el: MathShape;
  canWrite: boolean;
  interactive: boolean;
  /** Element id stamped on the DOM node — the board reads it to forward
   * right-clicks into the element context menu. */
  dataElId: string;
  style: React.CSSProperties;
  onChange: (patch: MathPatch) => void;
  /** OS-window move: called on a pointerdown on the toolbar background (never
   * on its controls) — the board drags the element by its title bar. */
  onWindowDragStart: (e: React.PointerEvent) => void;
}) {
  // ── Per-user local state (never enters the doc) ───────────────────────────
  /** Live slider values — per-user; defaults live in the element payload. */
  const [liveValues, setLiveValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(el.params.map((p) => [p.name, p.defaultValue])),
  );
  useEffect(() => {
    setLiveValues((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const p of el.params) {
        if (!(p.name in next)) {
          next[p.name] = p.defaultValue;
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [el.params]);

  // ── 2D view state (per-user, ADR-0003) ────────────────────────────────────
  const [view2d, setView2d] = useState({ cx: 0, cy: 0, spanX: 20 });
  // ── 3D view state (per-user) ──────────────────────────────────────────────
  const [orbit, setOrbit] = useState({ theta: 0.7, phi: 1.05, dist: 14 });

  const [editingExprId, setEditingExprId] = useState<string | null>(null);

  const mode = el.mode;

  // ── Compilation (memoized: only recomputes when expressions/mode change) ──
  const compiled = useMemo(
    () => el.expressions.map((row) => compileRelation(row, mode)),
    [el.expressions, mode],
  );

  // Slider offers: union of free variables across rows not already params.
  const discovered = useMemo(() => {
    const names = new Set<string>();
    for (const c of compiled) for (const p of c.params) names.add(p);
    for (const p of el.params) names.delete(p.name);
    return [...names];
  }, [compiled, el.params]);

  // Stale-slider pruning: a param whose variable no longer appears in any
  // expression is removed from the payload (Desmos removes the slider with
  // its variable). Writers only, no-op when nothing is stale.
  useEffect(() => {
    if (!canWrite || el.params.length === 0) return;
    const used = new Set<string>();
    for (const c of compiled) for (const p of c.params) used.add(p);
    const stale = el.params.filter((p) => !used.has(p.name));
    if (stale.length === 0) return;
    onChange({ params: el.params.filter((p) => used.has(p.name)) });
    setLiveValues((cur) => {
      const next = { ...cur };
      for (const p of stale) delete next[p.name];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled, el.params, canWrite]);

  const scope = useMemo(
    () => Object.fromEntries(el.params.map((p) => [p.name, liveValues[p.name] ?? p.defaultValue])),
    [el.params, liveValues],
  );
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  /** What moved the scope last — slider drags rebuild the 3D mesh instantly
   * at a lighter grid; expression edits rebuild after the typing pause. */
  const lastScopeChangeRef = useRef<"slider" | "doc">("doc");

  // ── Sidebar mutations (shared via Yjs patches) ────────────────────────────
  const patchExpressions = (rows: MathExpressionRow[]) => onChange({ expressions: rows });

  // ── Debounced typing (250ms): the input stays the instant source of pixels
  // (local override state), while the shared patch — and everything it drags
  // behind it (Yjs write → projection → Board render → reparse → redraw —
  // waits for a 250ms pause. Collab echo, blur and Enter flush pending text.
  const [textOverride, setTextOverride] = useState<Record<string, string>>({});
  const textOverrideRef = useRef(textOverride);
  textOverrideRef.current = textOverride;
  const elRef = useRef(el);
  elRef.current = el;
  const typingTimersRef = useRef<Map<string, number>>(new Map());

  const flushText = (rowId: string) => {
    const timer = typingTimersRef.current.get(rowId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      typingTimersRef.current.delete(rowId);
    }
    const pending = textOverrideRef.current[rowId];
    if (pending === undefined) return;
    setTextOverride((cur) => {
      if (!(rowId in cur)) return cur;
      const next = { ...cur };
      delete next[rowId];
      return next;
    });
    const row = elRef.current.expressions.find((r) => r.id === rowId);
    if (row && row.text !== pending) {
      patchExpressions(elRef.current.expressions.map((r) => (r.id === rowId ? { ...r, text: pending } : r)));
    }
  };

  const updateExpressionText = (rowId: string, text: string) => {
    setTextOverride((cur) => ({ ...cur, [rowId]: text }));
    const timer = typingTimersRef.current.get(rowId);
    if (timer !== undefined) window.clearTimeout(timer);
    typingTimersRef.current.set(rowId, window.setTimeout(() => flushText(rowId), 250));
  };

  // Flush pending typing before the element unmounts (mode switch, deletion).
  useEffect(() => {
    const timers = typingTimersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
      // Flush synchronously on teardown — elRef still holds the element.
      const pending = textOverrideRef.current;
      const cur = elRef.current;
      const dirty = Object.keys(pending);
      if (dirty.length > 0 && cur) {
        onChange({
          expressions: cur.expressions.map((r) =>
            r.id in pending ? { ...r, text: pending[r.id] ?? r.text } : r,
          ),
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When expressions change, drop only the overrides that have already
  // landed (override === row.text — our flush echoed back). Overrides still
  // mid-typing survive: an unrelated row's flush (or a remote edit) must
  // never revert text the user is actively typing in another row.
  useEffect(() => {
    setTextOverride((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const r of el.expressions) {
        if (r.id in next && next[r.id] === r.text) {
          delete next[r.id];
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [el.expressions]);

  const addExpression = () => {
    if (!canWrite) return;
    const idx = el.expressions.length % MATH_CURVE_COLORS.length;
    patchExpressions([
      ...el.expressions,
      {
        id: `${el.id}-e${Date.now().toString(36)}`,
        text: "",
        color: MATH_CURVE_COLORS[idx] ?? MATH_CURVE_COLORS[0],
        visible: true,
      },
    ]);
    requestAnimationFrame(() => setEditingExprId("new"));
  };

  const removeExpression = (rowId: string) => {
    if (!canWrite) return;
    patchExpressions(el.expressions.filter((r) => r.id !== rowId));
  };

  const updateExpression = (rowId: string, patch: Partial<MathExpressionRow>) => {
    if (!canWrite) return;
    patchExpressions(el.expressions.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  };

  const addParam = (name: string) => {
    if (!canWrite) return;
    onChange({ params: [...el.params, { name, min: -10, max: 10, step: 0.1, defaultValue: 1 }] });
    setLiveValues((v) => ({ ...v, [name]: 1 }));
  };

  const updateParam = (name: string, patch: Partial<MathParamDef>) => {
    if (!canWrite) return;
    onChange({ params: el.params.map((p) => (p.name === name ? { ...p, ...patch } : p)) });
  };

  const resetParam = (name: string) => {
    const def = el.params.find((p) => p.name === name);
    if (def) setLiveValues((v) => ({ ...v, [name]: def.defaultValue }));
  };

  // ── 2D canvas renderer ────────────────────────────────────────────────────
  const [measurePlot, plotSize] = useMeasure<HTMLCanvasElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode !== "2d" || !canvas || plotSize.w < 2 || plotSize.h < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(plotSize.w * dpr) || canvas.height !== Math.floor(plotSize.h * dpr)) {
      canvas.width = Math.floor(plotSize.w * dpr);
      canvas.height = Math.floor(plotSize.h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { cx, cy, spanX } = view2d;
    const W = plotSize.w;
    const H = plotSize.h;
    const spanY = (spanX * H) / W;
    const xMin = cx - spanX / 2;
    const xMax = cx + spanX / 2;
    const yMin = cy - spanY / 2;
    const yMax = cy + spanY / 2;
    const toPx = (x: number, y: number) => ({
      px: ((x - xMin) / (xMax - xMin)) * W,
      py: H - ((y - yMin) / (yMax - yMin)) * H,
    });

    // Nice axis steps (1-2-5 progression).
    const rawStep = spanX / 10;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.lineWidth = 1;

    const minor = step / 5;
    ctx.strokeStyle = "#f0f2f7";
    ctx.beginPath();
    for (let x = Math.floor(xMin / minor) * minor; x <= xMax; x += minor) {
      const { px } = toPx(x, 0);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
    }
    for (let y = Math.floor(yMin / minor) * minor; y <= yMax; y += minor) {
      const { py } = toPx(0, y);
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
    }
    ctx.stroke();

    ctx.strokeStyle = "#e3e7f0";
    ctx.beginPath();
    for (let x = Math.floor(xMin / step) * step; x <= xMax; x += step) {
      const { px } = toPx(x, 0);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
    }
    for (let y = Math.floor(yMin / step) * step; y <= yMax; y += step) {
      const { py } = toPx(0, y);
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
    }
    ctx.stroke();

    const { px: ax } = toPx(0, 0);
    const { py: ay } = toPx(0, 0);
    ctx.strokeStyle = "#9aa4b8";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    if (0 >= yMin && 0 <= yMax) {
      ctx.moveTo(0, ay);
      ctx.lineTo(W, ay);
    }
    if (0 >= xMin && 0 <= xMax) {
      ctx.moveTo(ax, 0);
      ctx.lineTo(ax, H);
    }
    ctx.stroke();

    ctx.fillStyle = "#6b7280";
    ctx.lineWidth = 1;
    const fmt = (v: number) => String(Math.round(v * 100) / 100);
    for (let x = Math.floor(xMin / step) * step; x <= xMax; x += step) {
      if (Math.abs(x) < EPSILON) continue;
      const { px, py } = toPx(x, 0);
      ctx.beginPath();
      ctx.strokeStyle = "#9aa4b8";
      ctx.moveTo(px, py - 3);
      ctx.lineTo(px, py + 3);
      ctx.stroke();
      ctx.fillText(fmt(x), px + 2, Math.min(H - 2, Math.max(10, ay + 12)));
    }
    for (let y = Math.floor(yMin / step) * step; y <= yMax; y += step) {
      if (Math.abs(y) < EPSILON) continue;
      const { px, py } = toPx(0, y);
      ctx.beginPath();
      ctx.strokeStyle = "#9aa4b8";
      ctx.moveTo(px - 3, py);
      ctx.lineTo(px + 3, py);
      ctx.stroke();
      ctx.fillText(fmt(y), Math.min(W - 26, Math.max(2, ax + 4)), py - 3);
    }

    // Curves: analytic where possible, marching squares otherwise.
    for (const c of compiled) {
      if (c.error || !c.row.visible || c.needs3d) continue;
      ctx.strokeStyle = c.row.color;
      ctx.lineWidth = 2.25;
      ctx.lineJoin = "round";
      if (c.explicit) {
        const { out, free, f } = c.explicit;
        const s = { ...scopeRef.current };
        ctx.beginPath();
        let pen = false;
        let prevOut: number | null = null;
        const n = Math.max(64, Math.min(1200, Math.floor(W * 2)));
        for (let i = 0; i <= n; i++) {
          const t = xMin + ((xMax - xMin) * i) / n;
          s[free] = t;
          let o: number;
          try {
            o = f(s);
          } catch {
            o = NaN;
          }
          const px = free === "x" ? toPx(t, 0).px : toPx(0, t).px;
          const pyBase = out === "y" ? o : t;
          const pxFree = free === "x" ? toPx(t, 0).px : toPx(0, t).px;
          const drawX = out === "y" ? pxFree : toPx(0, o).px;
          const drawY = out === "y" ? toPx(0, o).py : H - ((pyBase - yMin) / (yMax - yMin)) * H;
          void px;
          void pyBase;
          const jump = prevOut !== null && Number.isFinite(o) && Number.isFinite(prevOut) && Math.abs(o - prevOut) > (yMax - yMin) * 4;
          if (!Number.isFinite(o) || jump) {
            pen = false;
            prevOut = Number.isFinite(o) ? o : null;
            continue;
          }
          prevOut = o;
          if (!pen) {
            ctx.moveTo(drawX, drawY);
            pen = true;
          } else {
            ctx.lineTo(drawX, drawY);
          }
        }
        ctx.stroke();
      } else if (c.implicit) {
        const res = Math.max(40, Math.min(160, Math.floor(W / 4)));
        const segs = marchingSquares(c.implicit, scopeRef.current, xMin, xMax, yMin, yMax, res);
        ctx.beginPath();
        for (const [x1, y1, x2, y2] of segs) {
          const a = toPx(x1, y1);
          const b = toPx(x2, y2);
          ctx.moveTo(a.px, a.py);
          ctx.lineTo(b.px, b.py);
        }
        ctx.stroke();
      }
    }
  }, [compiled, view2d, plotSize, measurePlot, scope, mode]);

  // ── 2D pan/zoom (native, non-passive — React wheel handlers are passive
  // and cannot preventDefault, which would let pinch page-zoom the browser).
  const dragRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const onPlotWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const W = plotSize.w || 1;
    const H = plotSize.h || 1;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const isPinch = e.ctrlKey || e.metaKey;
    // Discrete mouse wheel (large deltas, no ctrl) zooms; trackpad pixel
    // two-finger scroll pans; pinch (ctrl) zooms toward the cursor.
    const isMouseWheel = !isPinch && Math.abs(e.deltaY) >= 100 && e.deltaX === 0;
    if (!isPinch && !isMouseWheel) {
      setView2d((v) => {
        const spanY = (v.spanX * H) / W;
        // Content follows the fingers; screen-y flips in graph space.
        return { ...v, cx: v.cx + (e.deltaX / W) * v.spanX, cy: v.cy - (e.deltaY / H) * spanY };
      });
      return;
    }
    setView2d((v) => {
      const factor = Math.exp(e.deltaY * (isPinch ? 0.008 : 0.0015));
      const nextSpan = Math.min(5000, Math.max(0.5, v.spanX * factor));
      const spanY = (v.spanX * H) / W;
      const nextSpanY = (nextSpan * H) / W;
      const wx = v.cx - v.spanX / 2 + (mx / W) * v.spanX;
      const wy = v.cy + spanY / 2 - (my / H) * spanY;
      const fx = mx / W;
      const fy = my / H;
      return {
        spanX: nextSpan,
        cx: wx - (fx - 0.5) * nextSpan,
        cy: wy + (fy - 0.5) * nextSpanY,
      };
    });
  };
  const onPlotDown = (e: React.PointerEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, cx: view2d.cx, cy: view2d.cy };
    setGrabbing(true);
  };
  const onPlotMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const W = plotSize.w || 1;
    const H = plotSize.h || 1;
    const spanY = (view2d.spanX * H) / W;
    const dx = ((e.clientX - d.sx) / W) * view2d.spanX;
    const dy = ((e.clientY - d.sy) / H) * spanY;
    setView2d((v) => ({ ...v, cx: d.cx - dx, cy: d.cy + dy }));
  };
  const onPlotUp = () => {
    dragRef.current = null;
    setGrabbing(false);
  };

  // Native wheel listener on the plot box (2D canvas handles its own; the 3D
  // host registers its own when mounted).
  const plotBoxRef = useRef<HTMLDivElement | null>(null);
  const onPlotWheelRef = useRef(onPlotWheel);
  onPlotWheelRef.current = onPlotWheel;
  useEffect(() => {
    const box = plotBoxRef.current;
    if (!box || mode !== "2d") return;
    const handler = (e: WheelEvent) => {
      if (e.target === canvasRef.current) onPlotWheelRef.current(e);
      else if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    box.addEventListener("wheel", handler, { passive: false });
    return () => box.removeEventListener("wheel", handler);
  }, [mode]);

  // Root guard: browser page-zoom (pinch = ctrl+wheel) is blocked over the
  // whole element; plain wheel still scrolls the sidebar natively.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const guard = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    root.addEventListener("wheel", guard, { passive: false });
    return () => root.removeEventListener("wheel", guard);
  }, []);

  // ── 3D renderer (three.js, per-user orbit) ────────────────────────────────
  const host3dRef = useRef<HTMLDivElement | null>(null);
  const orbitRef = useRef(orbit);
  orbitRef.current = orbit;

  const meshes = useMemo(() => compiled.filter((c) => !c.error && c.row.visible), [compiled]);

  /** Bumped when the WebGL stage mounts — tells the data-rebuild effect to
   * populate a fresh stage even if meshes/scope didn't change. */
  const [stageEpoch, setStageEpoch] = useState(0);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const dataGroupRef = useRef<THREE.Group | null>(null);
  const plotSizeRef = useRef(plotSize);
  plotSizeRef.current = plotSize;
  /** In-flight slider rebuild (rAF handle). */
  const sliderRafRef = useRef<number | null>(null);

  useEffect(() => {
    const host = host3dRef.current;
    // Mount ONLY on mode/interactive flips — NOT on plotSize. Resizing the
    // element used to tear down the whole WebGL stage (renderer dispose,
    // scene rebuild, surface-nets re-run) per resize frame; the resize
    // effect below just calls renderer.setSize + camera.updateProjection.
    if (!host || mode !== "3d") return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(2, plotSizeRef.current.w), Math.max(2, plotSizeRef.current.h));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#ffffff");

    const camera = new THREE.PerspectiveCamera(
      45,
      Math.max(1, plotSizeRef.current.w) / Math.max(1, plotSizeRef.current.h),
      0.1,
      200,
    );

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    // Stage: ground grid + labeled axes. World = math mapped (x→X, z→Y, y→−Z).
    const grid = new THREE.GridHelper(10, 10, 0xcbd0dd, 0xe8ebf2);
    scene.add(grid);
    const axesMat = new THREE.LineBasicMaterial({ color: 0x9aa4b8 });
    const mkAxis = (pts: [number, number, number][]) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
      scene.add(new THREE.Line(g, axesMat));
    };
    mkAxis([[-5, 0, 0], [5, 0, 0]]); // math x
    mkAxis([[0, 0, -5], [0, 0, 5]]); // math y (depth)
    mkAxis([[0, 0, 0], [0, 5, 0]]);  // math z (height)

    const mkLabel = (text: string, pos: [number, number, number]) => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const g2 = c.getContext("2d");
      if (!g2) return;
      g2.font = "700 40px ui-sans-serif, system-ui, sans-serif";
      g2.fillStyle = "#475069";
      g2.textAlign = "center";
      g2.textBaseline = "middle";
      g2.fillText(text, 32, 34);
      const tex = new THREE.CanvasTexture(c);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      sprite.scale.setScalar(0.7);
      sprite.position.set(...pos);
      scene.add(sprite);
    };
    mkLabel("x", [5.6, 0, 0]);
    mkLabel("y", [0, 0, -5.6]); // math y → world Z = −y (rotation)
    mkLabel("z", [0, 5.6, 0]); // math z → world height

    const dataGroup = new THREE.Group();
    scene.add(dataGroup);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    dataGroupRef.current = dataGroup;
    setStageEpoch((n) => n + 1);

    // Per-user orbit: drag rotates, wheel zooms — all local, never synced.
    let dragging: { x: number; y: number } | null = null;
    const dom = renderer.domElement;
    dom.style.pointerEvents = interactive ? "auto" : "none";
    const render = () => {
      const r = rendererRef.current;
      const sc = sceneRef.current;
      const cam = cameraRef.current;
      if (r && sc && cam) r.render(sc, cam);
    };
    const applyOrbit = () => {
      const { theta, phi, dist } = orbitRef.current;
      camera.position.set(
        dist * Math.sin(phi) * Math.sin(theta),
        dist * Math.cos(phi),
        dist * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(0, 0, 0);
      render();
    };
    const down = (e: PointerEvent) => {
      dragging = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      dragging = { x: e.clientX, y: e.clientY };
      setOrbit((o) => ({
        ...o,
        theta: o.theta - dx * 0.01,
        phi: Math.min(Math.PI - 0.15, Math.max(0.15, o.phi - dy * 0.01)),
      }));
    };
    const up = () => {
      dragging = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOrbit((o) => ({ ...o, dist: Math.min(60, Math.max(3, o.dist * Math.exp(e.deltaY * 0.0015))) }));
    };
    if (interactive) {
      dom.addEventListener("pointerdown", down);
      dom.addEventListener("pointermove", move);
      dom.addEventListener("pointerup", up);
      dom.addEventListener("wheel", wheel, { passive: false });
    }
    applyOrbit();

    return () => {
      if (interactive) {
        dom.removeEventListener("pointerdown", down);
        dom.removeEventListener("pointermove", move);
        dom.removeEventListener("pointerup", up);
        dom.removeEventListener("wheel", wheel);
      }
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      dataGroupRef.current = null;
      if (sliderRafRef.current !== null) cancelAnimationFrame(sliderRafRef.current);
      sliderRafRef.current = null;
      renderer.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      host.removeChild(dom);
    };
  }, [mode, interactive]);

  // Resize-only: keep the mounted stage in sync with the element box —
  // renderer.setViewport-free, just size + aspect, then one redraw. The
  // stageEpoch bump keeps the data-rebuild effect honest for a fresh mount.
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!renderer || !camera || mode !== "3d" || plotSize.w < 2 || plotSize.h < 2) return;
    const cur = renderer.getSize(new THREE.Vector2());
    if (Math.abs(cur.x - plotSize.w) < 0.5 && Math.abs(cur.y - plotSize.h) < 0.5) return;
    renderer.setSize(plotSize.w, plotSize.h);
    camera.aspect = plotSize.w / plotSize.h;
    camera.updateProjectionMatrix();
    setStageEpoch((n) => n + 1);
  }, [plotSize, mode]);

  // Orbit-only update: move the camera, re-render — no scene rebuild.
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;
    const { theta, phi, dist } = orbit;
    camera.position.set(
      dist * Math.sin(phi) * Math.sin(theta),
      dist * Math.cos(phi),
      dist * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }, [orbit]);

  // Data rebuild: every visible relation becomes a level-set mesh (surface
  // nets). Math (x,y,z) → world (X=x, Y=z, Z=y). Runs on expression edits,
  // slider moves, and fresh stage mounts.
  //
  // Two rebuild paths (perf):
  //   slider moves  → coalesced to ONE rebuild per animation frame at the
  //                   slider grid — the mesh tracks the drag in real time
  //   typing / mode → after a 250ms pause, at full resolution
  // (A setTimeout debounce here was the wrong tool: during a drag each fire
  // ran between queued input events, so updates only landed on release.)
  useEffect(() => {
    const sliderDriven = lastScopeChangeRef.current === "slider";
    const group = dataGroupRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!group || !renderer || !scene || !camera) return;

    const buildMeshes = (res: number) => {
      for (const child of [...group.children]) {
        group.remove(child);
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }

      for (const c of meshes) {
        if (!c.implicit) continue;
        const { positions, indices, normals } = surfaceNets(c.implicit, scopeRef.current, res);
        if (positions.length === 0) continue;
        // math (x, y, z) → world (X = x, Y = z, Z = −y) — a proper ROTATION
        // (det +1), not the old y/z swap (a reflection, det −1) that inverted
        // triangle winding. Normals map through the same rotation (negate the
        // last component — the gradient is a vector).
        const world = new Float32Array(positions.length);
        const worldN = new Float32Array(normals.length);
        for (let i = 0; i < positions.length; i += 3) {
          world[i] = positions[i]!;
          world[i + 1] = positions[i + 2]!;
          world[i + 2] = -positions[i + 1]!;
          worldN[i] = normals[i]!;
          worldN[i + 1] = normals[i + 2]!;
          worldN[i + 2] = -normals[i + 1]!;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(world, 3));
        geom.setAttribute("normal", new THREE.BufferAttribute(worldN, 3));
        geom.setIndex(indices);
        const mesh = new THREE.Mesh(
          geom,
          new THREE.MeshLambertMaterial({ color: new THREE.Color(c.row.color), side: THREE.DoubleSide }),
        );
        group.add(mesh);
      }
      renderer.render(scene, camera);
    };

    if (sliderDriven) {
      // Coalesce to one rebuild per frame: input events queue faster than
      // rAF, so consecutive slider moves within a frame replace each other
      // and exactly one mesh build runs when the browser paints next.
      if (sliderRafRef.current !== null) return;
      sliderRafRef.current = requestAnimationFrame(() => {
        sliderRafRef.current = null;
        buildMeshes(SURFACE_RES_SLIDER);
      });
    } else {
      const t = window.setTimeout(() => buildMeshes(SURFACE_RES), 250);
      // stageEpoch: freshly mounted stage needs population even when meshes
      // and scope are unchanged (fixes "blank until another edit").
      return () => window.clearTimeout(t);
    }
    // stageEpoch: freshly mounted stage needs population even when meshes
    // and scope are unchanged (fixes "blank until another edit").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshes, scope, stageEpoch]);

  return (
    <div
      ref={rootRef}
      className={`math-editor ${interactive ? "" : "math-editor-passive"}`}
      data-el-id={dataElId}
      style={style}
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* ── Chrome: mode toggle — doubles as the window title bar ───────── */}
      <div
        className="math-toolbar"
        onPointerDown={(e) => {
          // Controls handle their own pointer events; a press on the bar
          // background (not a button) starts an OS-window drag.
          if ((e.target as HTMLElement).closest("input, select, button")) return;
          onWindowDragStart(e);
        }}
      >
        <span className="math-title">ƒ(x)</span>
        <div className="math-mode-toggle">
          <button
            className={mode === "2d" ? "active" : ""}
            disabled={!canWrite}
            onClick={() => canWrite && onChange({ mode: "2d" })}
            title="2D graph"
          >
            2D
          </button>
          <button
            className={mode === "3d" ? "active" : ""}
            disabled={!canWrite}
            onClick={() => canWrite && onChange({ mode: "3d" })}
            title="3D view — every equation is a surface: y=x and z=x are different planes"
          >
            3D
          </button>
        </div>
        <span className="math-flex" />
      </div>

      <div className="math-body">
        {/* ── Expression sidebar (Desmos-lite) ──────────────────────────── */}
        <div className="math-sidebar">
          {el.expressions.map((row) => {
            const c = compiled.find((x) => x.row.id === row.id);
            const isEditing =
              editingExprId === row.id ||
              (editingExprId === "new" && row === el.expressions[el.expressions.length - 1]);
            return (
              <div key={row.id} className="math-row">
                <button
                  className="math-vis"
                  title={row.visible ? "Hide" : "Show"}
                  style={{ borderColor: row.color }}
                  onClick={() => canWrite && updateExpression(row.id, { visible: !row.visible })}
                >
                  <span style={{ background: row.visible ? row.color : "transparent" }} />
                </button>
                <input
                  className="math-expr"
                  value={textOverride[row.id] ?? row.text}
                  disabled={!canWrite}
                  placeholder={mode === "2d" ? "y = …" : "z = …"}
                  spellCheck={false}
                  autoFocus={isEditing}
                  onFocus={() => setEditingExprId(row.id)}
                  onBlur={() => {
                    flushText(row.id);
                    setEditingExprId(null);
                  }}
                  onChange={(e) => updateExpressionText(row.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      flushText(row.id);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  style={{ borderColor: c?.error ? "#ef4444" : undefined }}
                />
                <button
                  className="math-row-del"
                  title="Delete expression"
                  onClick={() => removeExpression(row.id)}
                  disabled={!canWrite}
                >
                  ✕
                </button>
                {c?.error && <div className="math-err">{c.error}</div>}
                {!c?.error && c?.needs3d && mode === "2d" && (
                  <div className="math-err math-err-hint">uses z — switch to 3D</div>
                )}
              </div>
            );
          })}
          {canWrite && (
            <button className="math-add-expr" onClick={addExpression}>
              + expression
            </button>
          )}

          {/* ── Slider offers for discovered variables (Desmos behavior) ── */}
          {discovered.length > 0 && canWrite && (
            <div className="math-param-offers">
              {discovered.map((name) => (
                <button key={name} className="math-param-offer" onClick={() => addParam(name)}>
                  <code>{name}</code> is a free variable — add a slider
                </button>
              ))}
            </div>
          )}

          {/* ── Sliders: shared defaults, per-user live values ──────────── */}
          {el.params.map((p) => (
            <div key={p.name} className="math-param">
              <div className="math-param-head">
                <code className="math-param-name">{p.name}</code>
                <span className="math-param-val">{(liveValues[p.name] ?? p.defaultValue).toFixed(2)}</span>
                <button className="math-param-reset" title="Reset to shared default" onClick={() => resetParam(p.name)}>
                  ↺
                </button>
              </div>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={liveValues[p.name] ?? p.defaultValue}
                onChange={(e) => {
                  // Slider drags rebuild the 3D mesh INSTANTLY (no typing
                  // debounce) at the lighter slider resolution.
                  lastScopeChangeRef.current = "slider";
                  setLiveValues((v) => ({ ...v, [p.name]: Number(e.target.value) }));
                }}
                onDoubleClick={() => resetParam(p.name)}
                style={{ accentColor: "#6c8cff" }}
              />
              {canWrite && (
                <div className="math-param-bounds">
                  <input
                    type="number"
                    value={p.min}
                    onChange={(e) => updateParam(p.name, { min: Number(e.target.value) })}
                  />
                  <input
                    type="number"
                    value={p.max}
                    onChange={(e) => updateParam(p.name, { max: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Plot area ─────────────────────────────────────────────────── */}
        <div ref={plotBoxRef} className="math-plot">
          {mode === "2d" ? (
            <canvas
              ref={(node) => {
                canvasRef.current = node;
                measurePlot(node);
              }}
              className="math-canvas"
              style={{
                cursor: grabbing ? "grabbing" : interactive ? "grab" : "default",
                pointerEvents: interactive ? "auto" : "none",
              }}
              onPointerDown={onPlotDown}
              onPointerMove={onPlotMove}
              onPointerUp={onPlotUp}
            />
          ) : (
            <div
              ref={(node) => {
                host3dRef.current = node;
                measurePlot(node as unknown as HTMLCanvasElement);
              }}
              className="math-3d-host"
            />
          )}
          {compiled.some((c) => c.error) && (
            <div className="math-plot-err">{compiled.find((c) => c.error)?.error}</div>
          )}
        </div>
      </div>
    </div>
  );
});
