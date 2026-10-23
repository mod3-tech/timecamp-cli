import { test } from "node:test";
import assert from "node:assert/strict";
import { createMouseFilter, decodeMouse, Gestures, selectionText, selectedSpan, osc52 } from "../lib/mouse.mjs";

const sgr = (b, x, y, f = "M") => `\x1b[<${b};${x};${y}${f}`;

test("decodes SGR buttons, wheel, motion and modifiers (0-based coords)", () => {
  assert.deepEqual(decodeMouse("0", "10", "5", "M"), { x: 9, y: 4, shift: false, meta: false, ctrl: false, motion: false, release: false, button: "left", wheel: null });
  assert.equal(decodeMouse("0", "1", "1", "m").release, true);
  assert.equal(decodeMouse("2", "1", "1", "M").button, "right");
  assert.equal(decodeMouse("32", "1", "1", "M").motion, true);
  assert.equal(decodeMouse("64", "1", "1", "M").wheel, "up");
  assert.equal(decodeMouse("65", "1", "1", "M").wheel, "down");
  const mod = decodeMouse(String(4 + 16), "1", "1", "M");
  assert.ok(mod.shift && mod.ctrl && !mod.meta);
});

test("filter strips mouse reports, keeps keys, and handles reports split across chunks", () => {
  const events = [];
  const f = createMouseFilter((e) => events.push(e));
  assert.equal(f.feed(`a${sgr(0, 3, 4)}b\x1b[A`), "ab\x1b[A");
  assert.equal(events.length, 1);
  assert.equal(f.feed("x\x1b[<0;12"), "x");
  assert.equal(events.length, 1);
  assert.equal(f.feed(";7mq"), "q");
  assert.equal(events.length, 2);
  assert.deepEqual([events[1].x, events[1].y, events[1].release], [11, 6, true]);
  assert.equal(f.feed("\x1b"), "\x1b", "a lone Escape must pass straight through");
});

const ev = (o) => ({ shift: false, meta: false, ctrl: false, motion: false, release: false, button: "left", wheel: null, ...o });

test("press+release in one cell is a click; quick repeat is a double-click", () => {
  const g = new Gestures();
  assert.equal(g.handle(ev({ x: 5, y: 2 }), 0).type, "press");
  assert.deepEqual(g.handle(ev({ x: 5, y: 2, release: true }), 10), { type: "click", x: 5, y: 2, count: 1 });
  g.handle(ev({ x: 6, y: 2 }), 200);
  assert.equal(g.handle(ev({ x: 6, y: 2, release: true }), 210).count, 2);
  g.handle(ev({ x: 6, y: 2 }), 2000);
  assert.equal(g.handle(ev({ x: 6, y: 2, release: true }), 2010).count, 1, "slow second click is a new single click");
});

test("moving to another cell while held is a selection, not a click", () => {
  const g = new Gestures();
  g.handle(ev({ x: 2, y: 1 }));
  assert.equal(g.handle(ev({ x: 2, y: 1, motion: true })), null, "jitter inside the cell is ignored");
  assert.deepEqual(g.handle(ev({ x: 8, y: 3, motion: true })), { type: "select", anchor: { x: 2, y: 1 }, head: { x: 8, y: 3 }, done: false });
  assert.deepEqual(g.handle(ev({ x: 9, y: 3, release: true })), { type: "select", anchor: { x: 2, y: 1 }, head: { x: 9, y: 3 }, done: true });
  // release in a different cell without motion reports still counts as a drag
  g.handle(ev({ x: 0, y: 0 }));
  assert.equal(g.handle(ev({ x: 4, y: 0, release: true })).type, "select");
});

test("wheel and right-click", () => {
  const g = new Gestures();
  assert.deepEqual(g.handle(ev({ button: null, wheel: "down", x: 1, y: 1 })), { type: "wheel", dir: "down", x: 1, y: 1 });
  assert.equal(g.handle(ev({ button: "right", x: 1, y: 1 })), null);
});

test("selection text flows across lines, works backwards, and trims trailing spaces", () => {
  const lines = ["Mon 19 Oct   8h00m   ", "    08:00–12:00  4h00m", "Tue"];
  assert.equal(selectionText(lines, { x: 4, y: 0 }, { x: 9, y: 0 }), "19 Oct");
  assert.equal(selectionText(lines, { x: 13, y: 0 }, { x: 14, y: 1 }), "8h00m\n    08:00–12:00");
  assert.equal(selectionText(lines, { x: 14, y: 1 }, { x: 13, y: 0 }), "8h00m\n    08:00–12:00", "drag backwards");
  assert.deepEqual(selectedSpan({ anchor: { x: 13, y: 0 }, head: { x: 3, y: 2 } }, 1, 40), [0, 40]);
  assert.equal(selectedSpan({ anchor: { x: 1, y: 0 }, head: { x: 3, y: 0 } }, 1, 40), null);
});

test("OSC 52 encodes UTF-8 text", () => {
  assert.equal(osc52("08:00–12:00"), `\x1b]52;c;${Buffer.from("08:00–12:00").toString("base64")}\x07`);
});
