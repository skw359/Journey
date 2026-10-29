import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Plus, Settings as SettingsIcon, Square } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { askMarcoStream } from '../api/ask';
import { renderMarkdown, trimDanglingMarkdown } from '../utils/marcoMarkdown';
import { firstNameOf, pickLine, renderLine } from '../utils/marcoGreeting';
import './Marco.css';

// Suggestion chips shown on the empty state — real questions Marco answers well.
const SUGGESTIONS = [
  'What new locations did I travel to that I didn’t go to last week?',
  'How much more did I travel in comparison to last week?',
  'How was my driving speed compared to last week’s?',
  'What was my longest journey this month?',
  'Break down my travel this year by mode',
];

// One revolution of the thinking bar. Keep in sync with --spin-speed on
// .marco-caret-spin in Marco.css (the settle fallback timer derives from it).
const SPIN_MS = 1150;

// How many buffered characters drain per animation frame. Scales with backlog
// so the paint never falls far behind the model, but single tokens still land
// letter by letter.
const drainStep = (backlog) => Math.max(1, Math.ceil(backlog / 12));

// The transcript stays pinned to the newest text only while the reader is
// already within this many pixels of the bottom; scrolling up detaches it.
const NEAR_BOTTOM_PX = 130;

const nearBottom = (el) =>
  !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;

const toBottom = (el, smooth) =>
  el?.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });

function MetaLine({ meta, stopped }) {
  if (stopped) return <div className="marco-meta">stopped</div>;
  if (!meta?.tool) return null;
  const periods = (meta.periods || []).map(p => p.label).join(' vs ');
  const seconds = meta.timing?.total_ms != null ? `${(meta.timing.total_ms / 1000).toFixed(1)}s` : null;
  const bits = [meta.tool.replaceAll('_', ' '), periods, seconds].filter(Boolean);
  return <div className="marco-meta">{bits.join(' · ')}</div>;
}

/**
 * One Marco reply, rendered as formatted prose. The markup is painted
 * imperatively (innerHTML from our own escaping renderer) so the caret can
 * live INSIDE the last rendered block and ride along with the typed text —
 * the same element that plays the thinking spinner until the reply starts.
 * Re-running the effect replaces the nodes, which is also what restarts the
 * spin animation each time Marco.jsx bumps spinCycle.
 */
function MarcoProse({ text, streaming, settled, spinCycle, error, onSpinnerTurn }) {
  const hostRef = useRef(null);
  const turnRef = useRef(onSpinnerTurn);
  turnRef.current = onSpinnerTurn;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = renderMarkdown(streaming ? trimDanglingMarkdown(text) : text);
    if (!streaming) return;

    const caret = document.createElement('span');
    caret.className = settled ? 'marco-caret' : 'marco-caret marco-caret-spin';
    if (text) {
      caret.setAttribute('aria-hidden', 'true');
    } else {
      caret.setAttribute('role', 'status');
      caret.setAttribute('aria-label', 'Marco is thinking');
    }
    if (!settled) {
      // The spin runs exactly one revolution ("1 forwards"), so animationend
      // fires once per launch; Marco.jsx decides whether to relaunch or settle.
      caret.addEventListener('animationend', () => turnRef.current?.(), { once: true });
    }

    const last = host.lastElementChild;
    if (!last) host.appendChild(caret);
    else if (last.tagName === 'P') last.appendChild(caret);
    else if (last.tagName === 'UL' || last.tagName === 'OL' || last.tagName === 'BLOCKQUOTE') {
      (last.lastElementChild || last).appendChild(caret);
    } else if (last.tagName === 'PRE') {
      (last.firstElementChild || last).appendChild(caret);
    } else {
      host.appendChild(caret);
    }
  }, [text, streaming, settled, spinCycle]);

  return <div className={`marco-prose${error ? ' marco-prose-error' : ''}`} ref={hostRef} />;
}

