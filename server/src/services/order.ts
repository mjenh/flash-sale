// Order service — framework-free: no express/redis/mongoose imports.
// Response precedence (validation is the route's job):
//   already-ordered (200) -> window (409 inactive) -> stock (409 sold out) -> created (201)
// Inside the window the Lua script decides everything in one atomic unit;
// outside it, one SISMEMBER distinguishes already from inactive.
//
// Post-accept side effects: after OK — and ONLY after OK — the Mongo audit
// write, the payment charge, and the event publishes fire-and-forget. None is
// awaited; none can alter the HTTP outcome; failures are reported via the
// injected callback and are never rolled back. sale.sold_out publishes exactly
// once: by the request whose script returns OK with remaining === 0.
//
// saleId and window travel as a per-call SaleContext instead of a
// bootstrap-frozen dep — the route resolves them fresh from req.sale on
// every request. The ports (OrderAttemptPort, OrderAuditPort, OrderEventsPort)
// are saleId-parameterized to match the saleId-scoped adapter signatures in
// orders.ts and events.ts, so bootstrap can wire them with zero closures.
import type { Clock } from "./clock.ts";
import type { SaleWindow } from "./sale-status.ts";
import type { PaymentProvider } from "./payment.ts";

/** The resolved sale identity + window for one attempt() call — sourced from
 *  req.sale at the route layer. */
export interface SaleContext {
  saleId: string;
  window: SaleWindow;
}

/** Port satisfied by adapters/redis/orders.ts. */
export interface OrderAttemptPort {
  attempt(saleId: string, email: string): Promise<{ verdict: "OK" | "ALREADY" | "SOLD_OUT"; remaining: number }>;
  hasOrdered(saleId: string, email: string): Promise<boolean>;
}

/** Port satisfied by adapters/mongo/audit.ts. */
export interface OrderAuditPort {
  recordOrder(saleId: string, email: string): Promise<void>;
}

/** Port satisfied by adapters/redis/events.ts.
 *  Type-only events; the order path only ever emits these two. */
export interface OrderEventsPort {
  publish(event: "order.accepted" | "sale.sold_out", saleId: string): Promise<void>;
}

export type OrderSideEffect = "audit" | "payment" | "publish";

export type OrderOutcome =
  | { outcome: "created"; remaining: number }
  | { outcome: "already"; remaining?: number }
  | { outcome: "sold_out"; remaining: number }
  | { outcome: "inactive" };

export interface OrderService {
  attempt(sale: SaleContext, email: string): Promise<OrderOutcome>;
  /** Does this email already hold a confirmed order? Answered from Redis
   *  membership only — never Mongo — and never clock-gated: membership is a
   *  standing fact, honest before, during, and after the window. */
  hasOrdered(saleId: string, email: string): Promise<boolean>;
}

export interface OrderServiceDeps {
  clock: Clock;
  orders: OrderAttemptPort;
  audit: OrderAuditPort;
  payment: PaymentProvider;
  events: OrderEventsPort;
  /** Keeps the service framework-free: failures are reported, never thrown. */
  reportSideEffectFailure: (effect: OrderSideEffect, err: unknown) => void;
}

export function createOrderService({
  clock,
  orders,
  audit,
  payment,
  events,
  reportSideEffectFailure,
}: OrderServiceDeps): OrderService {
  return {
    async attempt({ saleId, window }: SaleContext, email: string): Promise<OrderOutcome> {
      const now = clock();
      const inWindow = now >= window.startMs && now < window.endMs; // [start, end)

      if (!inWindow) {
        // An order holder always wins — even before start or after end.
        return (await orders.hasOrdered(saleId, email)) ? { outcome: "already" } : { outcome: "inactive" };
      }

      const { verdict, remaining } = await orders.attempt(saleId, email);
      switch (verdict) {
        case "OK":
          // Fire-and-forget: the 201 resolves within the request/response
          // cycle without awaiting either promise. Failures are logged side
          // effects, never rollbacks.
          void audit.recordOrder(saleId, email).catch((err: unknown) => {
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
          // Type-only consequence events. order.accepted on every accept;
          // sale.sold_out exactly once — by the request whose script drained
          // stock to 0. Publish failures never alter the HTTP outcome.
          void events.publish("order.accepted", saleId).catch((err: unknown) => {
            reportSideEffectFailure("publish", err);
          });
          if (remaining === 0) {
            void events.publish("sale.sold_out", saleId).catch((err: unknown) => {
              reportSideEffectFailure("publish", err);
            });
          }
          return { outcome: "created", remaining };
        case "ALREADY":
          return { outcome: "already", remaining };
        case "SOLD_OUT":
          return { outcome: "sold_out", remaining };
      }
    },

    async hasOrdered(saleId: string, email: string): Promise<boolean> {
      // Pure read — RedisUnavailableError rejections propagate untouched to 503.
      return orders.hasOrdered(saleId, email);
    },
  };
}
