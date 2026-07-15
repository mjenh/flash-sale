import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_FOUND_HEADLINE, NotFoundPage } from "./NotFoundPage.tsx";

afterEach(() => {
  cleanup();
});

describe("NotFoundPage", () => {
  it("renders a friendly generic message with a way back home", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: NOT_FOUND_HEADLINE })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /take me to the sale/i })).toHaveAttribute("href", "/");
  });
});
