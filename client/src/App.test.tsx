import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";
import { HOUSE_RULES } from "./components/MarqueeBand.tsx";

afterEach(() => {
  cleanup();
});

describe("Noon Poster shell", () => {
  it("crawls the house rules and nothing else — aria-hidden, with the chips as its readable twin", () => {
    const { container } = render(<App />);

    const band = container.querySelector(".marquee-band");
    expect(band).toBeInTheDocument();
    expect(band).toHaveAttribute("aria-hidden", "true");
    expect(band?.textContent).toContain(HOUSE_RULES);
    expect(HOUSE_RULES).toBe(
      "one each · fair and square · no carts · no queue-jumping · server clock rules",
    );

    // The always-visible static twin — not aria-hidden.
    const chips = screen.getByRole("list", { name: "House rules" });
    expect(chips).toBeInTheDocument();
    for (const rule of ["One each", "First come", "Straight answer"]) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
  });

  it("renders the masthead brand line with an empty date slot until the server reports the window", () => {
    render(<App />);

    expect(screen.getByText("Keycap·One presents")).toBeInTheDocument();
    // Honest by construction: no fabricated date before the status fetch.
    expect(screen.getByTestId("masthead-date").textContent).toBe("");
  });

  it("renders the poster furniture: hero copy, product tile, and the status panel", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The Noon Drop");
    expect(
      screen.getByText(/One limited-run mechanical keyboard\. One per person/),
    ).toBeInTheDocument();
    expect(container.querySelector(".product-tile")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Doors at noon.")).toBeInTheDocument();
  });

  it("renders the identifier zone and a Buy Now that is disabled and honestly labelled", () => {
    render(<App />);

    expect(screen.getByLabelText("Who's buying?")).toHaveAttribute(
      "placeholder",
      "you@example.com",
    );
    expect(screen.getByText("Email. That's the whole form, promise.")).toBeInTheDocument();

    // The label is exactly "Buy Now" in every state — never CSS-uppercased.
    const buyNow = screen.getByRole("button", { name: "Buy Now" });
    expect(buyNow).toBeDisabled();
    expect(buyNow.textContent).toBe("Buy Now");
    expect(screen.getByText("Not yet")).toBeInTheDocument();
  });

  it("holds the load-bearing negative space", () => {
    const { container } = render(<App />);
    const text = container.textContent ?? "";

    // Ruling: visible copy never states the total stock count. The only glyph
    // with a digit on the shell is the decorative keycap mark "K1".
    expect(text).not.toContain("100");
    expect(text.replace("K1", "")).not.toMatch(/\d/);

    // No countdown, no verdict, no nav/router, no modal, no skeleton.
    // (The marquee legitimately chants "no carts" — that IS the negative space.)
    expect(container.querySelector(".countdown")).toBeNull();
    expect(container.querySelector(".verdict-panel")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();

    // Exactly one action on the page.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
