import type { Context } from "hono";
import { auth } from "./auth";

/** Resolve the signed-in Better-Auth user from the request cookies (or null). */
export async function getSessionUser(c: Context) {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user ?? null;
  } catch {
    return null;
  }
}