export default function Marco() {
  const { marcoEnabled, user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showJump, setShowJump] = useState(false);
  // The empty-state headline. Picked once so it can't reshuffle under the
  // reader mid-visit; re-rolled by resetChat, which also re-reads the clock
  // so a tab left open since morning doesn't still say "Good morning".
  const [lineKey, setLineKey] = useState(() => pickLine(new Date()));
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const stickRef = useRef(true); // reader is anchored to the bottom

  // Streaming machinery: tokens land in pendingRef and a rAF loop drains them
  // into the last message a few characters per frame, so the reply types
  // itself smoothly even when Ollama sends chunky fragments. Typing only
  // begins once the thinking bar has finished a revolution and rests upright
  // (see settle/requestDrain), so the bar becomes the caret with no jump.
  const pendingRef = useRef('');
  const doneRef = useRef(null);
  const rafRef = useRef(null);
  const drainingRef = useRef(false);
  const arrivedRef = useRef(false); // some part of the reply has arrived
  const settledRef = useRef(false); // bar has stopped upright; typing may start
  const settleTimerRef = useRef(null);

  // Follow the stream only while the reader is at the bottom; if they've
  // scrolled up to reread something, leave them alone and offer the pill.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (stickRef.current) toBottom(el, false);
    setShowJump(!nearBottom(el) && messages.length > 0);
  }, [messages]);

  const handleScroll = () => {
    stickRef.current = nearBottom(scrollRef.current);
    setShowJump(!stickRef.current && messages.length > 0);
  };

  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  };

  useEffect(() => {
    inputRef.current?.focus();
    autosize();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const patchLast = (fn) => {
    setMessages(prev => prev.length
      ? prev.map((m, i) => (i === prev.length - 1 ? fn(m) : m))
      : prev);
  };

  const finalize = ({ answer, meta }) => {
    drainingRef.current = false;
    doneRef.current = null;
    pendingRef.current = '';
    patchLast(m => ({ ...m, text: answer, meta, streaming: false }));
    setBusy(false);
    inputRef.current?.focus();
  };

  const drain = () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    const step = () => {
      const backlog = pendingRef.current;
      if (backlog.length) {
        const take = drainStep(backlog.length);
        const chunk = backlog.slice(0, take);
        pendingRef.current = backlog.slice(take);
        patchLast(m => ({ ...m, text: m.text + chunk }));
        rafRef.current = requestAnimationFrame(step);
      } else if (doneRef.current) {
        // Stream finished and the buffer is dry — snap to the authoritative
        // final text (identical in the normal case) and attach the meta line.
        finalize(doneRef.current);
      } else {
        drainingRef.current = false; // stream still running; wait for tokens
      }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  // The handoff. The spinner runs one revolution per cycle and rests upright
  // (fill-mode holds 360°). At each cycle's end, handleSpinnerTurn either
  // launches the next revolution (nothing to show yet) or settles: the same
  // bar stops spinning, becomes the insertion caret, and typing begins.
  // Because the bar is already motionless and upright when we settle, the
  // swap can never catch it mid-rotation.
  const settle = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    patchLast(m => ({ ...m, settled: true }));
    drain();
  };

  const requestDrain = () => {
    if (settledRef.current) {
      drain();
      return;
    }
    if (arrivedRef.current) return; // already waiting on the upright moment
    arrivedRef.current = true;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      settle(); // spin animation is disabled; don't wait on its events
    } else {
      // Safety net: if the animation's end event goes missing (throttled
      // background tab), release the reply after ~two revolutions anyway.
      settleTimerRef.current = setTimeout(settle, SPIN_MS * 2);
    }
  };

  const handleSpinnerTurn = () => {
    if (arrivedRef.current) {
      settle();
    } else {
      // Nothing to type yet — wind up and release another revolution.
      patchLast(m => (m.streaming && !m.settled
        ? { ...m, spinCycle: (m.spinCycle || 0) + 1 }
        : m));
    }
  };

  // The conversation memory. The transcript on screen IS the memory: each
  // ask carries the recent completed exchanges so the server can resolve
  // follow-ups ("what about the week before?"). Pairs whose reply errored are
  // skipped — an unanswered question would read as still waiting for an
  // answer; stopped replies keep whatever text arrived. The server enforces
  // its own caps, this slice just keeps the payload honest.
  const HISTORY_TURNS = 10; // messages, i.e. 5 exchanges

  const buildHistory = () => {
    const turns = [];
    for (let i = 0; i + 1 < messages.length; i += 1) {
      const q = messages[i];
      const a = messages[i + 1];
      if (q.role !== 'user' || a.role !== 'marco') continue;
      if (a.error || a.streaming || !a.text?.trim()) continue;
      turns.push({ role: 'user', content: q.text });
      turns.push({ role: 'assistant', content: a.text });
    }
    return turns.slice(-HISTORY_TURNS);
  };

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || busy) return;
    const history = buildHistory();

    setInput('');
    setBusy(true);
    stickRef.current = true;
    pendingRef.current = '';
    doneRef.current = null;
    arrivedRef.current = false;
    settledRef.current = false;
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setMessages(prev => [
      ...prev,
      { role: 'user', text: question },
      { role: 'marco', text: '', streaming: true, settled: false, spinCycle: 0 },
    ]);
    // First send swaps the hero for the chat layout, remounting the composer —
    // re-run sizing and put focus back once the new textarea exists.
    requestAnimationFrame(() => { autosize(); inputRef.current?.focus(); });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await askMarcoStream(question, {
        history,
        signal: controller.signal,
        onToken: (t) => { pendingRef.current += t; requestDrain(); },
        onReplace: (full) => {
          // The phrasing stream died mid-answer; the server sent the complete
          // fallback. Retype it from the start rather than appending.
          pendingRef.current = full;
          patchLast(m => ({ ...m, text: '' }));
          requestDrain();
        },
      });
      doneRef.current = result;
      requestDrain(); // types out whatever is buffered, then finalizes
    } catch (err) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      drainingRef.current = false;
      if (controller.signal.aborted) {
        // User hit stop: keep everything received so far, flushed instantly.
        const leftover = pendingRef.current;
        pendingRef.current = '';
        patchLast(m => ({
          ...m,
          text: m.text + leftover,
          streaming: false,
          stopped: true,
        }));
      } else {
        patchLast(m => ({
          ...m,
          streaming: false,
          error: true,
          text: err.message || 'Something went wrong answering that.',
        }));
      }
      setBusy(false);
      inputRef.current?.focus();
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const resetChat = () => {
    // Abort first: the stream's catch handler clears busy state and timers,
    // and its patchLast is a no-op once the transcript below is emptied.
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setShowJump(false);
    setLineKey(pickLine(new Date()));
    stickRef.current = true;
    // Clearing the chat swaps back to the hero, remounting the composer.
    requestAnimationFrame(() => { autosize(); inputRef.current?.focus(); });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy) send();
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (busy) stop();
    else send();
  };

  if (!marcoEnabled) {
    return (
      <div id="main-app" className="marco-page">
        <main className="marco-shell">
          <div className="marco-wrap marco-asleep-wrap">
            <div className="marco-asleep">
              <span className="marco-mark marco-mark--lg"><span className="marco-mark-glyph" /></span>
              <h2>Marco is asleep</h2>
              <p>
                Journey AI isn&apos;t enabled yet. Turn it on and point it at your
                Ollama server to start asking questions about your travels.
              </p>
              <Link to="/settings" className="marco-cta">
                <SettingsIcon size={15} /> Open Settings
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const isEmpty = messages.length === 0;
  const typing = input.trim().length > 0;

  // One composer, two homes: centered in the hero before the first message,
  // docked at the bottom during a chat. It remounts on the switch, so send()
  // and resetChat() restore focus a frame later.
  const composer = (
    <form className="marco-composer" onSubmit={handleSubmit}>
      <label className="marco-sr" htmlFor="marco-input">Ask Marco about your journeys</label>
      <textarea
        id="marco-input"
        ref={inputRef}
        rows={1}
        placeholder="Ask Marco about your journeys…"
        value={input}
        maxLength={500}
        autoComplete="off"
        onChange={(e) => { setInput(e.target.value); autosize(); }}
        onKeyDown={handleKeyDown}
      />
      <button
        className="marco-send"
        type="submit"
        disabled={!busy && !input.trim()}
        title={busy ? 'Stop' : 'Send'}
        aria-label={busy ? 'Stop generating' : 'Send message'}
      >
        {busy
          ? <Square size={13} fill="currentColor" strokeWidth={0} />
          : <ArrowUp size={17} strokeWidth={2.2} />}
      </button>
    </form>
  );

  return (
    <div id="main-app" className="marco-page">
      <main className="marco-shell">
        <header className={`marco-topbar${isEmpty ? ' marco-topbar--bare' : ''}`}>
          <div className="marco-wrap marco-topbar-row">
            <button className="marco-ghost" type="button" onClick={resetChat}>
              <Plus size={15} /> New chat
            </button>
          </div>
        </header>

        {isEmpty ? (
          <div className="marco-hero">
            <div className="marco-wrap marco-hero-inner">
              <h2>
                <span className="marco-hero-logo" aria-hidden="true" />
                {renderLine(lineKey, firstNameOf(user))}
              </h2>
              {composer}
              {/* Suggestions are scaffolding for an empty composer; once there's
                  something in it they're noise. They fade out but keep their
                  space, so the composer never moves under the cursor mid-thought.
                  inert takes them out of the tab order and the accessibility tree
                  the moment they go invisible. */}
              <div className={`marco-chips${typing ? ' is-hidden' : ''}`} inert={typing}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="marco-chip" type="button" onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="marco-stream" ref={scrollRef} onScroll={handleScroll}>
              <div className="marco-wrap">
                <div className="marco-log" role="log">
                  {messages.map((m, i) => (
                    m.role === 'user' ? (
                      <div key={i} className="marco-turn marco-turn--user">
                        <div className="marco-bubble">{m.text}</div>
                      </div>
                    ) : (
                      <div key={i} className="marco-turn marco-turn--bot">
                        <div className="marco-body">
                          <MarcoProse
                            text={m.text}
                            streaming={!!m.streaming}
                            settled={!!m.settled}
                            spinCycle={m.spinCycle || 0}
                            error={!!m.error}
                            onSpinnerTurn={handleSpinnerTurn}
                          />
                          {!m.error && !m.streaming && <MetaLine meta={m.meta} stopped={m.stopped} />}
                        </div>
                      </div>
                    )
                  ))}
                </div>
              </div>
            </div>

            <div className="marco-dock">
              <button
                className={`marco-jump${showJump ? ' on' : ''}`}
                type="button"
                onClick={() => toBottom(scrollRef.current, true)}
                tabIndex={showJump ? 0 : -1}
              >
                <ArrowDown size={13} /> Latest
              </button>
              <div className="marco-wrap">
                {composer}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
