// The sole clock — services receive it injected; routes and adapters never
// call Date.now() directly for window decisions.

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
