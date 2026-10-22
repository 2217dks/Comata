import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@comata/db";

export const WEB_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

/**
 * Better-Auth instance. Mounted at /v1/auth/** in app.ts.
 * - Email + password is always available (MVP demo path).
 * - Google OAuth activates automatically once GOOGLE_CLIENT_ID /
 *   GOOGLE_CLIENT_SECRET exist in the repo-root .env.
 */
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8788/v1/auth",
  trustedOrigins: [WEB_ORIGIN],
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
