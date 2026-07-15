// AC1's generic `*` catch-all — an unmatched path (a typo, a stale bookmark to
// a route shape that never existed, etc). Deliberately separate from the
// `/sale/:slug` route's own "Sale not found" state (SalePage.tsx,
// SALE_NOT_FOUND_HEADLINE) — that one names the specific slug that failed to
// resolve; this one has no slug to name at all.
import { Link } from "react-router-dom";
import "./NotFoundPage.css";

export const NOT_FOUND_HEADLINE = "Page not found.";

export function NotFoundPage() {
  return (
    <div className="frame not-found-page">
      <h1 className="t-display not-found-page__headline">{NOT_FOUND_HEADLINE}</h1>
      <p className="t-body not-found-page__body">
        There&apos;s nothing at this address.
      </p>
      <Link className="t-action not-found-page__home" to="/">
        Take me to the sale
      </Link>
    </div>
  );
}
