import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.tsx";

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("renders the skeleton page", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Flash Sale" })).toBeDefined();
  });
});
