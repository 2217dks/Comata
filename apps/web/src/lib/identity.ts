import { useMemo } from "react";
import { pickCursorColor } from "@comata/elements";

export type Identity = { id: string; name: string; color: string };

const STORAGE_KEY = "comata-identity";

/** Stable per-browser identity: persists across reloads so cursors keep their name/color. */
export function loadOrCreateIdentity(): Identity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (parsed.id && parsed.name && parsed.color) return parsed as Identity;
    }
  } catch {
    // corrupted entry — fall through and recreate
  }
  const id = "u-" + Math.random().toString(36).slice(2, 8);
  const identity: Identity = {
    id,
    name: "Guest " + id.slice(-4).toUpperCase(),
    color: pickCursorColor(id),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

export function useIdentity(): Identity {
  return useMemo(loadOrCreateIdentity, []);
}
