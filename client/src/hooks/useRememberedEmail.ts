// The email is remembered so the page can answer "did it go through?" on a
// single load (UJ-2). It is a convenience, never a correctness mechanism — the
// server's Redis set is the truth — and it is NEVER cleared: not by a
// rejection, not by an error, not by a reload.
//
// Every storage access is try/caught: a browser with storage disabled degrades
// to an in-memory value rather than throwing on first paint.
import { useCallback, useState } from "react";

export const EMAIL_KEY = "flash-sale:email";

function read(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function useRememberedEmail(): [string, (next: string) => void] {
  const [email, setEmailState] = useState<string>(read);

  const setEmail = useCallback((next: string) => {
    setEmailState(next);
    try {
      localStorage.setItem(EMAIL_KEY, next);
    } catch {
      // In-memory only. The page still works.
    }
  }, []);

  return [email, setEmail];
}
