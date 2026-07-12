import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SaleState } from "../api/sale.ts";
import type { Verdict } from "../api/order.ts";
import { ALREADY_FRAME, SUCCESS_FRAME, VerdictPanel } from "./VerdictPanel.tsx";
import { ENDED_FRAME, SOLD_OUT_FRAME, UPCOMING_FRAME } from "./SaleStatusZone.tsx";

afterEach(() => {
  cleanup();
});

function show(verdict: Verdict, saleState: SaleState | null = "active") {
  return render(<VerdictPanel verdict={verdict} saleState={saleState} />);
}

describe("the seven treatments — verbatim string, warm frame", () => {
  it("Order successful. → the celebration flag", () => {
    show({ kind: "success", message: "Order successful." });

    expect(screen.getByTestId("verdict-string").textContent).toBe("Order successful.");
    expect(screen.getByTestId("verdict-flag").textContent).toBe(SUCCESS_FRAME);
    expect(SUCCESS_FRAME).toBe("It's yours!");
  });

  it("You have already ordered this item. → the reassurance frame", () => {
    show({ kind: "already", message: "You have already ordered this item." });

    expect(screen.getByTestId("verdict-string").textContent).toBe(
      "You have already ordered this item.",
    );
    expect(screen.getByTestId("verdict-frame").textContent).toBe(ALREADY_FRAME);
    expect(ALREADY_FRAME).toBe("All set — your order from today is safe.");
    // Success family, but no celebration — you already won, quietly.
    expect(screen.queryByTestId("verdict-flag")).toBeNull();
  });

  it("Item is sold out. → the sympathetic rejection, no red alarm for losing fairly", () => {
    const { container } = show({ kind: "sold_out", message: "Item is sold out." });

    expect(screen.getByTestId("verdict-string").textContent).toBe("Item is sold out.");
    expect(screen.getByTestId("verdict-frame").textContent).toBe(SOLD_OUT_FRAME);
    expect(container.querySelector(".verdict-panel--reject")).not.toBeNull();
  });

  it("Sale is not active. → the client renders the distinction the API cannot", () => {
    const verdict: Verdict = { kind: "inactive", message: "Sale is not active." };

    const { rerender } = show(verdict, "upcoming");
    expect(screen.getByTestId("verdict-frame").textContent).toBe(UPCOMING_FRAME);

    rerender(<VerdictPanel verdict={verdict} saleState="ended" />);
    expect(screen.getByTestId("verdict-frame").textContent).toBe(ENDED_FRAME);

    // The verbatim string never changes — only the frame around it does.
    expect(screen.getByTestId("verdict-string").textContent).toBe("Sale is not active.");
  });

  it("Service temporarily unavailable. → error accent, no warm frame, no blame", () => {
    const { container } = show({
      kind: "unavailable",
      message: "Service temporarily unavailable.",
    });

    expect(screen.getByTestId("verdict-string").textContent).toBe(
      "Service temporarily unavailable.",
    );
    expect(screen.queryByTestId("verdict-frame")).toBeNull();
    expect(container.querySelector(".verdict-panel--error")).not.toBeNull();
  });

  it("Something went wrong, please try again. → the string IS the message", () => {
    show({ kind: "network", message: "Something went wrong, please try again." });

    expect(screen.getByTestId("verdict-string").textContent).toBe(
      "Something went wrong, please try again.",
    );
    expect(screen.queryByTestId("verdict-frame")).toBeNull();
  });
});

describe("the panel's manners", () => {
  it("takes focus when it lands — the focus move IS the announcement", () => {
    show({ kind: "success", message: "Order successful." });

    const panel = screen.getByTestId("verdict-panel");
    expect(panel).toHaveFocus();
    expect(panel).toHaveAttribute("aria-label", "Your order verdict");
  });

  it("carries NO aria-live — announcing twice is the bug", () => {
    const { container } = show({ kind: "success", message: "Order successful." });

    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("distinguishes its variants without color: composition differs too (SM-5)", () => {
    const fingerprints = new Set<string>();

    for (const verdict of [
      { kind: "success", message: "Order successful." },
      { kind: "already", message: "You have already ordered this item." },
      { kind: "sold_out", message: "Item is sold out." },
      { kind: "unavailable", message: "Service temporarily unavailable." },
    ] as Verdict[]) {
      cleanup();
      show(verdict);
      fingerprints.add(
        [
          screen.getByTestId("verdict-string").textContent,
          screen.queryByTestId("verdict-frame")?.textContent ?? "no-frame",
          screen.queryByTestId("verdict-flag") !== null,
        ].join("|"),
      );
    }

    expect(fingerprints.size).toBe(4);
  });
});
