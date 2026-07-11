// AD-6: Date.now() on the API server is the sole clock. Services receive it
// injected; routes/adapters never call Date.now() for window decisions.

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
