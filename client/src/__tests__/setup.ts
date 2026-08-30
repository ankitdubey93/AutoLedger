// Adds the DOM matchers (toBeInTheDocument, toHaveTextContent, ...) to expect.
// The /vitest entry point registers them with Vitest's expect rather than Jest's.
import '@testing-library/jest-dom/vitest';
