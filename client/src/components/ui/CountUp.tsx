import { useEffect, useRef, useState } from 'react';
import { formatCents } from '../../utils/money';
import { prefersMotion } from '../../utils/motion';

const DURATION_MS = 1200;

/**
 * An amount that counts up to its value when it first appears or changes. The
 * in-between frames are decoration, so `Math.round` on them is harmless; the last
 * frame is the exact integer `cents` it was given, never a computed one.
 */
export default function CountUp({ cents }: { cents: number }) {
  const [shown, setShown] = useState(() => (prefersMotion() ? 0 : cents));
  // Where the next change counts from. Written only by the animation, never during render.
  const fromRef = useRef(shown);

  useEffect(() => {
    if (!prefersMotion()) {
      setShown(cents);
      return;
    }
    const from = fromRef.current;
    let start: number | null = null;
    let frame = 0;
    function step(now: number) {
      start ??= now;
      const progress = Math.min((now - start) / DURATION_MS, 1);
      if (progress === 1) {
        fromRef.current = cents;
        setShown(cents);
        return;
      }
      const eased = 1 - Math.pow(1 - progress, 4);
      const value = Math.round(from + (cents - from) * eased);
      fromRef.current = value;
      setShown(value);
      frame = requestAnimationFrame(step);
    }
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cents]);

  return <>{formatCents(shown)}</>;
}
