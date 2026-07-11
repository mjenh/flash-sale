// AD-10: payment is a port behind acceptance, never in the decision path.
// Sole v1 implementation: adapters/payment/noop.ts (instant-approve).

export interface PaymentResult {
  approved: boolean;
  reference: string;
}

export interface PaymentProvider {
  charge(email: string): Promise<PaymentResult>;
}
