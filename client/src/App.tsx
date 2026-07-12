// The Noon Poster shell (Story 2.1): marquee band, masthead, and the two-column
// poster. Three seams are reserved and explicitly marked:
//
//   SALE STATUS SLOT  → Story 2.2 replaces the panel BODY with the live
//                       four-state machine. The Panel chrome stays.
//   IDENTIFIER + BUY NOW SLOTS → Story 2.3 wires behavior onto this markup.
//                       Everything here is visually correct and behaviorally
//                       dead: no state, no handler, no fetch.
//   VERDICT SLOT      → absent until the first verdict (Story 2.3 mounts it).
import "./App.css";
import { MarqueeBand } from "./components/MarqueeBand.tsx";
import { Masthead } from "./components/Masthead.tsx";
import { Panel } from "./components/Panel.tsx";
import { ProductTile } from "./components/ProductTile.tsx";
import { RulesChips } from "./components/RulesChips.tsx";

export function App() {
  return (
    <>
      <MarqueeBand />
      <div className="frame">
        {/* Date line arrives with the status fetch (Story 2.2) — until then the
            slot is empty rather than fabricated. */}
        <Masthead />

        <main className="poster">
          <div className="poster__hero">
            <h1 className="t-display hero__headline">
              The <span className="hero__hollow">Noon</span> Drop
            </h1>
            <p className="t-body hero__sub">
              One limited-run mechanical keyboard. One per person — and the counter on this page is
              the honest, living truth.
            </p>

            {/* ── SALE STATUS SLOT (Story 2.2) ─────────────────────────── */}
            <Panel variant="poster" className="stripes status-panel">
              <p className="t-headline status-panel__headline">Doors at noon.</p>
            </Panel>
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

              {/* ── BUY NOW SLOT (Story 2.3 wires it) ──────────────────── */}
              <div className="buy-now-zone">
                <button type="button" className="t-action buy-now pressable" disabled>
                  Buy Now
                </button>
                <span className="t-chip not-yet-tag">Not yet</span>
              </div>

              <RulesChips />
            </Panel>

            {/* ── VERDICT SLOT (Story 2.3) — absent until the first verdict. */}
          </div>
        </main>
      </div>
    </>
  );
}
