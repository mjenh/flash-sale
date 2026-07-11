import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("renders the title and backend status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: "Flash Sale" })).toBeDefined();
    expect(await screen.findByText("Backend: up")).toBeDefined();
  });
});
