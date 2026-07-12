// The Noon Poster page. Story 2.1 built the shell; Story 2.2 makes the status
// zone live (SSE with a polling fallback, honest about which channel it's on).
//
//   IDENTIFIER + BUY NOW SLOTS → Story 2.3 wires submit, the processing beat,
//                                and the verdict. The button's ENABLED/DISABLED
//                                state and its honest reason line are already
//                                driven by the sale state here; what's missing
//                                is behavior, not truth.
//   VERDICT SLOT               → absent until the first verdict (Story 2.3).
import "./App.css";
import { MarqueeBand } from "./components/MarqueeBand.tsx";
import { Masthead } from "./components/Masthead.tsx";
import { Panel } from "./components/Panel.tsx";
import { ProductTile } from "./components/ProductTile.tsx";
import { RulesChips } from "./components/RulesChips.tsx";
import {
  COLD_LOAD_LINE,
  ENDED_FRAME,
  SOLD_OUT_FRAME,
  SaleStatusZone,
} from "./components/SaleStatusZone.tsx";
import { useSaleStatus } from "./hooks/useSaleStatus.ts";
import type { SaleStatusBody } from "./api/sale.ts";

export const UPCOMING_BUTTON_REASON =
  "The button naps until noon — type your email now so you're ready when it wakes.";

/** The honest reason a dead button is dead. Never a fake affordance, never a
 *  disappearing act — and never color alone. */
function buttonReason(body: SaleStatusBody | null): string | null {
  if (body === null) {
    return COLD_LOAD_LINE;
  }
  switch (body.status) {
    case "upcoming":
      return UPCOMING_BUTTON_REASON;
    case "sold_out":
      return SOLD_OUT_FRAME;
    case "ended":
      return ENDED_FRAME;
    case "active":
      return null;
  }
}

export function App() {
  // `refetch` is the seam Story 2.3 calls after every order attempt (FR-5:
  // status re-fetches on page load and after every attempt).
  const { body, channel } = useSaleStatus();

  const canBuy = body?.status === "active";
  const reason = buttonReason(body);

  return (
    <>
      <MarqueeBand />
      <div className="frame">
        <Masthead startTime={body?.startTime} />

        <main className="poster">
          <div className="poster__hero">
            <h1 className="t-display hero__headline">
              The <span className="hero__hollow">Noon</span> Drop
            </h1>
            <p className="t-body hero__sub">
              One limited-run mechanical keyboard. One per person — and the counter on this page is
              the honest, living truth.
            </p>

            <SaleStatusZone body={body} channel={channel} />
          </div>

          <div className="poster__action">
            <ProductTile />

            <Panel variant="yellow-lifted" className="form-panel">
              {/* ── IDENTIFIER SLOT (Story 2.3 wires it) ───────────────── */}
              <label className="t-label form-panel__label" htmlFor="email">
                Who&apos;s buying?
              </label>
              <input
                id="email"
                className="t-mono identifier-input"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
              />
              <p className="t-meta form-panel__help">Email. That&apos;s the whole form, promise.</p>

              {/* ── BUY NOW SLOT (Story 2.3 wires submit) ──────────────── */}
              <div className="buy-now-zone">
                <button type="button" className="t-action buy-now pressable" disabled={!canBuy}>
                  Buy Now
                </button>
                {body?.status === "upcoming" ? (
                  <span className="t-chip not-yet-tag">Not yet</span>
                ) : null}
              </div>
              {reason === null ? null : (
                <p className="t-body buy-now-reason" data-testid="buy-now-reason">
                  {reason}
                </p>
              )}

              <RulesChips />
            </Panel>

            {/* ── VERDICT SLOT (Story 2.3) — absent until the first verdict. */}
          </div>
        </main>
      </div>
    </>
  );
}
