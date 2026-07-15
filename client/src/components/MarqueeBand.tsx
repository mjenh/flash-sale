import "./MarqueeBand.css";

export const HOUSE_RULES =
  "flash sale . keycap one . live drop";

export function MarqueeBand() {
  return (
    <div className="marquee-band" aria-hidden="true">
      <div className="marquee-band__track">
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
        <span className="marquee-band__run t-marquee">{HOUSE_RULES}</span>
      </div>
    </div>
  );
}
