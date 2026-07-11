import React, { useRef, useEffect } from 'react';

const BAR_COUNT = 4;
const MULTIPLIERS = [0.7, 1.0, 0.85, 0.6];

// Volume-driven mic indicator. Driven by RMS through a ref so we don't
// re-render every frame.
export function VoiceBars({ volumeRef, isRecording }) {
  const barsRef = useRef<any>(null);
  const rafRef = useRef<any>(null);

  useEffect(() => {
    if (!isRecording) return;

    const animate = () => {
      const el = barsRef.current;
      if (!el) return;
      const raw = volumeRef.current;
      // Typical speech RMS ~0.02-0.15; scale into 0-1.
      const level = Math.min(raw * 8, 1);
      for (let i = 0; i < BAR_COUNT; i++) {
        const h = Math.max(3, level * 16 * MULTIPLIERS[i]);
        if (el.children[i]) el.children[i].style.height = `${h}px`;
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isRecording, volumeRef]);

  if (!isRecording) return null;

  return (
    <div ref={barsRef} className="inline-flex size-4 items-center justify-center gap-0.5" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        // Heights are driven imperatively (style.height) from the RMS loop.
        <span key={i} className="block h-[3px] w-0.5 rounded-[1px] bg-current transition-[height] duration-75 ease-out" />
      ))}
    </div>
  );
}
