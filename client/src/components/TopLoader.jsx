import { useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import './TopLoader.css';

const TopLoader = forwardRef(function TopLoader(_, ref) {
  const barRef = useRef(null);
  const trickleRef = useRef(null);

  const start = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;

    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(0)';
    bar.style.opacity = '1';

    requestAnimationFrame(() => {
      bar.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
      bar.style.transform = 'scaleX(0.70)';
    });

    trickleRef.current = setTimeout(() => {
      if (bar) {
        bar.style.transition = 'transform 15s linear';
        bar.style.transform = 'scaleX(0.85)';
      }
    }, 500);
  }, []);

  const finish = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;

    clearTimeout(trickleRef.current);

    bar.style.transition = 'transform 0.1s ease-in';
    bar.style.transform = 'scaleX(1)';

    setTimeout(() => {
      bar.style.transition = 'opacity 0.4s ease-out';
      bar.style.opacity = '0';
      setTimeout(() => {
        bar.style.transition = 'none';
        bar.style.transform = 'scaleX(0)';
      }, 500);
    }, 100);
  }, []);

  useImperativeHandle(ref, () => ({ start, finish }), [start, finish]);

  return <div className="top-loader" ref={barRef} />;
});

export default TopLoader;
