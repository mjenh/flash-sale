// The email identifier field — session-only, never remembered.
//
// It starts EMPTY on every load (a browser refresh, a new tab, a new window, or
// an incognito session is a clean slate) and holds its value for the life of the
// page. It is NEVER cleared by an order attempt — win, loss, or error alike, the
// address stays put so the buyer can re-check or retry without retyping. Nothing
// is persisted: on a shared machine the next visitor never inherits the previous
// person's address. The server's Redis set is the only durable identity — this
// input is pure transient UI.
import { useState } from "react";

export function useEmailField(): [string, (next: string) => void] {
  const [email, setEmail] = useState("");
  return [email, setEmail];
}
