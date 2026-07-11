// AD-10: instant-approve no-op provider — invoked only after the AD-1 script
// returns OK (Story 1.4); its result never alters the HTTP outcome.
import type { PaymentProvider, PaymentResult } from "../../services/payment.ts";

export const noopPaymentProvider: PaymentProvider = {
  async charge(email: string): Promise<PaymentResult> {
    return { approved: true, reference: `noop:${email}` };
  },
};
