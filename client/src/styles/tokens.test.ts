// Token exactness, proven from the stylesheets themselves. jsdom does not
// resolve custom properties from imported sheets, so computed-style assertions
// would be theatre — reading the CSS is the honest gate. This test also guards
// the system's negative space: no true black, no off-palette hex, no dark
// mode, no soft gradients, no blurred shadows.
//
// `?raw` imports keep this a Vite-native test — no node:fs, no @types/node.
import { describe, expect, it } from "vitest";
import tokensCss from "./tokens.css?raw";
import baseCss from "./base.css?raw";
import marqueeCss from "../components/MarqueeBand.css?raw";

/** Comments are prose — they may name what the system forbids ("true #000
 *  never appears"). The rules are what we assert against. */
function rules(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// The gate reads EVERY stylesheet in the client, derived at load time — not a
// hand-maintained list that silently omits sheets added by later stories (and
// lets off-palette values in them pass green). `?raw` keeps it Vite-native.
const CSS_MODULES = import.meta.glob("../**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SHEETS: [name: string, css: string][] = Object.entries(CSS_MODULES).map(
  ([path, css]) => [path.split("/").pop() ?? path, css],
);

const COLORS: Record<string, string> = {
  ink: "#1a1408",
  "noon-yellow": "#ffcf33",
  "yellow-lifted": "#ffdd66",
  cream: "#fff3d6",
  tomato: "#e8481f",
  "tomato-deep": "#c03a17",
  "pool-teal": "#1f7a8c",
  "paper-white": "#ffffff",
  "ink-soft": "#3d3312",
  "olive-deep": "#5c4f22",
  "olive-shade": "#6b5a28",
  "sand-mute": "#9c8f63",
};

describe("design tokens", () => {
  it("carries all 12 colors at their exact hexes", () => {
    for (const [name, hex] of Object.entries(COLORS)) {
      expect(tokensCss).toContain(`--${name}: ${hex};`);
    }
  });

  it("carries all 10 type roles with their exact size/weight/line-height/tracking", () => {
    for (const decl of [
      "--display-size: 84px;",
      "--display-weight: 900;",
      "--display-line: 0.95;",
      "--display-tracking: -3px;",
      "--numeral-size: 118px;",
      "--numeral-weight: 900;",
      "--numeral-line: 0.85;",
      "--numeral-tracking: -5px;",
      "--headline-size: 56px;",
      "--headline-weight: 900;",
      "--headline-line: 0.95;",
      "--headline-tracking: -2px;",
      "--action-size: 26px;",
      "--action-weight: 900;",
      "--action-tracking: 0.5px;",
      "--label-size: 15px;",
      "--label-weight: 900;",
      "--label-tracking: 1.5px;",
      "--body-size: 17px;",
      "--body-weight: 600;",
      "--body-line: 1.5;",
      "--meta-size: 13px;",
      "--meta-weight: 600;",
      "--meta-line: 1.55;",
      "--mono-size: 16px;",
      "--mono-weight: 700;",
      "--mono-tracking: 0.5px;",
      "--marquee-size: 13px;",
      "--marquee-weight: 800;",
      "--marquee-tracking: 3px;",
      "--chip-size: 11.5px;",
      "--chip-weight: 900;",
      "--chip-tracking: 1px;",
    ]) {
      expect(tokensCss).toContain(decl);
    }
    expect(tokensCss).toContain("ui-monospace");
    expect(tokensCss).toContain("-apple-system");
  });

  it("carries the radii, spacing, and the 8/6/4 shadow ramp", () => {
    for (const decl of [
      "--r-sm: 6px;",
      "--r-md: 8px;",
      "--r-lg: 10px;",
      "--r-xl: 12px;",
      "--r-full: 9999px;",
      "--r-tile: 34px;",
      "--sp-unit: 8px;",
      "--sp-stack: 16px;",
      "--sp-panel: 28px;",
      "--sp-zone: 40px;",
      "--sp-gutter: 48px;",
      "--shadow-panel: 8px 8px 0 var(--ink);",
      "--shadow-action: 6px 6px 0 var(--ink);",
      "--shadow-sticker: 4px 4px 0 var(--ink);",
      "--border-ink: 3px solid var(--ink);",
      "--border-disabled: 3px dashed var(--ink);",
      "--frame-max: 1160px;",
    ]) {
      expect(tokensCss).toContain(decl);
    }
  });

  it("declares the one focus rule: 3px pool-teal at 2px offset", () => {
    expect(baseCss).toContain("outline: 3px solid var(--pool-teal);");
    expect(baseCss).toContain("outline-offset: 2px;");
  });

  it("restricts uppercase to the display/headline/label/marquee/chip roles", () => {
    const uppercased = [
      ...rules(baseCss).matchAll(/\.t-([a-z]+)\s*\{[^}]*text-transform:\s*uppercase/g),
    ].map((m) => m[1]);
    expect(uppercased.sort()).toEqual(["chip", "display", "headline", "label", "marquee"]);
  });
});

describe("design-token negative space", () => {
  it("never uses true black, and never a hex outside the palette", () => {
    const palette = new Set(Object.values(COLORS));
    for (const [name, css] of SHEETS) {
      const declared = rules(css).toLowerCase();
      expect(declared, name).not.toMatch(/#000\b|#000000\b|:\s*black\b/);
      for (const hex of declared.match(/#[0-9a-f]{3,8}\b/g) ?? []) {
        expect(palette.has(hex), `${name} uses off-palette hex ${hex}`).toBe(true);
      }
    }
  });

  it("ships no dark mode", () => {
    for (const [name, css] of SHEETS) {
      expect(rules(css), name).not.toContain("prefers-color-scheme");
    }
  });

  it("uses exactly one gradient — the 12% ink stripe texture for waiting states", () => {
    const gradients = SHEETS.flatMap(([, css]) => rules(css).match(/gradient\(/g) ?? []);
    expect(gradients).toHaveLength(1);
    expect(baseCss).toContain("repeating-linear-gradient(");
    expect(baseCss).toContain("135deg");
    expect(baseCss).toContain("12%");
  });

  it("keeps shadows hard: only the ink offsets on the 8/6/4 ramp, or none", () => {
    for (const [name, css] of SHEETS) {
      for (const shadow of rules(css).match(/box-shadow:\s*([^;]+);/g) ?? []) {
        expect(shadow, name).toMatch(/none|var\(--shadow-(panel|action|sticker)\)/);
      }
    }
  });

  it("honors reduced motion: every animation can stop", () => {
    expect(baseCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(marqueeCss).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
