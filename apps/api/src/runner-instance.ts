import { createRunnerFromEnv, type Runner } from "@comata/runner";

/** Process-wide runner instance (Piston per ADR-0002). One module so the
 * backend swap touches exactly one file. */
export const runner: Runner = createRunnerFromEnv();
