// Sale-status service — the SOLE owner of the status state machine (AD-9:
// Story 1.6's SSE broadcaster composes every frame through getStatus()).
// Framework-free (AD-7): no express/redis/mongoose imports; the clock is
// injected (AD-6) and stock arrives through the StockReader port, which the
// Redis stock adapter satisfies. Window semantics: [start, end).
import type { Clock } from "./clock.ts";

export type SaleStatus = "upcoming" | "active" | "ended" | "sold_out";

/** FR-1 body — composed here, once, for HTTP and (Story 1.6) SSE alike. */
export interface SaleStatusBody {
  success: true;
  status: SaleStatus;
  stock: number;
  startTime: string;
  endTime: string;
}

/** Port satisfied by adapters/redis/stock.ts (AD-3: runtime reads hit Redis only). */
export interface StockReader {
  getRemaining(): Promise<number>;
}

export interface SaleWindow {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
}

export interface SaleStatusService {
  getStatus(): Promise<SaleStatusBody>;
}

export interface SaleStatusDeps {
  clock: Clock;
  stock: StockReader;
  window: SaleWindow;
}

export function createSaleStatusService({ clock, stock, window }: SaleStatusDeps): SaleStatusService {
  return {
    async getStatus(): Promise<SaleStatusBody> {
      // FR-1 always carries stock — read it in every state. Redis down
      // therefore fails closed even before/after the window (AD-5).
      const remaining = await stock.getRemaining();
      const now = clock();

      let status: SaleStatus;
      if (now < window.startMs) {
        status = "upcoming";
      } else if (now >= window.endMs) {
        status = "ended";
      } else {
        status = remaining > 0 ? "active" : "sold_out";
      }

      return {
        success: true,
        status,
        stock: remaining,
        startTime: window.startIso,
        endTime: window.endIso,
      };
    },
  };
}
