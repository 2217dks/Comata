import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@comata/db";

// Comma-separated list so dev can add the laptop's LAN address for `pnpm dev --host`
// testing from other devices (e.g. `http://SpaceCarbon.local:5173,http://10.7.28.151:5173`).
// First entry is the canonical WEB_ORIGIN (used as default when CORS_ORIGIN is unset).
export const WEB_ORIGINS: readonly string[] = (
  process.env.CORS_ORIGIN ?? "http://localhost:5173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const WEB_ORIGIN = WEB_ORIGINS[0];

/**
 * Better-Auth instance. Mounted at /v1/auth/** in app.ts.
 * - Email + password is always available (MVP demo path).
 * - Google OAuth activates automatically once GOOGLE_CLIENT_ID /
 *   GOOGLE_CLIENT_SECRET exist in the repo-root .env.
 */
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8788/v1/auth",
  trustedOrigins: [...WEB_ORIGINS],
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },
});
