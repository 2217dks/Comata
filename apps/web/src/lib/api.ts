export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8788";

/** JSON fetch against the API with session cookies. Throws on non-2xx. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${detail.slice(0, 200) || res.statusText}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Persist the raw Yjs doc for a notebook (binary body). */
export async function saveNotebookSnapshot(notebookId: string, bytes: Uint8Array): Promise<boolean> {
  const res = await fetch(`${API_URL}/v1/notebooks/${notebookId}/snapshot`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes as unknown as BodyInit,
  });
  return res.ok;
}

/** Load a notebook's persisted Yjs doc, or null when none saved yet. */
export async function loadNotebookSnapshot(notebookId: string): Promise<Uint8Array | null> {
  const res = await fetch(`${API_URL}/v1/notebooks/${notebookId}/snapshot`, {
    credentials: "include",
  });
  if (res.status === 204) return null;
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}
