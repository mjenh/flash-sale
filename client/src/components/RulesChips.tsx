// The static, always-visible twin of the marquee — and its accessibility and
// reduced-motion home. The crawl is aria-hidden; these chips are not.
import "./RulesChips.css";

export const RULES = ["One each", "First come", "Straight answer"] as const;

export function RulesChips() {
  return (
    <ul className="rules-chips" aria-label="House rules">
      {RULES.map((rule) => (
        <li key={rule} className="rules-chips__chip t-chip">
          {rule}
        </li>
      ))}
    </ul>
  );
}
