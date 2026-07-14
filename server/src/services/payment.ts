// Payment is a port behind acceptance, never in the decision path.

export interface PaymentResult {
  approved: boolean;
  reference: string;
}

export interface PaymentProvider {
  charge(email: string): Promise<PaymentResult>;
}
