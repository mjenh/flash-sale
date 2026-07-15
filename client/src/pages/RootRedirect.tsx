// AC1's `/` route. Story 5.3 owns the real backend integration and final
// copy/behavior; this story wires the shape it will extend: a dedicated hook
// (useActiveSaleRedirect) does the fetch + navigate, and this component only
// renders the placeholder for each of that hook's states. No flash of
// content while loading — the noon-yellow field (styles/base.css) is already
// the page background, so an empty/near-empty body reads as "still loading",
// not broken.
import { useActiveSaleRedirect } from "../hooks/useActiveSaleRedirect.ts";
import "./RootRedirect.css";

export const NO_ACTIVE_SALE_MESSAGE = "No active sale right now. Check back soon.";

export function RootRedirect() {
  const state = useActiveSaleRedirect();

  if (state.status === "unavailable") {
    return (
      <div className="frame root-redirect">
        <p className="t-body root-redirect__message" data-testid="no-active-sale">
          {NO_ACTIVE_SALE_MESSAGE}
        </p>
      </div>
    );
  }

  // "loading" and "redirecting" both render nothing visible — just the
  // noon-yellow field — plus a polite screen-reader-only status so assistive
  // tech isn't left silent during the beat before navigate() lands.
  return (
    <div className="frame root-redirect" aria-busy="true">
      <p className="visually-hidden" role="status">
        Finding the sale…
      </p>
    </div>
  );
}
