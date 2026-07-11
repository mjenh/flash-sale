// Skeleton page: checks backend health via /api. Sale UI (live status via
// EventSource, userId input, buy, result) lands with the feature stories.
import { useEffect, useState } from "react";

type BackendState = "checking" | "up" | "down";

export function App() {
  const [backend, setBackend] = useState<BackendState>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => setBackend(res.ok ? "up" : "down"))
      .catch(() => setBackend("down"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Flash Sale</h1>
      <p data-testid="backend-status">
        Backend: {backend === "checking" ? "checking…" : backend}
      </p>
    </main>
  );
}
