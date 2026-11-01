import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma 7 does not auto-load .env — load the repo-root file explicitly.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(import.meta.dirname, "prisma", "migrations"),
  },
  // CLI datasource: migrations/introspection use the DIRECT Supabase URL
  // (:5432) — bypasses pgBouncer. The runtime client uses the pooled URL
  // (:6543) via the pg adapter in src/index.ts.
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
