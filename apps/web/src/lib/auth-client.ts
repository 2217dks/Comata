import { createAuthClient } from "better-auth/react";
import { API_URL } from "./api";

/** Better-Auth client — session hooks + email/password flows. */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/v1/auth`,
});

export const { signIn, signUp, signOut, useSession } = authClient;
