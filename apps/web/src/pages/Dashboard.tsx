import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { NotebookKind, NotebookSummary } from "@comata/schema";
import { Spinner } from "../components/Spinner";
import { api } from "../lib/api";
import { signIn, signOut, signUp, useSession } from "../lib/auth-client";

const JSON_HEADERS = { "Content-Type": "application/json" };

export function Dashboard() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  // Auth form state
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  // Create / rename state
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newKind, setNewKind] = useState<NotebookKind>("canvas");
  /** Canvas surface tone — fixed at creation (Slice 7, ADR-0006). */
  const [newBackground, setNewBackground] = useState<"light" | "dark">("dark");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const load = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await api<{ notebooks: NotebookSummary[] }>("/v1/notebooks");
      setNotebooks(data.notebooks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) {
      // Bounce back to a notebook the user was blocked from by the sign-in gate.
      const redirect = sessionStorage.getItem("comata-redirect");
      if (redirect) {
        sessionStorage.removeItem("comata-redirect");
        navigate(redirect);
        return;
      }
      void load();
    }
  }, [session, load, navigate]);

  // Close the create modal on Escape.
  useEffect(() => {
    if (!createOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createOpen]);

  if (isPending) {
    return <Spinner label="Loading…" />;
  }

  // ── Signed out: auth card ──────────────────────────────────────────────────
  if (!session) {
    const submit = async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      const result =
        mode === "signup"
          ? await signUp.email({
              email,
              password,
              name: name.trim() || email.split("@")[0] || "New user",
            })
          : await signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "Authentication failed");
      }
    };

    return (
      <div className="page-center">
        <form className="auth-card" onSubmit={submit}>
          <h2>{mode === "signin" ? "Sign in to Comata" : "Create your account"}</h2>
          <p className="auth-sub">
            {mode === "signin"
              ? "Your boards, lessons and notebooks — in one place."
              : "Free to start. Your notebooks sync in real time."}
          </p>
          {mode === "signup" && (
            <input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <input
            type="password"
            placeholder="Password (min 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
            required
          />
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="auth-submit">
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
          <button
            type="button"
            className="auth-toggle"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
          >
            {mode === "signin"
              ? "No account yet? Create one →"
              : "← Already have an account? Sign in"}
          </button>
        </form>
      </div>
    );
  }

  // ── Signed in: notebook dashboard ──────────────────────────────────────────
  const user = session.user;

  const createNotebook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const nb = await api<NotebookSummary>("/v1/notebooks", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          title: newTitle.trim() || "Untitled notebook",
          kind: newKind,
          background: newBackground,
        }),
      });
      setNewTitle("");
      setCreateOpen(false);
      navigate(`/notebook/${nb.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const commitRename = async () => {
    const id = editingId;
    setEditingId(null);
    if (!id || !editTitle.trim()) return;
    try {
      await api(`/v1/notebooks/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: editTitle.trim() }),
      });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteNotebook = async (id: string) => {
    if (!window.confirm("Delete this notebook? This cannot be undone.")) return;
    try {
      await api(`/v1/notebooks/${id}`, { method: "DELETE" });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="dash">
      <header className="topbar topbar--static">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-mark">C</span>
            <span className="brand-name">Comata</span>
          </div>
        </div>
        <div className="topbar-right">
          <span className="topbar-user">{user.name || user.email}</span>
          <Link className="ghost-btn" to="/ai-admin" title="AI Create access (allowlist)">
            AI access
          </Link>
          <button
            className="ghost-btn"
            onClick={() => {
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="dash-main">
        <div className="dash-head">
          <h1>Your notebooks</h1>
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            + New notebook
          </button>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <div className="nb-grid">
          {listLoading && (
            <div className="dash-loading">
              <div className="spinner" />
              <span>Loading notebooks…</span>
            </div>
          )}
          {!listLoading &&
            notebooks.map((nb) => (
            <div
              key={nb.id}
              className="nb-card"
              onClick={() => navigate(`/notebook/${nb.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") navigate(`/notebook/${nb.id}`);
              }}
            >
              <div className="nb-card-top">
                <span className={`kind-badge kind-${nb.kind}`}>{nb.kind}</span>
                <span className="nb-role">{nb.role.toLowerCase()}</span>
                <span className="nb-spacer" />
                {(nb.role === "OWNER" || nb.role === "EDITOR") && (
                  <button
                    className="nb-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(nb.id);
                      setEditTitle(nb.title);
                    }}
                  >
                    Rename
                  </button>
                )}
                {nb.role === "OWNER" && (
                  <button
                    className="nb-action danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteNotebook(nb.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
              {editingId === nb.id ? (
                <input
                  className="nb-rename"
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => void commitRename()}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void commitRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <h3>{nb.title}</h3>
              )}
              <span className="nb-updated">
                edited {new Date(nb.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                {new Date(nb.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
          {!listLoading && notebooks.length === 0 && (
            <p className="dash-empty">No notebooks yet — create your first one above.</p>
          )}
        </div>
      </main>

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void createNotebook(e)}
          >
            <h2>New notebook</h2>
            <label className="modal-label" htmlFor="nb-title">
              Title
            </label>
            <input
              id="nb-title"
              className="modal-input"
              autoFocus
              placeholder="Untitled notebook"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              maxLength={120}
            />
            <span className="modal-label">Type</span>
            <div className="kind-options">
              <button
                type="button"
                className={`kind-option ${newKind === "canvas" ? "active" : ""}`}
                onClick={() => setNewKind("canvas")}
              >
                <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                  <rect x="1" y="1" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="1" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="1" y="9" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="9" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                <span>Canvas</span>
                <small>Infinite freeform board — sketch, annotate, teach</small>
              </button>
              <button
                type="button"
                className={`kind-option ${newKind === "presentation" ? "active" : ""}`}
                onClick={() => setNewKind("presentation")}
              >
                <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                  <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M6.5 5.2v3.1l2.8-1.55z" fill="currentColor" />
                  <path d="M5 14h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span>Presentation</span>
                <small>Slide-by-slide pages, like a deck</small>
              </button>
            </div>
            {newKind === "canvas" && (
              <>
                <span className="modal-label">Background</span>
                <div className="kind-options">
                  <button
                    type="button"
                    className={`kind-option kind-bg ${newBackground === "light" ? "active" : ""}`}
                    onClick={() => setNewBackground("light")}
                  >
                    <span className="bg-swatch" style={{ background: "#ffffff" }} />
                    <span>Light</span>
                    <small>Fixed after creation</small>
                  </button>
                  <button
                    type="button"
                    className={`kind-option kind-bg ${newBackground === "dark" ? "active" : ""}`}
                    onClick={() => setNewBackground("dark")}
                  >
                    <span className="bg-swatch" style={{ background: "#171b24" }} />
                    <span>Dark</span>
                    <small>Fixed after creation</small>
                  </button>
                </div>
              </>
            )}
            {error && <p className="auth-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary">
                Create notebook
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
