// Mouse support for the TUI: SGR (1006) mouse-report parsing, click-vs-drag gestures, and text selection.
// Kept free of terminal I/O so it can be unit-tested.

export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h"; // clicks + drag motion, SGR coordinates
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL = /\x1b\[<[\d;]*$/;

/** Decode one SGR report. Coordinates are returned 0-based. */
export function decodeMouse(b, x, y, final) {
  b = Number(b);
  const ev = {
    x: Number(x) - 1,
    y: Number(y) - 1,
    shift: !!(b & 4),
    meta: !!(b & 8),
    ctrl: !!(b & 16),
    motion: !!(b & 32),
    release: final === "m",
    button: null,
    wheel: null,
  };
  if (b & 64) ev.wheel = b & 1 ? "down" : "up";
  else ev.button = ["left", "middle", "right", null][b & 3];
  return ev;
}

/**
 * Splits mouse reports out of terminal input. `feed(chunk)` calls onMouse for each complete report and
 * returns the remaining (keyboard) input. A report cut off at the end of a chunk is held until the next one.
 */
export function createMouseFilter(onMouse) {
  let pending = "";
  return {
    feed(chunk) {
      let s = pending + chunk;
      pending = "";
      const m = PARTIAL.exec(s);
      if (m) { pending = m[0]; s = s.slice(0, m.index); }
      return s.replace(SGR, (_all, b, x, y, f) => { onMouse(decodeMouse(b, x, y, f)); return ""; });
    },
  };
}

/**
 * Turns raw mouse events into gestures:
 *   { type: "click", x, y, count }               press + release in the same cell (count 2 = double-click)
 *   { type: "select", anchor, head, done }        press, move to another cell (done=true on release)
 *   { type: "wheel", dir, x, y }
 *   { type: "press", x, y }                       any left press (lets the app clear an old selection)
 */
export class Gestures {
  constructor({ doubleClickMs = 400 } = {}) {
    this.down = null;
    this.dragging = false;
    this.last = null; // last click, for double-click detection
    this.doubleClickMs = doubleClickMs;
  }

  handle(ev, now = Date.now()) {
    if (ev.wheel) return { type: "wheel", dir: ev.wheel, x: ev.x, y: ev.y };
    if (ev.button !== "left" && !(ev.motion && this.down)) return null;
    const at = { x: ev.x, y: ev.y };

    if (!ev.release && !ev.motion) {
      this.down = at;
      this.dragging = false;
      return { type: "press", ...at };
    }
    if (!this.down) return null;
    const moved = at.x !== this.down.x || at.y !== this.down.y;

    if (ev.motion && !ev.release) {
      if (!moved && !this.dragging) return null;
      this.dragging = true;
      return { type: "select", anchor: this.down, head: at, done: false };
    }

    // release
    const down = this.down;
    this.down = null;
    if (this.dragging || moved) {
      this.dragging = false;
      this.last = null;
      return { type: "select", anchor: down, head: at, done: true };
    }
    const repeat = this.last && now - this.last.t <= this.doubleClickMs && this.last.y === at.y && Math.abs(this.last.x - at.x) <= 1;
    const count = repeat ? this.last.count + 1 : 1;
    this.last = { ...at, t: now, count };
    return { type: "click", ...at, count };
  }
}

/** Order a selection so start <= end in reading order. End is inclusive. */
export function normalizeSelection(a, b) {
  return a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
}

/** [startCol, endColExclusive] selected on row y, or null. */
export function selectedSpan(sel, y, width) {
  const [s, e] = normalizeSelection(sel.anchor, sel.head);
  if (y < s.y || y > e.y) return null;
  const from = y === s.y ? s.x : 0;
  const to = y === e.y ? e.x + 1 : width;
  return to > from ? [from, to] : null;
}

/** Text covered by a selection over `lines` (plain strings), like a terminal: flowing, trailing spaces trimmed. */
export function selectionText(lines, anchor, head) {
  const [s, e] = normalizeSelection(anchor, head);
  const out = [];
  for (let y = s.y; y <= e.y; y++) {
    const text = lines[y] ?? "";
    const from = y === s.y ? s.x : 0;
    const to = y === e.y ? e.x + 1 : text.length;
    out.push(text.slice(from, to).replace(/\s+$/, ""));
  }
  return out.join("\n");
}

/** OSC 52 "set clipboard" sequence. */
export const osc52 = (text) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
