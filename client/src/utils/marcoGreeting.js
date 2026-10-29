/**
 * The headline on Marco's empty state: a time-of-day greeting that uses the
 * signed-in user's first name.
 *
 * Selection and rendering are deliberately split. Marco.jsx picks a line once
 * (pickLine) and holds that choice for as long as the empty state is on
 * screen, then interpolates the name on every render (renderLine). If `user`
 * ever resolves after first paint, the name appears in a sentence that was
 * already there instead of the whole headline swapping to a new phrasing.
 */

// Bands run on the browser's local clock — the user's wall time, not the
// server's. 21:00–00:59 is one band, so midnight belongs with `late`.
export function bandFor(hour) {
  if (hour >= 5 && hour < 12) return 'morning';       // 05:00–11:59
  if (hour >= 12 && hour < 17) return 'afternoon';    // 12:00–16:59
  if (hour >= 17 && hour < 21) return 'evening';      // 17:00–20:59
  if (hour >= 21 || hour === 0) return 'late';        // 21:00–00:59
  return 'smallHours';                                // 01:00–04:59
}

// Each line carries its own nameless variant rather than deriving one by
// stripping the name out — ", " and trailing punctuation don't survive that
// cleanly, and the bare forms want their own wording anyway.
//
// `named` is optional: a line with only `bare` has no natural place to put a
// name and is used as-written whether or not we know one.
export const LINES = {
  morning: [
    { named: 'Good morning, {name}.', bare: 'Good morning.' },
    { named: 'Morning, {name}.', bare: 'Morning.' },
    { named: 'Where to today, {name}?', bare: 'Where to today?' },
  ],
  afternoon: [
    { named: 'Good afternoon, {name}.', bare: 'Good afternoon.' },
    { named: 'Afternoon, {name}.', bare: 'Afternoon.' },
    { named: 'What’s on the map, {name}?', bare: 'What’s on the map?' },
    { bare: 'Ready to keep things moving?' },
    { bare: 'It’s good to have you here.' },
    { bare: 'Nice to see you this afternoon.' },
    { bare: 'Glad you’re here.' },
  ],
  evening: [
    { named: 'Good evening, {name}.', bare: 'Good evening.' },
    { named: 'Evening, {name}.', bare: 'Evening.' },
    { named: 'Where did today take you, {name}?', bare: 'Where did today take you?' },
    { named: 'Good to see you, {name}.', bare: 'Good to see you.' },
    { bare: 'Winding down for the day?' },
    { bare: 'Ready to wrap up the day?' },
    { bare: 'Glad you’re here.' },
    { bare: 'Nice to see you this evening.' },
    { bare: 'Let’s make the most of your evening.' },
    { bare: 'Evening! What can I help you with?' },
    { bare: 'It’s good to have you here.' },
  ],
  late: [
    { named: 'Up late, {name}?', bare: 'Up late?' },
    { named: 'Still going, {name}?', bare: 'Still going?' },
    { named: 'Late one, {name}?', bare: 'Late one?' },
  ],
  smallHours: [
    { named: 'Still up, {name}?', bare: 'Still up?' },
    { named: 'Long night, {name}?', bare: 'Long night?' },
    { named: 'Can’t sleep, {name}?', bare: 'Can’t sleep?' },
  ],
};

/**
 * A first name worth saying out loud, or null.
 *
 * Accounts with an empty first_name but a real display_name fall to the
 * displayName leg. Password accounts registered without a name get
 * display_name = username (server/routes/auth.js), which we deliberately
 * refuse — greeting someone by their login handle reads worse than not
 * greeting them by name at all.
 */
export function firstNameOf(user) {
  const first = user?.firstName?.trim();
  if (first) return first.split(/\s+/)[0];

  const display = user?.displayName?.trim();
  if (display) {
    const token = display.split(/\s+/)[0];
    const username = user?.username?.trim().toLowerCase();
    if (token && token.toLowerCase() !== username) return token;
  }

  return null;
}

/** Choose a phrasing for the current moment. Returns a stable {band, index}. */
export function pickLine(now = new Date(), rand = Math.random) {
  const band = bandFor(now.getHours());
  const index = Math.floor(rand() * LINES[band].length);
  return { band, index };
}

/**
 * Render a chosen line for a name. Falls back to the bare form when we have no
 * name, and also when the line simply has no slot for one.
 */
export function renderLine(key, name) {
  const pool = LINES[key?.band] || LINES.morning;
  const line = pool[key?.index] || pool[0];
  if (!name || !line.named) return line.bare;
  return line.named.replace('{name}', name);
}
