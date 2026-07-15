// The identifier field and Buy Now live inside a real <form>, so Enter from the
// field and a click on the button are literally the same submit path — and
// Enter is inert while the button is disabled, for free, because browsers do
// not submit a form through a disabled submit button.
//
// Story 5.1: this file is the renamed/relocated `App.tsx` — the full Noon
// Poster experience, now parameterized by `slug` instead of assuming one
// implicit sale. `SalePage` itself takes `slug` as a plain prop (rather than
// calling `useParams()` internally) so it stays trivially testable in
// isolation, exactly as `App` was; `SalePageRoute` below is the thin
// route-level wrapper that extracts `slug` from the URL via `useParams()`
// (AC2) and hands it down. Every behavioral/accessibility invariant from
// Epics 1-3 is unchanged — only the URL construction (via the slug) and the
// new "Sale not found" state (AC3) are new.
import { useParams } from "react-router-dom";
import "./SalePage.css";
import { MarqueeBand } from "../components/MarqueeBand.tsx";
import { Masthead } from "../components/Masthead.tsx";
import { Panel } from "../components/Panel.tsx";
import { ProductTile } from "../components/ProductTile.tsx";
import { RulesChips } from "../components/RulesChips.tsx";
import {
  ENDED_FRAME,
  SOLD_OUT_FRAME,
  SaleStatusZone,
} from "../components/SaleStatusZone.tsx";
import { VerdictPanel } from "../components/VerdictPanel.tsx";
import { useSaleStatus } from "../hooks/useSaleStatus.ts";
import { useOrder } from "../hooks/useOrder.ts";
import { useEmailField } from "../hooks/useEmailField.ts";
import type { SaleStatusBody } from "../api/sale.ts";
import { NotFoundPage } from "./NotFoundPage.tsx";

export const UPCOMING_BUTTON_REASON =
  "The button naps until noon — type your email now so you're ready when it wakes.";
export const PROCESSING_LINE = "Hang tight — checking stock for you…";
/** The disabled reason during the brief cold-load window — status not read yet
 *  (channel `connecting`), or the stream is down and a poll has not landed a
 *  body yet (`degraded` with no body). Confirmed offline fails open instead:
 *  the button is enabled, so there is no dead button to explain. */
export const COLD_LOAD_BUTTON_REASON = "Hang tight — reading the sale before the button opens.";

/** AC3: the friendly, non-broken state for a slug that names no sale. Kept
 *  simple and deliberately distinct from the generic `*` 404 (NotFoundPage) —
 *  this one is a `/sale/:slug` route result, not an unmatched path, so it
 *  names the slug the buyer typed/followed. */
export const SALE_NOT_FOUND_HEADLINE = "Sale not found.";

/** The honest reason a dead button is dead. Never a fake affordance, never a
 *  disappearing act — and never color alone. When the status is unknown
 *  (body === null) the button carries no disabled reason: during cold load
 *  nothing is wrong yet, and on a confirmed outage we fail open and let the
 *  server's verdict speak — there is no dead button to explain (the
 *  "Can't reach the sale — retrying..." context still shows in the status zone). */
