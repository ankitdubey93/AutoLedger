// Adds the DOM matchers (toBeInTheDocument, toHaveTextContent, ...) to expect.
// The /vitest entry point registers them with Vitest's expect rather than Jest's.
import '@testing-library/jest-dom/vitest';

// Recharts' ResponsiveContainer observes its parent's size; jsdom has no ResizeObserver.
// The stub never fires, so charts render at zero size in tests — assertions use the
// visually-hidden data tables each chart renders beside its SVG.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
