import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./styles/tokens.css";
import "./styles/base.css";
import { router } from "./router.tsx";

// biome-ignore lint/style/noNonNullAssertion: standard React root — element always present in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
