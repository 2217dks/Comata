/** Centered loading spinner with an optional status label. */
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="page-center" role="status" aria-live="polite">
      <div className="spinner-stack">
        <div className="spinner" />
        {label && <span className="spinner-label">{label}</span>}
      </div>
    </div>
  );
}
