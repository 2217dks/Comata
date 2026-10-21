import { useEffect, useState } from "react";
import { APP_NAME, type HealthResponse } from "@comata/schema";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8788";

type ApiStatus = "checking" | "online" | "offline";

function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/v1/health`)
      .then((res) => res.json() as Promise<HealthResponse>)
      .then((data) => {
        if (!cancelled) setStatus(data.ok ? "online" : "offline");
      })
      .catch(() => {
        if (!cancelled) setStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

const STATUS_LABEL: Record<ApiStatus, string> = {
  checking: "checking API…",
  online: "API online",
  offline: "API offline",
};

export default function App() {
  const status = useApiStatus();

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">C</span>
          <span className="brand-name">{APP_NAME}</span>
        </div>
        <span className={`pill pill-${status}`}>
          <span className="pill-dot" />
          {STATUS_LABEL[status]}
        </span>
      </header>

      <main className="hero">
        <h1>
          Teach on an <span className="accent">infinite canvas.</span>
        </h1>
        <p className="tagline">
          Where code runs, math comes alive, and everything is just another element on the board.
        </p>

        <div className="cards">
          <article className="card">
            <div className="card-icon">▦</div>
            <h2>Infinite canvas</h2>
            <p>Sketch, ink, run code, and plot math on a zoomable board — together, in real time.</p>
            <span className="badge">Slice 2 — notebooks + dashboard</span>
          </article>
          <article className="card">
            <div className="card-icon">▤</div>
            <h2>Presentation</h2>
            <p>Turn any board into a lesson. Present, and every student follows your camera.</p>
            <span className="badge">Slice 7</span>
          </article>
        </div>

        <p className="footnote">
          MVP skeleton deployed — Slice 0 ✅ · next: shared board + live cursors (Slice 1)
        </p>
      </main>
    </div>
  );
}
