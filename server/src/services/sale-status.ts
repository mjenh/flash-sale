// Sale-status service — the sole owner of the status state machine. The SSE
// broadcaster composes every frame through getStatus(). Framework-free: the
// clock is injected and stock arrives through the StockReader port.
// Window semantics: [start, end).
import type { Clock } from "./clock.ts";

export type SaleStatus = "upcoming" | "active" | "ended" | "sold_out";

/** Composed here once for both HTTP and SSE responses. */
export interface SaleStatusBody {
  success: true;
  status: SaleStatus;
  stock: number;
  startTime: string;
  endTime: string;
}

/** Port satisfied by adapters/redis/stock.ts. */
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
      // Always read stock in every state — a Redis failure therefore fails
      // closed even before/after the window.
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
