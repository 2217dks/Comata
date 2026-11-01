import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { AiAllowlistEntry } from "@comata/schema";

// ── AI admin (Slice 5b, ADR-0004) ────────────────────────────────────────────
// Minimal allowlist management: deny by default; the owner grants/revoke per
// email live during demos. Deliberately bare — polish is post-MVP backlog.

export function AiAdminPage() {
  const [entries, setEntries] = useState<AiAllowlistEntry[] | null>(null);
  const [me, setMe] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ entries: AiAllowlistEntry[]; me: string }>("/v1/ai/allowlist");
      setEntries(res.entries);
      setMe(res.me);
      setIsAdmin(true);
    } catch (err) {
      // 403 = signed in but not an admin — render the locked-out state.
      const message = err instanceof Error ? err.message : String(err);
      if (/API 403/.test(message)) {
        setIsAdmin(false);
        setEntries([]);
      } else {
        setError(message);
        setEntries([]);
      }
    }
  }, []);

  useEffect(() => void load(), [load]);

  const grant = async () => {
    const clean = email.trim().toLowerCase();
    if (!clean) return;
    setError("");
    try {
      await api("/v1/ai/allowlist", { method: "POST", body: JSON.stringify({ email: clean }) });
      setEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const revoke = async (id: string) => {
    await api(`/v1/ai/allowlist/${id}`, { method: "DELETE" }).catch(() => null);
    await load();
  };

  if (isAdmin === false) {
    return (
      <div className="ai-admin">
        <header className="ai-admin-head">
          <Link to="/" className="ai-admin-back">← Dashboard</Link>
          <h2>AI Create — access</h2>
        </header>
        <p className="ai-admin-sub">Admin access required. Ask the owner to add your email to ADMIN_EMAILS.</p>
      </div>
    );
  }

  return (
    <div className="ai-admin">
      <header className="ai-admin-head">
        <Link to="/" className="ai-admin-back">← Dashboard</Link>
        <h2>AI Create — access</h2>
      </header>
      <p className="ai-admin-sub">
        Deny by default: only listed emails can use AI Create (20 generations/hour each).
        Admins are set via the server's ADMIN_EMAILS env.
      </p>

      <div className="ai-admin-grant">
        <input
          type="email"
          placeholder="email to grant"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && grant()}
        />
        <button onClick={grant} disabled={!email.trim()}>Grant access</button>
      </div>
      {error && <div className="ai-admin-error">{error}</div>}

      {entries === null && <div className="ai-admin-status">Loading…</div>}
      {entries !== null && entries.length === 0 && (
        <div className="ai-admin-status">Nobody has access yet.</div>
      )}
      {entries?.map((e2) => (
        <div key={e2.id} className="ai-admin-row">
          <span className="ai-admin-email">{e2.email}</span>
          {e2.email === me && <span className="ai-admin-you">you</span>}
          <span className="ai-admin-flex" />
          <button className="ai-admin-revoke" onClick={() => revoke(e2.id)}>Revoke</button>
        </div>
      ))}
    </div>
  );
}
