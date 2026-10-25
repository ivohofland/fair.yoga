/** What a payment method's panel may name: a fixed amount owed, or none, for a gift (#912). */
export type MethodAmount = { kind: 'fixed'; amount: number } | { kind: 'open' };
