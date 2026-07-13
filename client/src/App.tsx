// The Noon Poster page, complete: the live status zone (Story 2.2) and the Buy
// Now flow with its verdicts (Story 2.3).
//
// The identifier field and Buy Now live inside a real <form>, so Enter from the
// field and a click on the button are literally the same submit path — and
// Enter is inert while the button is disabled, for free, because browsers do
// not submit a form through a disabled submit button.
import { useEffect, useRef } from "react";
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
import { VerdictPanel } from "./components/VerdictPanel.tsx";
import { useSaleStatus } from "./hooks/useSaleStatus.ts";
import { useOrder } from "./hooks/useOrder.ts";
import { useRememberedEmail } from "./hooks/useRememberedEmail.ts";
import type { SaleStatusBody } from "./api/sale.ts";

export const UPCOMING_BUTTON_REASON =
  "The button naps until noon — type your email now so you're ready when it wakes.";
export const PROCESSING_LINE = "Hang tight — checking stock for you…";

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
  const { body, channel, refetch } = useSaleStatus();
  const [email, setEmail] = useRememberedEmail();
  // FR-5: the status re-fetches after EVERY attempt — win, loss, or error.
  const { phase, verdict, fieldError, submit, checkOnLoad, clearVerdict } = useOrder({
    onAttemptSettled: refetch,
  });

  // UJ-2: relief in a single page-load. Silent if the check itself fails.
  // Only the REMEMBERED email is checked — never one being typed right now.
  const rememberedOnLoad = useRef(email);
  useEffect(() => {
    checkOnLoad(rememberedOnLoad.current);
  }, [checkOnLoad]);

  const processing = phase === "processing";
  // The processing button is NOT `disabled`: disabling a focused control blurs
  // it, and focus must stay on the button through the beat. It is aria-busy,
  // and the hook's in-flight guard is what makes a second click a no-op.
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
              One limited-run mechanical keyboard.
            </p>

            <SaleStatusZone body={body} channel={channel} />
          </div>

          <div className="poster__action">
            <ProductTile />

            <Panel variant="yellow-lifted" className="form-panel">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  // Browsers already refuse implicit submission through a
                  // disabled default button; this makes the rule explicit
                  // rather than inherited — Enter is inert exactly when the
                  // button is.
                  if (!canBuy) {
                    return;
                  }
                  submit(email);
                }}
                noValidate
              >
                <label className="t-label form-panel__label" htmlFor="email">
                  Who&apos;s buying?
                </label>
                <input
                  id="email"
                  className={`t-mono identifier-input${
                    fieldError === null ? "" : " identifier-input--error"
                  }`}
                  type="email"
                  name="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  aria-invalid={fieldError !== null}
                  aria-describedby={fieldError === null ? "email-help" : "email-error"}
                />
                {fieldError === null ? null : (
                  // Anchored at the field, not in the verdict panel — and the
                  // message is ink beside a tomato mark, never color alone.
                  <p className="t-body identifier-error" id="email-error" data-testid="field-error">
                    <span className="identifier-error__mark" aria-hidden="true" />
                    {fieldError}
                  </p>
                )}
                <p className="t-meta form-panel__help">
                </p>

                <div className="buy-now-zone">
                  <button
                    type="submit"
                    className={`t-action buy-now pressable${processing ? " buy-now--processing" : ""}`}
                    disabled={!canBuy}
                    aria-busy={processing}
                  >
                    {processing ? <span className="buy-now__spinner" aria-hidden="true" /> : null}
                    Buy Now
                  </button>
                  {body?.status === "upcoming" && !processing ? (
                    <span className="t-chip not-yet-tag">Not yet</span>
                  ) : null}
                </div>

                {processing ? (
                  <p className="t-body buy-now-reason" data-testid="processing-line">
                    {PROCESSING_LINE}
                  </p>
                ) : reason === null ? null : (
                  <p className="t-body buy-now-reason" data-testid="buy-now-reason">
                    {reason}
                  </p>
                )}
              </form>

              <RulesChips />
            </Panel>

            {/* The verdict is a modal pop-up over a dimmed backdrop. */}
            {verdict === null ? null : (
              <VerdictPanel
                verdict={verdict}
                saleState={body?.status ?? null}
                onClose={clearVerdict}
              />
            )}
          </div>
        </main>
      </div>
    </>
  );
}
