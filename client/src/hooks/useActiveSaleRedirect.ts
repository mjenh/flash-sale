// AC1's `/` root route: discover "the active sale" and redirect to
// `/sale/${slug}`. `GET /api/sales/active` is Story 5.3's endpoint to build
// out fully (richer fallback copy, etc) — this hook calls it defensively
// today (the response shape it expects — `{ success, slug }` — is exactly
// Story 5.3's documented AC) and treats ANY failure (network error, 404 "no
// sales configured", a malformed body) the same way: give up gracefully and
// report `"unavailable"` rather than leaving the caller on a spinner forever.
//
// Deliberately isolated in its own hook (rather than inlined in a page
// component) per the Story 5.1 design guidance: Story 5.3 can swap this
// hook's internals (nicer fallback copy, a loader route, etc.) without
// touching `RootRedirect.tsx`'s render logic at all.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export const ACTIVE_SALE_URL = "/api/sales/active";

export type ActiveSaleRedirectState =
  | { status: "loading" }
  | { status: "redirecting" }
  | { status: "unavailable" };

function parseActiveSaleSlug(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.success !== true || typeof record.slug !== "string" || record.slug === "") {
    return null;
  }
  return record.slug;
}

/** Fetches the active sale's slug and navigates to `/sale/${slug}` on
 *  success. Returns the loading/redirecting/unavailable state so the caller
 *  can render an appropriate placeholder — the hook never renders anything
 *  itself. */
export function useActiveSaleRedirect(): ActiveSaleRedirectState {
  const navigate = useNavigate();
  const [state, setState] = useState<ActiveSaleRedirectState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    void fetch(ACTIVE_SALE_URL, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`active sale unavailable (${res.status})`);
        }
        const slug = parseActiveSaleSlug(await res.json());
        if (slug === null) {
          throw new Error("active sale response was not the expected shape");
        }
        return slug;
      })
      .then((slug) => {
        if (cancelled) {
          return;
        }
        setState({ status: "redirecting" });
        navigate(`/sale/${encodeURIComponent(slug)}`, { replace: true });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setState({ status: "unavailable" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `navigate` is referentially stable across renders (react-router-dom),
    // so this effect runs exactly once per mount.
  }, [navigate]);

  return state;
}
