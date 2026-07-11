// Order service — owns the AD-2 response precedence on the injected clock
// (AD-6). Framework-free (AD-7): no express/redis/mongoose imports; the Redis
// order adapter satisfies OrderAttemptPort. Precedence (validation is the
// route's job and happens before this service is called):
//   already-ordered (200) -> window (409 inactive) -> stock (409 sold out) -> created (201)
// Inside the window the AD-1 script decides everything in one atomic unit;
// outside it, ONE SISMEMBER distinguishes already from inactive — the script
// never runs outside the window (AD-2).
import type { Clock } from "./clock.ts";
import type { SaleWindow } from "./sale-status.ts";

/** Port satisfied by adapters/redis/orders.ts (AD-1's named script operation). */
export interface OrderAttemptPort {
  attempt(email: string): Promise<{ verdict: "OK" | "ALREADY" | "SOLD_OUT"; remaining: number }>;
  hasOrdered(email: string): Promise<boolean>;
}

export type OrderOutcome =
  | { outcome: "created"; remaining: number }
  | { outcome: "already"; remaining?: number }
  | { outcome: "sold_out"; remaining: number }
  | { outcome: "inactive" };

export interface OrderService {
  attempt(email: string): Promise<OrderOutcome>;
}

export interface OrderServiceDeps {
  clock: Clock;
  window: SaleWindow;
  orders: OrderAttemptPort;
}

export function createOrderService({ clock, window, orders }: OrderServiceDeps): OrderService {
  return {
    async attempt(email: string): Promise<OrderOutcome> {
      const now = clock();
      const inWindow = now >= window.startMs && now < window.endMs; // [start, end), AD-6

      if (!inWindow) {
        // AD-2: an order holder always wins — even before start or after end.
        return (await orders.hasOrdered(email)) ? { outcome: "already" } : { outcome: "inactive" };
      }

      const { verdict, remaining } = await orders.attempt(email);
      switch (verdict) {
        case "OK":
          // (Story 1.4) async Mongo audit + no-op payment slot in here, after
          // acceptance; (Story 1.6) publish order.accepted — and sale.sold_out
          // exactly once when remaining === 0. Neither alters the outcome.
          return { outcome: "created", remaining };
        case "ALREADY":
          return { outcome: "already", remaining };
        case "SOLD_OUT":
          return { outcome: "sold_out", remaining };
      }
    },
  };
}
