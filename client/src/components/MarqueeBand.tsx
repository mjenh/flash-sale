// Ambient fairness: the house rules chanted in public. House-rules content
// ONLY — never urgency copy, never a countdown, never a price, never the total
// stock count (ruling). The crawl is aria-hidden; RulesChips is its
// always-visible, always-readable twin.
import "./MarqueeBand.css";

export const HOUSE_RULES =
  "one each · fair and square · no carts · no queue-jumping · server clock rules";

export function MarqueeBand() {
  return (
    <div className="marquee-band" aria-hidden="true">
      <div className="marquee-band__track">
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
      </div>
    </div>
  );
}
