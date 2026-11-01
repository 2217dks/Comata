import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { pickCursorColor } from "@comata/elements";
import type { MemberRole, NotebookKind } from "@comata/schema";
import { Board } from "../board/Board";
import { useBoard } from "../board/useBoard";
import { Spinner } from "../components/Spinner";
import { api, loadNotebookSnapshot, saveNotebookSnapshot } from "../lib/api";
import { useSession } from "../lib/auth-client";
import type { Identity } from "../lib/identity";

type NotebookDetail = {
  id: string;
  title: string;
  kind: NotebookKind;
  background: "light" | "dark";
  role: MemberRole;
  updatedAt: string;
};

const SNAPSHOT_INTERVAL_MS = 20_000;

/** Byte-equality for the skip-unchanged snapshot save. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function NotebookPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const [notebook, setNotebook] = useState<NotebookDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (isPending || !session || !id) return;
    // Opening a notebook enrolls the user (invite-link semantics: EDITOR).
    api<NotebookDetail>(`/v1/notebooks/${id}`)
      .then((nb) => {
        setNotebook(nb);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [session, isPending, id]);

  // Remember where the anonymous visitor was heading — the dashboard
  // bounces them back here after sign-in.
  useEffect(() => {
    if (!isPending && !session) {
      sessionStorage.setItem("comata-redirect", window.location.pathname);
    }
  }, [isPending, session]);

  // Stable per session — useBoard tears down the room if this changes.
  // Must live above the early returns: hooks can never be conditional.
  const identity = useMemo<Identity | null>(
    () =>
      session
        ? {
            id: session.user.id,
            name: session.user.name || session.user.email,
            color: pickCursorColor(session.user.id),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.user.id, session?.user.name, session?.user.email],
  );

  if (isPending) {
    return <Spinner label="Checking your session…" />;
  }

  if (!session) {
    return (
      <div className="page-center">
        <div className="auth-card">
          <h2>Sign in to open this notebook</h2>
          <p className="auth-sub">
            You need an account to view or edit notebooks. After signing in you'll land
            right back here.
          </p>
          <button className="auth-submit" onClick={() => navigate("/")}>
            Sign in or create an account
          </button>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="page-center">
        <div className="auth-card">
          <h2>Can't open this notebook</h2>
          <p className="auth-sub">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!notebook || !id || !identity) {
    return <Spinner label="Opening notebook…" />;
  }

  return <BoardSession key={notebook.id} notebook={notebook} identity={identity} />;
}

function BoardSession({ notebook, identity }: { notebook: NotebookDetail; identity: Identity }) {
  const board = useBoard(`notebook:${notebook.id}`, identity);
  const readOnly = notebook.role === "VIEWER";

  // Load any persisted snapshot into the live doc (merge is CRDT-safe).
  // Presentation notebooks then seed page 1 if the doc has none (idempotent —
  // concurrent openers race to insert the same shape; Yjs resolves safely).
  useEffect(() => {
    void loadNotebookSnapshot(notebook.id).then((bytes) => {
      if (bytes) board.applySnapshot(bytes);
      if (notebook.kind === "presentation") board.seedPages();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook.id]);

  const lastSavedRef = useRef<Uint8Array | null>(null);
  const saveSnapshot = useCallback(async () => {
    if (readOnly) return;
    const bytes = board.getSnapshot();
    if (!bytes || bytes.byteLength === 0) return;
    // Skip the upload when the doc is unchanged since the last save — the
    // 20s timer used to re-encode + POST the whole doc even when idle.
    if (lastSavedRef.current && bytesEqual(lastSavedRef.current, bytes)) return;
    lastSavedRef.current = bytes;
    const ok = await saveNotebookSnapshot(notebook.id, bytes);
    if (!ok) console.warn("snapshot save failed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook.id, readOnly, board.getSnapshot]);

  // Persist on a timer, on unload, and when leaving the page (route change).
  useEffect(() => {
    const timer = setInterval(() => void saveSnapshot(), SNAPSHOT_INTERVAL_MS);
    const onUnload = () => void saveSnapshot();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", onUnload);
      void saveSnapshot();
    };
  }, [saveSnapshot]);

  return (
    <Board
      board={board}
      identity={identity}
      title={notebook.title}
      kind={notebook.kind}
      background={notebook.background}
      readOnly={readOnly}
      notebookId={notebook.id}
    />
  );
}
