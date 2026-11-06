import { flushSync } from 'react-dom';

/**
 * Whether to run JavaScript-driven animation. CSS animation is switched off by
 * the reduced-motion block in index.css, but a value counting up in a
 * requestAnimationFrame loop or a Web Animations call is not, so those check
 * here. False where `matchMedia` does not exist (jsdom), which is what makes
 * every animated value in a test render its final text at once.
 */
export function prefersMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Runs a React state update inside a view transition, so rows that leave, arrive
 * or move animate between the two layouts. `flushSync` is required: the browser
 * photographs the new state as soon as the callback returns, and a batched
 * update would not have reached the DOM yet. Browsers without the API just get
 * the update.
 */
export function fluidUpdate(update: () => void): void {
  if (!prefersMotion() || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
