// The email identifier field — session-only, never remembered.
//
// It starts EMPTY on every load (a browser refresh is a clean slate) and is
// reset by the page after each completed order attempt. Nothing is persisted:
// on a shared machine the next visitor never inherits the previous person's
// address. The server's Redis set is the only durable identity — this input is
// pure transient UI.
import { useCallback, useState } from "react";

export function useEmailField(): [string, (next: string) => void, () => void] {
  const [email, setEmail] = useState("");
  const reset = useCallback(() => {
    setEmail("");
  }, []);
  return [email, setEmail, reset];
}
