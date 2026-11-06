/**
 * The moving shapes behind a `.fluid-hero`: two morphing blobs over two looping
 * waves. Each wave path repeats every 720 of its 1440 units and the SVG is twice
 * the panel's width, so translating it by -50% lands on an identical frame and
 * the loop has no seam. Purely decorative, and still under reduced motion.
 */
export default function FluidBackdrop({ waveHeight = 96 }: { waveHeight?: number }) {
  return (
    <div aria-hidden="true">
      <span className="fluid-hero__blob" style={{ width: 340, height: 340, right: '6%', top: -170, background: 'var(--hero-coral)' }} />
      <span className="fluid-hero__blob" style={{ width: 210, height: 210, right: '30%', top: 40, background: 'var(--hero-plum)', animationDelay: '-6s' }} />
      <div className="fluid-hero__wave fluid-hero__wave--back" style={{ height: waveHeight }}>
        <svg viewBox="0 0 1440 96" preserveAspectRatio="none">
          <path fill="var(--hero-deep)" d="M0 40 Q 180 0 360 40 T 720 40 T 1080 40 T 1440 40 V96 H0 Z" />
        </svg>
      </div>
      <div className="fluid-hero__wave" style={{ height: waveHeight * 0.66 }}>
        <svg viewBox="0 0 1440 96" preserveAspectRatio="none">
          <path fill="var(--hero-plum)" d="M0 52 Q 180 16 360 52 T 720 52 T 1080 52 T 1440 52 V96 H0 Z" />
        </svg>
      </div>
    </div>
  );
}
