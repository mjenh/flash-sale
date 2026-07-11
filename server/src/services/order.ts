// Order service — owns the AD-2 response precedence on the injected clock
// (AD-6). Framework-free (AD-7): no express/redis/mongoose imports; the Redis
// order adapter satisfies OrderAttemptPort and the Mongo audit recorder
// satisfies OrderAuditPort. Precedence (validation is the route's job and
// happens before this service is called):
//   already-ordered (200) -> window (409 inactive) -> stock (409 sold out) -> created (201)
// Inside the window the AD-1 script decides everything in one atomic unit;
// outside it, ONE SISMEMBER distinguishes already from inactive — the script
// never runs outside the window (AD-2).
//
// Post-accept side effects (Story 1.4, AD-3/AD-10): after OK — and ONLY after
// OK — the Mongo audit write and the payment charge fire-and-forget. Neither
// is awaited; neither can alter the HTTP outcome; failures are reported via
// the injected callback (bootstrap wires it to logger.error) and are NEVER
// rolled back — no INCR/SREM compensation exists anywhere (AD-1).
import type { Clock } from "./clock.ts";
import type { SaleWindow } from "./sale-status.ts";
import type { PaymentProvider } from "./payment.ts";

/** Port satisfied by adapters/redis/orders.ts (AD-1's named script operation). */
export interface OrderAttemptPort {
  attempt(email: string): Promise<{ verdict: "OK" | "ALREADY" | "SOLD_OUT"; remaining: number }>;
  hasOrdered(email: string): Promise<boolean>;
}

/** Port satisfied by adapters/mongo/audit.ts (AD-3's async durable record). */
export interface OrderAuditPort {
  recordOrder(email: string): Promise<void>;
}

export type OrderSideEffect = "audit" | "payment";

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
  audit: OrderAuditPort;
  payment: PaymentProvider;
  /** Keeps the service framework-free: failures are reported, never thrown. */
  reportSideEffectFailure: (effect: OrderSideEffect, err: unknown) => void;
}

export function createOrderService({
  clock,
  window,
  orders,
  audit,
  payment,
  reportSideEffectFailure,
}: OrderServiceDeps): OrderService {
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
          // Fire-and-forget: the 201 resolves within the request/response
          // cycle (AD-8) without awaiting either promise. Failures are logged
          // side effects, never rollbacks (NFR-4's accepted audit undercount).
          void audit.recordOrder(email).catch((err: unknown) => {
            reportSideEffectFailure("audit", err);
          });
          void payment
            .charge(email)
            .then((result) => {
              if (!result.approved) {
                reportSideEffectFailure(
                  "payment",
                  new Error(`payment declined: ${result.reference}`),
                );
              }
            })
            .catch((err: unknown) => {
              reportSideEffectFailure("payment", err);
            });
          // (Story 1.6) publish order.accepted — and sale.sold_out exactly
          // once when remaining === 0. Neither alters the outcome.
          return { outcome: "created", remaining };
        case "ALREADY":
          return { outcome: "already", remaining };
        case "SOLD_OUT":
          return { outcome: "sold_out", remaining };
      }
    },
  };
}
