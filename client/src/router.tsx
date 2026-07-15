// AC1's three routes, in one place. `routeObjects` is exported separately
// from the browser-bound `router` so tests can feed the identical route
// config into `createMemoryRouter` (see router.test.tsx) instead of
// re-declaring the route shape a second time and risking drift.
import { createBrowserRouter, type RouteObject } from "react-router-dom";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { RootRedirect } from "./pages/RootRedirect.tsx";
import { SalePageRoute } from "./pages/SalePage.tsx";

export const routeObjects: RouteObject[] = [
  { path: "/", element: <RootRedirect /> },
  { path: "/sale/:slug", element: <SalePageRoute /> },
  { path: "*", element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routeObjects);
