import {
  RUN_MEMORY_LIMIT_MB,
  RUN_WALL_TIME_LIMIT_S,
  type CodeRunResult,
} from "@comata/schema";

// ── Runner interface (ADR-0002) ──────────────────────────────────────────────
// One thin interface around code execution so the backend swap (Piston →
// Judge0 → gVisor runner) touches one module. All implementations apply the
// same global caps; the caller owns auth, locks, and rate limiting.

export type RunSubmission = {
  language: string;
  /** Version filter, e.g. "3.14" — implementations pick their closest match. */
  version?: string;
  code: string;
  stdin: string;
};

export type Runtime = {
  language: string;
  version: string;
  aliases?: string[];
};

export type Runner = {
  /** Available language runtimes (drives the client's language selector). */
  runtimes(): Promise<Runtime[]>;
  /** Execute one submission synchronously. Throws RunnerError on failure. */
  run(sub: RunSubmission): Promise<CodeRunResult>;
};

export class RunnerError extends Error {
  /** "offline" = unreachable, "failed" = the runner rejected/errored the run. */
  kind: "offline" | "failed";
  constructor(kind: "offline" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

// ── Piston implementation ────────────────────────────────────────────────────
// Self-hosted Piston (engineerman/piston, default port 2000). API: /api/v2.

const RUNTIME_TIMEOUT_MS = 5_000;

export type PistonOptions = {
  /** Base URL, e.g. http://localhost:2000 */
  baseUrl: string;
};

type PistonRuntime = { language: string; version: string; aliases?: string[] };
type PistonResult = {
  run?: {
    stdout?: string;
    stderr?: string;
    code?: number;
    signal?: string | null;
    output?: string;
  };
  compile?: { stderr?: string; code?: number } | null;
  message?: string;
};

export class PistonRunner implements Runner {
  private baseUrl: string;
  private runtimesCache: PistonRuntime[] | null = null;

  constructor(opts: PistonOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  async runtimes(): Promise<Runtime[]> {
    if (this.runtimesCache) return this.runtimesCache;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v2/runtimes`, {
        signal: AbortSignal.timeout(RUNTIME_TIMEOUT_MS),
      });
    } catch (err) {
      throw new RunnerError("offline", `piston unreachable: ${String(err)}`);
    }
    if (!res.ok) {
      throw new RunnerError("offline", `piston runtimes ${res.status}`);
    }
    const raw = (await res.json()) as PistonRuntime[];
    this.runtimesCache = raw.map((r) => ({
      language: r.language,
      version: r.version,
      aliases: r.aliases,
    }));
    return this.runtimesCache;
  }

  async run(sub: RunSubmission): Promise<CodeRunResult> {
    const language = await this.resolveLanguage(sub.language, sub.version);
    // Stock Piston caps run_timeout at 3000ms (config default) — when it
    // rejects with "…cannot exceed the configured limit of N", clamp to N and
    // retry once (capped runtimes self-heal to their own limit).
    let runTimeout = RUN_WALL_TIME_LIMIT_S * 1000;
    let compileTimeout = RUN_WALL_TIME_LIMIT_S * 1000;
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}/api/v2/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            version: "*",
            files: [{ name: pistonFileName(sub.language), content: sub.code }],
            stdin: sub.stdin,
            run_timeout: runTimeout,
            compile_timeout: compileTimeout,
          }),
          signal: AbortSignal.timeout((RUN_WALL_TIME_LIMIT_S + 5) * 1000),
        });
      } catch (err) {
        throw new RunnerError("offline", `piston unreachable: ${String(err)}`);
      }
      if (res.ok || res.status !== 400 || attempt > 0) break;
      const limit = await timeoutLimitFrom400(res);
      if (!limit) break;
      if (limit.stage === "run") runTimeout = limit.ms;
      else compileTimeout = limit.ms;
    }
    if (res.status === 429) {
      throw new RunnerError("failed", "runner rate limited");
    }
    if (!res.ok) {
      // Surface Piston's own message (bad language, timeout cap, …) — a bare
      // status code gives the client nothing to act on.
      const detail = await res
        .json()
        .then((b) => (b as PistonResult).message ?? "")
        .catch(() => "");
      throw new RunnerError("failed", `piston execute ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = (await res.json()) as PistonResult;
    if (body.message) {
      // Piston-level rejection (bad language, too-large payload, …).
      throw new RunnerError("failed", body.message);
    }
    return {
      stdout: body.run?.stdout ?? "",
      stderr: body.compile?.stderr || body.run?.stderr || "",
      exitCode: body.run?.code ?? null,
      timeMs: null, // Piston does not report execution time
    };
  }

  /** Match a requested language to a Piston runtime (aliases included). */
  private async resolveLanguage(requested: string, version?: string): Promise<string> {
    const runtimes = await this.runtimes();
    const matches = runtimes.filter(
      (r) =>
        r.language === requested ||
        r.language.startsWith(requested + "-") ||
        (r.aliases ?? []).includes(requested),
    );
    if (matches.length === 0) {
      throw new RunnerError("failed", `unsupported language: ${requested}`);
    }
    if (version) {
      const exact = matches.find((r) => r.version.startsWith(version));
      if (exact) return exact.language;
    }
    // Highest version wins (Piston may list several runtimes per language).
    const sorted = [...matches].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    return (sorted[0] as PistonRuntime).language;
  }
}

/** Parse Piston's 400 rejection ("run_timeout cannot exceed the configured
 * limit of 3000") into the stage + limit; null when it's a different 400. */
async function timeoutLimitFrom400(
  res: Response,
): Promise<{ stage: "run" | "compile"; ms: number } | null> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  const m = /(run|compile)_timeout cannot exceed the configured limit of (\d+)/.exec(body?.message ?? "");
  return m ? { stage: m[1] as "run" | "compile", ms: Number(m[2]) } : null;
}

function pistonFileName(language: string): string {
  const exts: Record<string, string> = {
    python: "main.py",
    javascript: "main.js",
    typescript: "main.ts",
    c: "main.c",
    cpp: "main.cpp",
    java: "Main.java",
    rust: "main.rs",
    go: "main.go",
  };
  return exts[language] ?? "main.txt";
}

export const RUN_CAPS = {
  wallTimeS: RUN_WALL_TIME_LIMIT_S,
  memoryMb: RUN_MEMORY_LIMIT_MB,
} as const;

export function createRunnerFromEnv(): Runner {
  const baseUrl = process.env.PISTON_RUNNER_URL ?? "http://localhost:2000";
  return new PistonRunner({ baseUrl });
}
