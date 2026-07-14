// Instant-approve no-op provider — its result never alters the HTTP outcome.
import type { PaymentProvider, PaymentResult } from "../../services/payment.ts";

export const noopPaymentProvider: PaymentProvider = {
  async charge(email: string): Promise<PaymentResult> {
    return { approved: true, reference: `noop:${email}` };
  },
};
