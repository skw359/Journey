import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import './JourneyStage.css';

// Scrolled past this, the "Details" cue gets out of the way.
const CUE_HIDE_SCROLL_PX = 24;

// The map's parallax drift per pixel scrolled; matches journey-map-parallax
// in JourneyStage.css (30vh over 100vh).
const PARALLAX_RATE = 0.3;
// Browsers that can tie the drift to scrolling in CSS don't need it from here
const CSS_SCROLL_TIMELINES = typeof CSS !== 'undefined' && CSS.supports?.('animation-timeline: scroll()');

/**
 * A selected journey as one scrolling page: the full-height map (`hero`)
 * fades into the background, with the journey's details (`children`) below.
 */
export default function JourneyStage({
  routeId,
  loading = false,
  sidebarCollapsed = false,
  measureActive = false,
  hero,
  children,
}) {
  const stageRef = useRef(null);
  const detailsRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);

  // Every journey opens on its map
  useLayoutEffect(() => {
    stageRef.current?.scrollTo({ top: 0 });
  }, [routeId]);

  const handleScroll = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (!CSS_SCROLL_TIMELINES) {
      // Past one screen the map is out of view, so the drift can stop there
      const drift = Math.min(stage.scrollTop, stage.clientHeight) * PARALLAX_RATE;
      stage.style.setProperty('--hero-parallax', `${drift.toFixed(1)}px`);
    }
    setScrolled(stage.scrollTop > CUE_HIDE_SCROLL_PX);
  };

  const scrollToDetails = () => {
    const stage = stageRef.current;
    const details = detailsRef.current;
    if (!stage || !details) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    stage.scrollTo({ top: details.offsetTop, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  const classes = ['journey-stage'];
  if (loading) classes.push('fade-out');
  if (!sidebarCollapsed) classes.push('with-sidebar');
  if (scrolled) classes.push('is-scrolled');
  if (measureActive) classes.push('is-measuring');

  return (
    <div ref={stageRef} className={classes.join(' ')} onScroll={handleScroll}>
      <section className="journey-hero">
        {hero}
        <div className="journey-hero-fade" aria-hidden="true" />
        <button
          type="button"
          className="journey-scroll-cue"
          onClick={scrollToDetails}
          tabIndex={scrolled ? -1 : undefined}
        >
          Details
          <ChevronDown size={16} strokeWidth={2.2} />
        </button>
      </section>
      <div ref={detailsRef} className="journey-stage-details">
        {children}
      </div>
    </div>
  );
}
