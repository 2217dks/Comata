import { createClient } from "@liveblocks/client";
import { API_URL } from "./api";

/**
 * Liveblocks client. Room ids follow `notebook:{Notebook.id}`.
 * Auth rides on the Better-Auth session cookie; the API maps
 * NotebookMember roles to room scopes (OWNER/EDITOR write, VIEWER read).
 */
export const liveblocksClient = createClient({
  authEndpoint: async (room?: string) => {
    const res = await fetch(`${API_URL}/v1/liveblocks/auth`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: room ?? "" }),
    });
    if (!res.ok) {
      throw new Error(`Liveblocks auth failed: ${res.status}`);
    }
    return (await res.json()) as { token: string };
  },
});