function buttonReason(body: SaleStatusBody | null): string | null {
  if (body === null) {
    return null;
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

export interface SalePageProps {
  /** The sale this page renders — extracted from the route by `SalePageRoute`,
   *  or passed directly in tests. */
  slug: string;
}

export function SalePage({ slug }: SalePageProps) {
  const { body, channel, notFound, refetch } = useSaleStatus(slug);
  const [email, setEmail] = useEmailField();
  // Re-fetch sale status after every attempt — win, loss, or error.
  const { phase, verdict, verdictSource, fieldError, submit, clearFieldError, clearVerdict } =
    useOrder({
      slug,
      onAttemptSettled: refetch,
    });

  // The identifier field is session-only and is NEVER cleared by an attempt
  // outcome — win, already-ordered, sold-out, sale-not-active, 503 or network
  // all leave the value in place so the buyer can re-check or retry without
  // retyping. It clears only on a real page-level reset: a refresh/reload, a new
  // tab, a new window, or an incognito session — because the value lives purely
  // in in-memory React state and is never persisted.

  const processing = phase === "processing";
  // The processing button is NOT `disabled`: disabling a focused control blurs
  // it, and focus must stay on the button through the beat. It is aria-busy,
  // and the hook's in-flight guard is what makes a second click a no-op.
  //
  // Buy Now is enabled when the sale is known-active, AND — fail-open — when
  // the status is unknown because the read channel is down (body null +
  // offline). Blocking a purchase the API would accept just because the *status*
  // path broke is wrong; the server answers every attempt authoritatively
  // (201 / "already" / "sold out" / "not active" / 503), so letting it through
  // is safe and honest. Known-inactive states (upcoming/ended/sold_out) and the
  // brief cold-load `connecting` window stay disabled — no flicker, no surprise.
  const canBuy = body === null ? channel === "offline" : body.status === "active";
  // Every disabled state carries an honest reason. When the status is
  // known (body !== null) that is the per-state line; when it is unknown and the
  // button is still disabled (connecting / degraded before a body lands) it is
  // the cold-load line. Offline fails open — canBuy is true, so no reason.
  const reason = canBuy ? null : (buttonReason(body) ?? COLD_LOAD_BUTTON_REASON);

  // AC3: a slug that names no sale renders a friendly, non-broken state
  // instead of the Noon Poster shell. This is a terminal outcome from
  // useSaleStatus (a confirmed 404, not a transient outage), so it takes
  // priority over every other channel/body state.
  if (notFound) {
    return (
      <div className="frame sale-not-found">
        <h1 className="t-display sale-not-found__headline">{SALE_NOT_FOUND_HEADLINE}</h1>
        <p className="t-body sale-not-found__body" data-testid="sale-not-found">
          There&apos;s no sale at &ldquo;{slug}&rdquo;. Double-check the link, or ask whoever
          shared it for the right one.
        </p>
      </div>
    );
  }

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
                  // button is. Native constraint validation stays ON (no
                  // `noValidate`): the type="email" field validates the address
                  // shape in the browser before this handler runs. Empty is not
                  // blocked here (the field is not `required`) so the hook can
                  // own the anchored "Email is required." message.
                  if (!canBuy) {
                    return;
                  }
                  submit(email);
                }}
              >
                <label className="t-label form-panel__label" htmlFor="email">
                  Who&apos;s buying?
                </label>
                <input
                  id="email"
                  className={`t-mono identifier-input${
                    fieldError === null ? "" : " identifier-input--error"
                  }`}
                  // An email field: the sale is email-native, so the
                  // input validates the address shape in the browser (type=email
                  // + the email inputMode keyboard). Length is still bounded (the
                  // server rejects > 256); maxLength stops it at the source.
                  type="email"
                  inputMode="email"
                  name="email"
                  autoComplete="email"
                  maxLength={256}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    // A corrected email clears its own error — the tomato mark
                    // and aria-invalid must not persist over a fixed value.
                    if (fieldError !== null) {
                      clearFieldError();
                    }
                  }}
                  aria-invalid={fieldError !== null}
                  // The help text stays associated even in the error state; the
                  // error id is appended, never a replacement for it.
                  aria-describedby={fieldError === null ? "email-help" : "email-help email-error"}
                />
                {fieldError === null ? null : (
                  // Anchored at the field, not in the verdict panel — and the
                  // message is ink beside a tomato mark, never color alone.
                  <p className="t-body identifier-error" id="email-error" data-testid="field-error">
                    <span className="identifier-error__mark" aria-hidden="true" />
                    {fieldError}
                  </p>
                )}
                <p className="t-meta form-panel__help" id="email-help">
                  Email. That&apos;s the whole form, promise.
                </p>

                <div className="buy-now-zone">
                  <button
                    type="submit"
                    className={`t-action buy-now pressable${processing ? " buy-now--processing" : ""}`}
                    // Never disable a focused, in-flight button: if the last unit
                    // sells mid-request, the sold_out frame must not blur the
                    // button and drop focus to the body.
                    disabled={!canBuy && !processing}
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

            {verdict === null ? null : (
              <VerdictPanel
                verdict={verdict}
                saleState={body?.status ?? null}
                onClose={clearVerdict}
                focusOnMount={verdictSource === "submit"}
              />
            )}
          </div>
        </main>
      </div>
    </>
  );
}

/** AC2: the route-level wrapper — extracts `slug` from `useParams()` and hands
 *  it to `SalePage`. Kept separate from `SalePage` so the presentational
 *  component stays free of any router dependency and is directly testable
 *  with a plain `slug` prop. A route pattern of `/sale/:slug` always supplies
 *  a non-empty `slug`; the `NotFoundPage` fallback below is defensive-only. */
export function SalePageRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (typeof slug !== "string" || slug === "") {
    return <NotFoundPage />;
  }
  return <SalePage slug={slug} />;
}
