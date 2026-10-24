// Full-screen week editor for TimeCamp. Launched with `timecamp tui`. Raw ANSI, no dependencies.

import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import * as tc from "./core.mjs";
import { MOUSE_ON, MOUSE_OFF, createMouseFilter, Gestures, selectedSpan, selectionText, osc52 } from "./mouse.mjs";

// ---------- terminal drawing ----------

const C = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", gray: "90", inv: "7" };
const CLASS_STYLE = { CAPEX: C.cyan, OPEX: C.magenta, MIXED: C.blue, UNTAGGED: C.red, UNKNOWN: C.yellow };
const CLASS_LABEL = { CAPEX: "CAPEX", OPEX: "OPEX ", MIXED: "MIXED", UNTAGGED: "NOTAG", UNKNOWN: "?    " };

const clean = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ");

/**
 * Render segments into one line of at most `w` visible columns.
 * A segment is a plain string or [text, style?, onClick?]; `onClick` makes that span clickable.
 * `opts.onClick` makes the whole row clickable. Returns { s: styled, plain, zones, onClick }.
 */
function line(w, segs, { inv = false, onClick } = {}) {
  let out = "";
  let plain = "";
  let used = 0;
  const zones = [];
  const base = inv ? "\x1b[7m" : "";
  for (const seg of segs) {
    if (seg == null || seg === false) continue;
    let [text, style, action] = Array.isArray(seg) ? seg : [seg];
    text = clean(text);
    if (used >= w) break;
    if (used + text.length > w) text = `${text.slice(0, Math.max(0, w - used - 1))}…`;
    if (action) zones.push({ x0: used, x1: used + text.length, action });
    used += text.length;
    plain += text;
    out += style ? `\x1b[${style}m${text}\x1b[0m${base}` : text;
  }
  const fill = inv ? " ".repeat(Math.max(0, w - used)) : "";
  return { s: `${base}${out}${fill}\x1b[0m`, plain: plain + fill, zones, onClick };
}

const asLine = (l) => (typeof l === "string" ? { s: l, plain: l, zones: [] } : l);

/** A clickable "key label" hint, e.g. btn("a", "add", fn) → bold "a" + " add". */
const btn = (key, label, fn) => [[key, C.bold, fn], [` ${label}`, "", fn], "  "];

/** Keep the end of a long path, e.g. "… / [L27-1] Software Maintenance / [L27-14] General Bugs". */
function tail(s, w) {
  s = clean(s);
  return s.length <= w ? s : `…${s.slice(s.length - w + 1)}`;
}

const prettyPath = (p) => String(p || "").replace(/^Jira \/ /, "");
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d) => { const o = tc.dateObj(d); return `${WD[o.getDay()]} ${tc.pad(o.getDate())} ${MON[o.getMonth()]}`; };
const isWeekend = (d) => [0, 6].includes(tc.dateObj(d).getDay());
const today = () => tc.parseDate("today");
const hm = (c) => (c || "").slice(0, 5);

function nextWorkday(d) {
  let n = tc.addDays(d, 1);
  while (isWeekend(n)) n = tc.addDays(n, 1);
  return n;
}

// ---------- app shell ----------

class App {
  constructor() {
    this.stack = [];
    this.status = "";
    this.statusStyle = C.gray;
    this.busy = false;
    this.tasks = null; // full list, loaded in the background
    this.tasksError = null;
    this.tags = [];
    this.recent = []; // [{id, name}] most-recently-used tasks
    this.taskById = new Map();
    this.frame = []; // last rendered lines: { s, plain, zones, onClick }
    this.gestures = new Gestures();
    this.selection = null; // { anchor, head } while dragging / after copying
  }

  setTasks(tasks) {
    this.tasks = tasks;
    this.taskById = new Map(tasks.map((t) => [t.id, t]));
    tc.searchTasks(tasks, "", 1); // build the search index now, not on the first keystroke in the picker
  }

  recentAdd(t) {
    if (!t) return;
    this.recent = [{ id: t.id, name: t.name }, ...this.recent.filter((r) => r.id !== t.id)].slice(0, 30);
  }

  get top() { return this.stack[this.stack.length - 1]; }
  push(s) { this.stack.push(s); this.render(); }
  pop() { this.stack.pop(); this.render(); }

  flash(msg, style = C.gray) { this.status = msg; this.statusStyle = style; this.render(); }
  error(e) { this.flash(e instanceof tc.CliError ? e.message.split("\n")[0] : String(e?.message || e), C.red); }

  async run(label, fn) {
    if (this.busy) return;
    this.busy = true;
    this.flash(`${label}…`, C.yellow);
    try { return await fn(); } catch (e) { this.error(e); } finally { this.busy = false; this.render(); }
  }

  taskPath(id) {
    const t = this.taskById.get(id);
    return t ? prettyPath(t.path) : this.recent.find((r) => r.id === id)?.name || (id ? `task ${id}` : "");
  }

  render() {
    const w = process.stdout.columns || 100;
    const h = process.stdout.rows || 30;
    const body = this.top ? this.top.render(w, h - 1) : [];
    const lines = body.slice(0, h - 1).map(asLine);
    while (lines.length < h - 1) lines.push(asLine(""));
    lines.push(line(w, [[` ${this.status}`, this.statusStyle]]));
    this.frame = lines;
    const sel = this.selection;
    const rows = lines.map((l, y) => {
      const span = sel && selectedSpan(sel, y, w);
      if (!span) return `${l.s}\x1b[K`;
      const p = l.plain.padEnd(w);
      return `${p.slice(0, span[0])}\x1b[7m${p.slice(span[0], span[1])}\x1b[0m${p.slice(span[1])}\x1b[K`;
    });
    process.stdout.write(`\x1b[H${rows.join("\n")}\x1b[J`);
  }

  async onMouse(ev) {
    const g = this.gestures.handle(ev);
    if (!g) return;
    if (g.type === "press") {
      if (this.selection) { this.selection = null; this.render(); }
      return;
    }
    if (g.type === "select") {
      this.selection = { anchor: g.anchor, head: g.head };
      if (g.done) return this.copySelection();
      return this.render();
    }
    if (this.busy) return;
    try {
      if (g.type === "wheel") {
        await this.top?.onWheel?.(g.dir === "up" ? -1 : 1);
      } else if (g.type === "click") {
        const row = this.frame[g.y];
        const zone = row?.zones.find((z) => g.x >= z.x0 && g.x < z.x1);
        const action = zone?.action || row?.onClick || this.top?.onClickAnywhere?.bind(this.top);
        if (!action) return;
        if (!this.busy) this.status = "";
        await action(g);
      }
    } catch (e) { this.error(e); }
    this.render();
  }

  copySelection() {
    const { anchor, head } = this.selection;
    const text = selectionText(this.frame.map((l) => l.plain), anchor, head);
    if (!text.trim()) { this.selection = null; return this.render(); }
    process.stdout.write(osc52(text));
    const cmd = tc.loadConfig().clipboardCommand;
    if (Array.isArray(cmd) && cmd.length) {
      try {
        const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", () => this.flash(`Clipboard command "${cmd[0]}" failed`, C.red));
        child.stdin.end(text);
      } catch { /* reported via the error event */ }
    }
    const n = text.length;
    this.flash(`Copied ${n} character${n === 1 ? "" : "s"} to the clipboard.`, C.green);
  }

  async onKey(str, key) {
    if (key?.ctrl && key.name === "c") return this.quit();
    if (this.selection) { this.selection = null; }
    if (this.busy) return;
    this.status = "";
    try { await this.top?.onKey(str, key || {}); } catch (e) { this.error(e); }
    this.render();
  }

  quit() {
    process.stdout.write(`${MOUSE_OFF}\x1b[?25h\x1b[?1049l`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  }
}

// ---------- week view ----------

class WeekScreen {
  constructor(app, weekOf) {
    this.app = app;
    this.from = tc.mondayOf(weekOf || today());
    this.entries = [];
    this.rows = [];
    this.sel = 0;
    this.scroll = 0;
    this.confirm = null; // { prompt, onYes }
    this.loaded = false;
    this.cache = new Map(); // week start -> entries, as last fetched
    this.latest = new Map(); // week start -> newest fetch seq, so an older response never overwrites a newer one
    this.seq = 0;
    this.grid = true; // task x day hours grid (default); `v` switches to the day list
    this.extra = []; // rows added with `a` that have no entries yet: { task, tags: [{id, name}] }
    this.gr = 0; // grid cursor row (== groups().length is the "add row" line)
    this.gc = Math.max(0, Math.min(6, (new Date().getDay() + 6) % 7)); // grid cursor column: today, Mon..Sun
    this.typed = null; // hours being typed into the current cell
  }

  get to() { return tc.addDays(this.from, 6); }
  get days() { return [...Array(7)].map((_, i) => tc.addDays(this.from, i)); }
  get current() { return this.rows[this.sel]; }

  async fetchWeek(from) {
    const seq = ++this.seq;
    this.latest.set(from, seq);
    const [es, approval] = await Promise.all([tc.fetchEntries({ from, to: tc.addDays(from, 6) }), tc.weekApproval(from)]);
    es.approval = approval;
    if (this.latest.get(from) !== seq) return null;
    this.cache.set(from, es);
    return es;
  }

  show(from, es, key) {
    if (!es || from !== this.from) return;
    this.entries = es;
    this.loaded = true;
    this.buildRows(key);
  }

  /** Fetches the week, blocking input. With `cached`, shows a cached copy at once and refreshes it in the background. */
  async load({ keep, cached, first } = {}) {
    const prevKey = keep ?? this.selKey();
    const from = this.from;
    if (cached && this.cache.has(from)) {
      this.show(from, this.cache.get(from), prevKey);
      this.app.flash("");
      this.fetchWeek(from).then((es) => { this.show(from, es, this.selKey()); this.app.render(); }, () => {});
    } else {
      await this.app.run("Loading week", async () => {
        this.show(from, await (first ?? this.fetchWeek(from)), prevKey);
        this.app.flash("");
      });
    }
    for (const n of [-7, 7]) {
      const f = tc.addDays(from, n);
      if (!this.cache.has(f)) this.fetchWeek(f).catch(() => {});
    }
  }

  selKey() {
    const r = this.current;
    return r ? (r.entry ? `e${r.entry.id}` : `d${r.date}`) : null;
  }

  buildRows(key) {
    this.rows = [];
    for (const d of this.days) {
      this.rows.push({ date: d });
      for (const e of this.entries.filter((x) => x.date === d)) this.rows.push({ date: d, entry: e });
    }
    let idx = key ? this.rows.findIndex((r) => (r.entry ? `e${r.entry.id}` : `d${r.date}`) === key) : -1;
    if (idx < 0 && key?.startsWith("d")) idx = this.rows.findIndex((r) => r.date === key.slice(1));
    if (idx < 0) idx = Math.max(0, this.rows.findIndex((r) => !r.entry && r.date === today()));
    this.sel = Math.min(idx, this.rows.length - 1);
  }

  dayEntries(d) { return this.entries.filter((e) => e.date === d); }

  header(w) {
    const out = [];
    const total = this.entries.reduce((s, e) => s + e.duration, 0);
    const ct = tc.classTotals(this.entries);
    const user = this.app.user?.display_name || "";
    out.push(line(w, [
      [" TimeCamp ", `${C.bold};${C.inv}`], ` ${user}   `,
      ["‹ h", C.gray, () => this.shiftWeek(-1)], ["  week  ", C.gray], ["l ›", C.gray, () => this.shiftWeek(1)], "   ",
      ["t today", C.gray, () => this.gotoWeek(today())], "   ",
      ["q quit", C.gray, () => this.app.quit()],
    ]));
    const head = [
      [`Week of ${dayLabel(this.from)} – ${dayLabel(this.to)} ${this.to.slice(0, 4)}`, C.bold],
      `   Total ${tc.fmtDuration(total)}`,
      ...(this.submitted() ? ["   ", [this.entries.approval === 1 ? "APPROVED" : "SUBMITTED (pending approval)", `${C.bold};${C.yellow}`]] : []),
      ...(this.entries.approval === undefined ? ["   ", ["approval unknown", C.gray]] : []),
    ];
    if (tc.hasClassification()) {
      for (const k of ["CAPEX", "OPEX", "MIXED", "UNTAGGED", "UNKNOWN"]) {
        if (ct[k] || k === "CAPEX" || k === "OPEX") head.push("   ", [`${CLASS_LABEL[k].trim()} ${tc.hours(ct[k])}h`, CLASS_STYLE[k]]);
      }
    }
    out.push(line(w, head));
    out.push(line(w, [["─".repeat(w), C.gray]]));
    return out;
  }

  confirmLine(w) {
    return line(w, [[` ${this.confirm.prompt} `, `${C.bold};${C.yellow}`], ["[ y: yes ]", `${C.bold};${C.green}`, () => this.answer(true)], " ", ["[ n: no ]", C.bold, () => this.answer(false)]]);
  }

  render(w, h) {
    const out = this.header(w);
    if (this.grid) return this.renderGrid(w, h, out);
    const footer = this.confirm
      ? [this.confirmLine(w)]
      : [line(w, [
        ...btn("v", "grid", () => { this.grid = true; }),
        ...btn("a", "add", () => this.add()),
        ...btn("e", "edit", () => this.withEntry((e) => this.edit(e))),
        ...btn("c", "copy to next day", () => this.withEntry((e) => this.copyNext(e))),
        ...btn("d", "delete", () => this.withEntry((e) => this.askDelete(e))),
        ...btn("p", "copy previous week", () => this.askCopyPrevWeek()),
        ...btn("r", "refresh", () => this.load()),
        ...btn("?", "help", () => this.app.push(new HelpScreen(this.app))),
      ])];
    const avail = Math.max(1, h - out.length - footer.length);

    if (!this.loaded) {
      out.push(line(w, [["  Loading…", C.gray]]));
    } else {
      if (this.sel < this.scroll) this.scroll = this.sel;
      if (this.sel >= this.scroll + avail) this.scroll = this.sel - avail + 1;
      const target = tc.dayHours() * 3600;
      for (let i = this.scroll; i < Math.min(this.rows.length, this.scroll + avail); i++) {
        const r = this.rows[i];
        const inv = i === this.sel;
        if (!r.entry) {
          const es = this.dayEntries(r.date);
          const sum = es.reduce((s, e) => s + e.duration, 0);
          const short = !isWeekend(r.date) && r.date <= today() && sum < target;
          const segs = [
            [` ${dayLabel(r.date)}`, isWeekend(r.date) ? C.gray : C.bold],
            r.date === today() ? [" today", C.cyan] : "      ",
            "  ",
            [sum ? tc.fmtDuration(sum).padStart(6) : "     -", short ? C.yellow : sum ? C.green : C.gray],
          ];
          if (short && sum) segs.push([`  (${tc.fmtDuration(target - sum)} short)`, C.yellow]);
          if (!sum && !isWeekend(r.date) && r.date <= today()) segs.push(["  nothing logged", C.yellow]);
          out.push(line(w, segs, { inv, onClick: (g) => this.clickRow(i, g) }));
        } else {
          const e = r.entry;
          const tags = e.tags.map((t) => t.name).join(", ");
          const segs = [
            `    ${e.start}–${e.end}  `,
            [tc.fmtDuration(e.duration).padStart(6), C.bold],
            "  ",
            tc.hasClassification() ? [CLASS_LABEL[e.class], CLASS_STYLE[e.class]] : null,
            tc.hasClassification() ? "  " : null,
            [e.task || "(no task)", e.task ? "" : C.red],
            tags ? [`  · ${tags}`, C.gray] : ["  · no tags", C.red],
            e.note ? [`  · ${e.note}`, C.dim] : null,
            e.locked ? ["  [locked]", C.yellow] : null,
          ];
          out.push(line(w, segs, { inv, onClick: (g) => this.clickRow(i, g) }));
        }
      }
    }
    while (out.length < h - footer.length) out.push("");
    return [...out, ...footer];
  }

  move(delta) {
    this.sel = Math.max(0, Math.min(this.rows.length - 1, this.sel + delta));
  }

  onWheel(dir) { this.move(dir); }

  clickRow(i, g) {
    this.sel = i;
    if (g.count >= 2) return this.activate();
  }

  /** Enter / double-click: edit an entry, or add one on a day. */
  activate() {
    const r = this.current;
    if (!r) return;
    return r.entry ? this.edit(r.entry) : this.add();
  }

  add() {
    const r = this.current;
    if (r) this.app.push(new FormScreen(this.app, this, this.newEntryDefaults(r.date)));
  }

  shiftWeek(n) { return this.gotoWeek(tc.addDays(this.from, 7 * n)); }

  withEntry(fn) {
    const e = this.current?.entry;
    if (!e) return this.app.flash("Select an entry first (click it, or move with ↑↓).", C.yellow);
    return fn(e);
  }

  async answer(yes) {
    const c = this.confirm;
    this.confirm = null;
    if (!c) return;
    if (yes) await c.onYes();
    else this.app.flash("Cancelled.");
  }

  async gotoWeek(from) {
    this.from = tc.mondayOf(from);
    this.loaded = false;
    this.sel = 0;
    this.scroll = 0;
    await this.load({ keep: `d${this.from}`, cached: true });
  }

  /** Defaults for a new entry on `date`: continue after the day's last entry, fill toward the daily target. */
  newEntryDefaults(date) {
    const es = this.dayEntries(date);
    const last = es.reduce((m, e) => (e.end > m ? e.end : m), "");
    const startSec = last ? tc.clockToSec(`${last}:00`) : tc.clockToSec(tc.dayStart());
    const remaining = tc.dayHours() * 3600 - es.reduce((s, e) => s + e.duration, 0);
    const endSec = Math.min(startSec + (remaining > 0 ? remaining : 3600), 23 * 3600 + 59 * 60);
    // reuse the epic/tags of the nearest earlier entry this week, else the most recent one
    const before = [...this.entries].reverse().find((e) => e.date <= date) || this.entries[this.entries.length - 1] || this.app.lastEntry;
    return {
      date,
      start: hm(tc.secToClock(startSec)),
      end: hm(tc.secToClock(endSec)),
      task: before?.task_id ? { id: before.task_id, name: before.task } : null,
      tags: before?.tags?.map((t) => ({ id: t.id, tag: t.name, list_id: t.list_id, class: tc.classOfList(t.list_id) })) || [],
      note: "",
    };
  }

  async onKey(str, key) {
    if (this.confirm) return this.answer(str === "y" || str === "Y");
    if (this.grid) return this.gridKey(str, key);
    const r = this.current;
    switch (key.name === "return" ? "enter" : str || key.name) {
      case "q": return this.app.quit();
      case "v": this.grid = true; return;
      case "j": case "down": return this.move(1);
      case "k": case "up": return this.move(-1);
      case "J": return this.jumpDay(1);
      case "K": return this.jumpDay(-1);
      case "h": case "left": case "[": return this.shiftWeek(-1);
      case "l": case "right": case "]": return this.shiftWeek(1);
      case "t": return this.gotoWeek(today());
      case "r": return this.load();
      case "?": return this.app.push(new HelpScreen(this.app));
      case "a": return this.add();
      case "enter": return this.activate();
      case "e": return this.withEntry((e) => this.edit(e));
      case "c": return this.withEntry((e) => this.copyNext(e));
      case "d": case "x": return this.withEntry((e) => this.askDelete(e));
      case "p": return this.askCopyPrevWeek();
      default:
        if (key.name === "pagedown") return this.move(10);
        if (key.name === "pageup") return this.move(-10);
        if (key.name === "home" || str === "g") { this.sel = 0; return; }
        if (key.name === "end" || str === "G") { this.sel = this.rows.length - 1; }
    }
  }

  // ---------- grid view ----------

  /** One row per task+tags combination: this week's entries, rows added with `a`, and last week's rows (so a new week starts filled in). */
  /** TimeCamp has the week submitted for approval (2) or approved (1). */
  submitted() { return [1, 2].includes(this.entries.approval); }

  groups() {
    const m = new Map();
    const add = (task_id, task, tags) => {
      const k = `${task_id}|${tags.map((t) => t.id).sort().join()}`;
      if (!m.has(k)) m.set(k, { task_id, task, tags, cells: {} });
      return m.get(k);
    };
    if (!this.submitted()) {
      for (const e of this.cache.get(tc.addDays(this.from, -7)) || []) if (e.task_id) add(e.task_id, e.task, e.tags);
      for (const x of this.extra) add(x.task.id, x.task.name, x.tags);
    }
    for (const e of this.entries) { const g = add(e.task_id, e.task, e.tags); (g.cells[e.date] ||= []).push(e); }
    return [...m.values()];
  }

  renderGrid(w, h, out) {
    const gs = this.groups();
    this.gr = Math.min(this.gr, gs.length);
    const lw = Math.max(12, w - 2 - 7 * 7 - 8);
    const hrs = (sec) => (sec ? String(tc.hours(sec)) : "·");
    const days = this.days;
    out.push(line(w, [" ".repeat(lw + 2), ...days.map((d) => [`${dayLabel(d).slice(0, 6)} `, d === today() ? `${C.bold};${C.cyan}` : isWeekend(d) || d > today() ? C.gray : C.bold]), ["  Total", C.bold]]));
    gs.forEach((g, gi) => {
      const path = g.task_id ? this.app.taskPath(g.task_id) || g.task : "(no task)";
      let sum = 0;
      const segs = [" ", [tail(path, lw).padEnd(lw), g.task_id ? "" : C.red], " "];
      days.forEach((d, di) => {
        const es = g.cells[d] || [];
        const sec = es.reduce((s, e) => s + e.duration, 0);
        sum += sec;
        const on = gi === this.gr && di === this.gc;
        const text = on && this.typed !== null ? `${this.typed}▏` : `${hrs(sec)}${es.length > 1 ? "+" : ""}`;
        const style = on ? `${C.bold};${C.inv}` : es.some((e) => e.locked) ? C.yellow : sec ? C.green : C.gray;
        segs.push([text.padStart(6).slice(-6), style, (ev) => { this.typed = null; this.gr = gi; this.gc = di; if (ev.count >= 2) this.typed = ""; }], " ");
      });
      segs.push([` ${hrs(sum)}`.padStart(7), C.bold]);
      out.push(line(w, segs));
      const tags = g.tags.map((t) => t.name).join(", ");
      out.push(line(w, [`   `, tags ? [tags, C.gray] : ["no tags", C.red]]));
    });
    out.push(line(w, [[" + add project/task", C.cyan]], { inv: this.gr === gs.length, onClick: () => { this.gr = gs.length; return this.addRow(); } }));
    const dayTotals = days.map((d) => this.dayEntries(d).reduce((s, e) => s + e.duration, 0));
    out.push(line(w, [["─".repeat(w), C.gray]]));
    out.push(line(w, [" ", ["Total".padEnd(lw), C.bold], " ", ...dayTotals.map((t, i) => [hrs(t).padStart(6), t >= tc.dayHours() * 3600 ? C.green : !isWeekend(days[i]) && days[i] <= today() ? C.yellow : C.gray]).flatMap((x) => [x, " "]),
      [` ${hrs(dayTotals.reduce((s, t) => s + t, 0))}`.padStart(7), C.bold]]));
    const footer = this.confirm
      ? [this.confirmLine(w)]
      : [line(w, [
        ...btn("0-9 Enter", "set hours", () => { if (this.gr < gs.length) this.typed = ""; }),
        ...btn("f", "fill Mon–Fri", () => this.fillRow()),
        ...btn("a", "add row", () => this.addRow()),
        ...btn("p", "copy prev week", () => this.askCopyPrevWeek()),
        ...btn("r", "refresh", () => this.load()),
        ...btn("v", "list view", () => { this.grid = false; }),
        ...btn("?", "help", () => this.app.push(new HelpScreen(this.app))),
      ]), line(w, [["  hjkl move · [ ] change week · d clear cell · Enter saves, Esc cancels typing", C.gray]]),
        line(w, [["  Colours: ", C.gray], ["green", C.green], [` hours / day at ${tc.dayHours()}h · `, C.gray], ["yellow", C.yellow], [" past day short or entry locked · ", C.gray], ["red", C.red], [" missing task or tags · ", C.gray], ["cyan", C.cyan], [" today · ", C.gray], ["gray", C.gray], [" weekend/future", C.gray]])];
    while (out.length < h - footer.length) out.push("");
    return [...out.slice(0, h - footer.length), ...footer];
  }

  addRow() {
    this.app.push(new TaskPicker(this.app, (task) => this.app.push(new TagPicker(this.app, [], (tags) => {
      if (!tags.length) return this.app.flash("Pick at least one tag.", C.yellow);
      this.extra.push({ task, tags: tags.map((t) => ({ id: t.id, name: t.tag })) });
      this.app.recentAdd(task);
      this.gr = this.groups().length - 1;
    }))));
  }

  /** Set one cell to `sec` seconds: create, resize or delete the day's single entry. */
  async writeCell(g, date, sec) {
    const es = g.cells[date] || [];
    if (es.length > 1) tc.die("Several entries that day: press v for the list to edit them.");
    const e = es[0];
    if (this.submitted()) tc.die("This week is submitted (approved or pending approval), so it can't be edited.");
    if (e?.locked) tc.die("That entry is locked (approved or pending approval).");
    if (e) {
      if (sec === e.duration) return;
      if (!sec) return tc.deleteEntry(e.id);
      const end = tc.clockToSec(`${e.start}:00`) + sec;
      if (end >= 86400) tc.die("That would run past midnight; use the list view.");
      const newEnd = hm(tc.secToClock(end));
      const hit = this.dayEntries(date).find((x) => x.id !== e.id && x.start < newEnd && x.end > e.start);
      if (hit) tc.die(`Would overlap ${hit.start}–${hit.end}; use the list view.`);
      const { body } = await tc.buildEntryPayload({ start: e.start, end: newEnd }, { forUpdate: true });
      return tc.updateEntry(e.id, body);
    }
    if (!sec) return;
    if (!g.task_id) tc.die("Entries without a task can't be created here.");
    const last = this.dayEntries(date).reduce((m, x) => (x.end > m ? x.end : m), "");
    const start = last ? tc.clockToSec(`${last}:00`) : tc.clockToSec(tc.dayStart());
    if (start + sec >= 86400) tc.die(`Doesn't fit after the day's last entry (${last}); use the list view.`);
    const { body, tags } = await tc.buildEntryPayload({ date, start: hm(tc.secToClock(start)), end: hm(tc.secToClock(start + sec)), task: g.task_id, tags: g.tags.map((t) => t.id) });
    const res = await tc.createEntry(body, tags, { existing: this.entries });
    if (res.skipped) tc.die(`Overlaps ${res.duplicateOf.start}–${res.duplicateOf.end} ${res.duplicateOf.task}.`);
  }

  async setCells(label, g, jobs) {
    let ok = false;
    // keep the row on screen even if its last cell gets cleared
    if (g.task_id && !this.extra.some((x) => x.task.id === g.task_id && x.tags.map((t) => t.id).sort().join() === g.tags.map((t) => t.id).sort().join())) this.extra.push({ task: { id: g.task_id, name: g.task }, tags: g.tags });
    await this.app.run(label, async () => {
      for (const [date, sec] of jobs) await this.writeCell(g, date, sec);
      ok = true;
    });
    const { status, statusStyle } = this.app;
    await this.load(); // after run(): load() is a no-op while busy; also shows what was saved when a later cell failed
    if (!ok) this.app.flash(status, statusStyle); // load() cleared the error
    return ok;
  }

  async fillRow() {
    const g = this.groups()[this.gr];
    if (!g) return;
    const jobs = this.days.filter((d) => !isWeekend(d) && !g.cells[d]).map((d) => [d, tc.dayHours() * 3600]);
    if (!jobs.length) return this.app.flash("Nothing to fill: every weekday in this row already has hours.", C.yellow);
    if (await this.setCells("Filling", g, jobs)) this.app.flash(`Filled ${jobs.length} day${jobs.length === 1 ? "" : "s"} with ${tc.dayHours()}h.`, C.green);
  }

  async gridKey(str, key) {
    const n = this.groups().length;
    this.gr = Math.min(this.gr, n);
    if (this.typed !== null) {
      if (key.name === "escape") { this.typed = null; return; }
      if (key.name === "backspace") { this.typed = this.typed.slice(0, -1); return; }
      if (key.name === "return") {
        const v = this.typed;
        this.typed = null;
        const g = this.groups()[this.gr];
        const sec = v.trim() ? tc.parseDuration(v) : 0; // empty = clear the cell
        if (await this.setCells("Saving", g, [[this.days[this.gc], sec]]) && this.gc < 6) this.gc++;
        return;
      }
      if (str && /^[0-9.:hm]$/.test(str)) this.typed += str;
      return;
    }
    switch (key.name === "return" ? "enter" : str || key.name) {
      case "q": return this.app.quit();
      case "v": this.grid = false; return;
      case "h": case "left":
        if (this.gc > 0) { this.gc--; return; }
        this.gc = 6; return this.shiftWeek(-1); // past Monday: previous week's Sunday
      case "l": case "right":
        if (this.gc < 6) { this.gc++; return; }
        this.gc = 0; return this.shiftWeek(1);
      case "j": case "down": this.gr = Math.min(n, this.gr + 1); return;
      case "k": case "up": this.gr = Math.max(0, this.gr - 1); return;
      case "[": return this.shiftWeek(-1);
      case "]": return this.shiftWeek(1);
      case "t": return this.gotoWeek(today());
      case "r": return this.load();
      case "?": return this.app.push(new HelpScreen(this.app));
      case "p": return this.askCopyPrevWeek();
      case "a": return this.addRow();
      case "f": return this.fillRow();
      case "enter": if (this.gr === n) return this.addRow(); this.typed = ""; return;
      case "d": case "x": case "backspace": {
        const g = this.groups()[this.gr];
        if (g?.cells[this.days[this.gc]]) return this.setCells("Clearing", g, [[this.days[this.gc], 0]]);
        return;
      }
      default:
        if (/^[0-9]$/.test(str || "") && this.gr < n) this.typed = str;
    }
  }

  jumpDay(dir) {
    const cur = this.current?.date;
    const idx = this.rows.findIndex((x, i) => (dir > 0 ? i > this.sel : true) && !x.entry && (dir > 0 ? x.date > cur : x.date < cur));
    if (dir > 0 && idx >= 0) this.sel = idx;
    if (dir < 0) {
      const prevDays = this.rows.map((x, i) => [x, i]).filter(([x]) => !x.entry && x.date < cur);
      if (prevDays.length) this.sel = prevDays[prevDays.length - 1][1];
    }
  }

  entryToForm(e, overrides = {}) {
    return {
      date: e.date,
      start: e.start,
      end: e.end,
      task: e.task_id ? { id: e.task_id, name: e.task } : null,
      tags: e.tags.map((t) => ({ id: t.id, tag: t.name, list_id: t.list_id, class: tc.classOfList(t.list_id) })),
      note: e.note,
      ...overrides,
    };
  }

  edit(e) {
    if (e.locked) return this.app.flash("That entry is locked (approved or pending approval) and can't be edited.", C.yellow);
    this.app.push(new FormScreen(this.app, this, this.entryToForm(e), e));
  }

  copyNext(e) {
    const date = nextWorkday(e.date);
    this.app.push(new FormScreen(this.app, this, this.entryToForm(e, { date })));
  }

  askDelete(e) {
    if (e.locked) return this.app.flash("That entry is locked and can't be deleted.", C.yellow);
    this.confirm = {
      prompt: `Delete ${e.date} ${e.start}–${e.end} ${e.task || ""} (${tc.fmtDuration(e.duration)})?`,
      onYes: async () => {
        let ok = false;
        await this.app.run("Deleting", async () => {
          await tc.deleteEntry(e.id);
          this.move(-1);
          ok = true;
        });
        if (!ok) return;
        await this.load();
        this.app.flash(`Deleted entry ${e.id}.`, C.green);
      },
    };
  }

  async askCopyPrevWeek() {
    const prevFrom = tc.addDays(this.from, -7);
    let prev = [];
    await this.app.run("Reading previous week", async () => {
      prev = (await tc.fetchEntries({ from: prevFrom, to: tc.addDays(prevFrom, 6) })).filter((e) => e.start && e.end && e.duration > 0);
      this.app.flash("");
    });
    if (!prev.length) return this.app.flash(`Nothing to copy from the week of ${dayLabel(prevFrom)}.`, C.yellow);
    const total = prev.reduce((s, e) => s + e.duration, 0);
    this.confirm = {
      prompt: `Copy ${prev.length} entries (${tc.fmtDuration(total)}) from week of ${dayLabel(prevFrom)} into this week? Overlaps are skipped.`,
      onYes: async () => {
        let created = 0;
        let skipped = 0;
        let ok = false;
        await this.app.run("Copying", async () => {
          const existing = await tc.fetchEntries({ from: this.from, to: this.to }); // not the cached week
          for (const e of prev) {
            const { body, tags } = await tc.buildEntryPayload({
              date: tc.addDays(e.date, 7), start: e.start, end: e.end, task: e.task_id ?? undefined, note: e.note, tags: e.tags.map((t) => t.id),
            });
            const res = await tc.createEntry(body, tags, { existing });
            if (res.skipped) { skipped++; continue; }
            created++;
            existing.push({ ...e, id: res.id, date: body.date });
          }
          ok = true;
        });
        await this.load();
        if (!ok) return this.app.flash(`Copy stopped after ${created} entries. Check the week and press p again; it skips what's already there.`, C.red);
        this.app.flash(`Copied ${created} entries${skipped ? `, skipped ${skipped} that overlapped` : ""}.`, C.green);
      },
    };
  }
}

// ---------- add / edit form ----------

const FIELDS = [
  { key: "date", label: "Date", type: "text", hint: "YYYY-MM-DD, today, -1" },
  { key: "start", label: "Start", type: "text", hint: "HH:MM" },
  { key: "end", label: "End", type: "text", hint: "HH:MM" },
  { key: "task", label: "Epic", type: "task", hint: "Enter to search" },
  { key: "tags", label: "Tags", type: "tags", hint: "Enter to choose" },
  { key: "note", label: "Note", type: "text", hint: "optional" },
  { key: "save", label: "", type: "button" },
];

class FormScreen {
  constructor(app, week, values, original = null) {
    this.app = app;
    this.week = week;
    this.v = { ...values };
    this.original = original;
    this.focus = original ? 0 : 3; // new entries usually start by choosing the epic
    if (!original && this.v.task) this.focus = 6;
    this.err = "";
    this.force = false;
    this.fresh = true; // first keystroke in a text field replaces its contents
  }

  render(w) {
    const out = [];
    const title = this.original ? `Edit entry ${this.original.id}` : "New entry";
    out.push(line(w, [[` ${title} `, `${C.bold};${C.inv}`], ["   ↑↓/Tab move · Enter choose/next · ", C.gray],
      ["Ctrl-S save", C.gray, () => this.save()], [" · ", C.gray], ["Esc cancel", C.gray, () => this.app.pop()]]));
    out.push("");
    for (const [i, f] of FIELDS.entries()) {
      const focused = i === this.focus;
      if (f.type === "button") {
        out.push("");
        out.push(line(w, ["           ", [this.original ? "[ Save changes ]" : "[ Create entry ]", focused ? `${C.bold};${C.inv}` : C.bold, () => this.save()],
          "   ", ["[ Cancel ]", C.gray, () => this.app.pop()]]));
        continue;
      }
      let val;
      let style = "";
      if (f.type === "task") val = this.v.task ? this.app.taskPath(this.v.task.id) || this.v.task.name : "";
      else if (f.type === "tags") val = this.v.tags.map((t) => t.tag).join(", ");
      else val = this.v[f.key] ?? "";
      if (!val) { val = f.hint; style = C.gray; }
      const label = `  ${f.label.padEnd(6)} `;
      const segs = [[label, focused ? `${C.bold};${C.inv}` : C.bold], " "];
      if (f.type === "task") segs.push([tail(val, w - label.length - 3), style]);
      else segs.push([val, style]);
      if (focused && f.type === "text") segs.push(["▏", C.cyan]);
      if (f.type === "tags" && this.v.tags.length && tc.hasClassification()) {
        const cls = tc.classifyTags(this.v.tags);
        segs.push("  ", [CLASS_LABEL[cls].trim(), CLASS_STYLE[cls]]);
      }
      out.push(line(w, segs, { onClick: () => this.openField(i) }));
    }
    out.push("");
    const dur = this.duration();
    out.push(line(w, ["  Duration ", [dur ? tc.fmtDuration(dur) : "—", C.bold]]));
    if (this.err) out.push(line(w, [`  ${this.err}`, C.red]));
    return out;
  }

  /** Focus a field; Epic and Tags open their pickers, the button saves. */
  openField(i) {
    const f = FIELDS[i];
    this.focus = i;
    this.fresh = true;
    if (f.type === "task") return this.app.push(new TaskPicker(this.app, (t) => { this.v.task = t; this.focus = 4; }));
    if (f.type === "tags") return this.app.push(new TagPicker(this.app, this.v.tags, (tags) => { this.v.tags = tags; this.focus = 5; }));
    if (f.type === "button") return this.save();
  }

  duration() {
    try {
      const s = tc.clockToSec(tc.parseClock(this.v.start));
      const e = tc.clockToSec(tc.parseClock(this.v.end));
      return e > s ? e - s : 0;
    } catch { return 0; }
  }

  async onKey(str, key) {
    const f = FIELDS[this.focus];
    if (key.name === "escape") return this.app.pop();
    if (key.ctrl && key.name === "s") return this.save();
    if (key.name === "up" || (key.name === "tab" && key.shift)) { this.focus = (this.focus + FIELDS.length - 1) % FIELDS.length; this.fresh = true; return; }
    if (key.name === "down" || key.name === "tab") { this.focus = (this.focus + 1) % FIELDS.length; this.fresh = true; return; }
    if (key.name === "return") {
      if (f.type === "text") { this.focus++; this.fresh = true; return; }
      return this.openField(this.focus);
    }
    if (f.type !== "text") return;
    if (key.name === "backspace") { this.v[f.key] = String(this.v[f.key] ?? "").slice(0, -1); this.fresh = false; return; }
    if (key.ctrl && key.name === "u") { this.v[f.key] = ""; return; }
    if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
      // date/time fields: typing replaces the value; the note appends
      this.v[f.key] = (this.fresh && f.key !== "note" ? "" : String(this.v[f.key] ?? "")) + str;
      this.fresh = false;
      this.err = "";
      this.force = false;
    }
  }

  async save() {
    this.err = "";
    const v = this.v;
    const tagIds = v.tags.map((t) => t.id);
    if (!v.task) { this.err = "Choose an epic first."; return; }
    if (!tagIds.length && !this.force) {
      this.err = "No tags, so finance can't tell CAPEX from OPEX. Press Ctrl-S again to save anyway.";
      this.force = true;
      return;
    }
    try {
      if (!this.original) {
        const { body, tags } = await tc.buildEntryPayload({ date: v.date, start: v.start, end: v.end, task: v.task.id, note: v.note, tags: tagIds });
        let res;
        await this.app.run("Saving", async () => {
          res = await tc.createEntry(body, tags, { allowDuplicate: this.force && !!this.lastOverlap });
        });
        if (!res) return;
        if (res.skipped) {
          this.lastOverlap = res.duplicateOf;
          this.force = true;
          this.err = `Overlaps ${res.duplicateOf.start}–${res.duplicateOf.end} ${res.duplicateOf.task}. Press Ctrl-S again to save anyway.`;
          this.app.flash("");
          return;
        }
        this.app.pop();
        if (body.date < this.week.from || body.date > this.week.to) this.week.from = tc.mondayOf(body.date);
        await this.week.load({ keep: `e${res.id}` });
        this.app.flash(`Created entry ${res.id} (${tc.fmtDuration(body.duration)}).`, C.green);
        this.app.recentAdd(v.task);
      } else {
        const o = this.original;
        const spec = {};
        if (v.date !== o.date) spec.date = v.date;
        if (v.start !== o.start || v.end !== o.end) { spec.start = v.start; spec.end = v.end; }
        if (v.task.id !== o.task_id) spec.task = v.task.id;
        if (v.note !== o.note) spec.note = v.note;
        const oldTags = o.tags.map((t) => t.id).sort().join(",");
        if ([...tagIds].sort().join(",") !== oldTags) spec.tags = tagIds;
        if (!Object.keys(spec).length) { this.app.pop(); return this.app.flash("No changes."); }
        const { body, tags } = await tc.buildEntryPayload(spec, { forUpdate: true });
        let ok = false;
        await this.app.run("Saving", async () => { await tc.updateEntry(o.id, body, tags); ok = true; });
        if (!ok) return;
        this.app.pop();
        await this.week.load({ keep: `e${o.id}` });
        this.app.flash(`Updated entry ${o.id}.`, C.green);
      }
    } catch (e) {
      this.err = e instanceof tc.CliError ? e.message.split("\n")[0] : String(e.message || e);
    }
  }
}

// ---------- pickers ----------

class TaskPicker {
  constructor(app, onPick) {
    this.app = app;
    this.onPick = onPick;
    this.q = "";
    this.sel = 0;
    this.scroll = 0;
  }

  results() {
    const key = `${this.q}|${!!this.app.tasks}|${this.app.recent.length}`;
    if (this.cacheKey !== key) { this.cacheKey = key; this.cached = this.compute(); }
    return this.cached;
  }

  compute() {
    if (!this.q.trim()) {
      return this.app.recent.map((r) => ({ id: r.id, path: this.app.taskById.get(r.id)?.path || r.name, recent: true }));
    }
    if (this.app.tasks) return tc.searchTasks(this.app.tasks, this.q, 300);
    const terms = this.q.toLowerCase().split(/\s+/).filter(Boolean);
    return this.app.recent.filter((r) => terms.every((t) => r.name.toLowerCase().includes(t))).map((r) => ({ id: r.id, path: r.name, recent: true }));
  }

  render(w, h) {
    const res = this.results();
    this.sel = Math.min(this.sel, Math.max(0, res.length - 1));
    const out = [];
    out.push(line(w, [[" Choose epic ", `${C.bold};${C.inv}`], ["   type to search (all words must match) · ↑↓ · Enter or double-click to pick · ", C.gray],
      ["Esc back", C.gray, () => this.app.pop()]]));
    out.push(line(w, ["  Search: ", [this.q, C.bold], ["▏", C.cyan]]));
    let note;
    if (!this.q.trim()) note = "Recently used:";
    else if (!this.app.tasks) note = this.app.tasksError ? `Task list failed to load: ${this.app.tasksError}` : "Still loading the full task list (first load can take ~30s); showing recent matches only.";
    else note = `${res.length >= 300 ? "300+" : res.length} matches. Epics are listed before stories.`;
    out.push(line(w, [[`  ${note}`, C.gray]]));
    out.push("");
    const avail = Math.max(1, h - out.length);
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + avail) this.scroll = this.sel - avail + 1;
    res.slice(this.scroll, this.scroll + avail).forEach((t, i) => {
      const idx = this.scroll + i;
      out.push(line(w, [`  ${tail(prettyPath(t.path), w - 14)}`, [`  ${t.id}`, C.gray]], {
        inv: idx === this.sel,
        onClick: (g) => { this.sel = idx; if (g.count >= 2) this.pick(); },
      }));
    });
    if (!res.length) out.push(line(w, [["  No matches.", C.yellow]]));
    return out;
  }

  onWheel(dir) { this.sel = Math.max(0, Math.min(this.results().length - 1, this.sel + dir)); }

  pick() {
    const t = this.results()[this.sel];
    if (!t) return;
    this.app.pop();
    this.onPick({ id: t.id, name: t.path.split(" / ").pop() });
  }

  async onKey(str, key) {
    const res = this.results();
    if (key.name === "escape") return this.app.pop();
    if (key.name === "down") { this.sel = Math.min(res.length - 1, this.sel + 1); return; }
    if (key.name === "up") { this.sel = Math.max(0, this.sel - 1); return; }
    if (key.name === "pagedown") { this.sel = Math.min(res.length - 1, this.sel + 10); return; }
    if (key.name === "pageup") { this.sel = Math.max(0, this.sel - 10); return; }
    if (key.name === "return") return this.pick();
    if (key.name === "backspace") { this.q = this.q.slice(0, -1); this.sel = 0; return; }
    if (key.ctrl && key.name === "u") { this.q = ""; this.sel = 0; return; }
    if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") { this.q += str; this.sel = 0; }
  }
}

class TagPicker {
  constructor(app, selected, onDone) {
    this.app = app;
    this.selected = new Map(selected.map((t) => [t.id, t]));
    this.onDone = onDone;
    this.q = "";
    this.sel = 0;
    this.scroll = 0;
  }

  results() {
    const terms = this.q.toLowerCase().split(/\s+/).filter(Boolean);
    return this.app.tags.filter((t) => terms.every((q) => `${t.tag} ${t.list} ${t.class || ""}`.toLowerCase().includes(q)));
  }

  render(w, h) {
    const res = this.results();
    this.sel = Math.min(this.sel, Math.max(0, res.length - 1));
    const out = [];
    out.push(line(w, [[" Choose tags ", `${C.bold};${C.inv}`], ["   type to filter · Space or click to toggle · ", C.gray],
      ["Enter done", C.gray, () => this.done()], [" · ", C.gray], ["Esc cancel", C.gray, () => this.app.pop()]]));
    const chosen = [...this.selected.values()];
    const cls = tc.classifyTags(chosen);
    out.push(line(w, ["  Filter: ", [this.q, C.bold], ["▏", C.cyan], "     Selected: ", [chosen.length ? chosen.map((t) => t.tag).join(", ") : "none", chosen.length ? "" : C.gray],
      chosen.length && tc.hasClassification() ? "  " : null, chosen.length && tc.hasClassification() ? [`→ ${CLASS_LABEL[cls].trim()}`, CLASS_STYLE[cls]] : null]));
    out.push("");
    const avail = Math.max(1, h - out.length - 2); // leave room for the Done / Cancel row
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + avail) this.scroll = this.sel - avail + 1;
    res.slice(this.scroll, this.scroll + avail).forEach((t, i) => {
      const idx = this.scroll + i;
      const on = this.selected.has(t.id);
      out.push(line(w, [
        [on ? "  [x] " : "  [ ] ", on ? `${C.bold};${C.green}` : C.gray],
        t.class ? [`${CLASS_LABEL[t.class]} `, CLASS_STYLE[t.class]] : null,
        t.tag,
        [`  (${t.list})`, C.gray],
      ], { inv: idx === this.sel, onClick: () => { this.sel = idx; this.toggle(t); } }));
    });
    if (!res.length) out.push(line(w, [["  No matches.", C.yellow]]));
    out.push("");
    out.push(line(w, ["  ", ["[ Done ]", C.bold, () => this.done()], "   ", ["[ Cancel ]", C.gray, () => this.app.pop()]]));
    return out;
  }

  onWheel(dir) { this.sel = Math.max(0, Math.min(this.results().length - 1, this.sel + dir)); }

  toggle(t) {
    if (t) this.selected.has(t.id) ? this.selected.delete(t.id) : this.selected.set(t.id, t);
  }

  done() {
    const res = this.results();
    // Enter with nothing toggled picks the highlighted tag, the common one-tag case
    if (!this.selected.size && res[this.sel]) this.selected.set(res[this.sel].id, res[this.sel]);
    this.app.pop();
    this.onDone([...this.selected.values()]);
  }

  async onKey(str, key) {
    const res = this.results();
    if (key.name === "escape") return this.app.pop();
    if (key.name === "down") { this.sel = Math.min(res.length - 1, this.sel + 1); return; }
    if (key.name === "up") { this.sel = Math.max(0, this.sel - 1); return; }
    if (key.name === "pagedown") { this.sel = Math.min(res.length - 1, this.sel + 10); return; }
    if (key.name === "pageup") { this.sel = Math.max(0, this.sel - 10); return; }
    if (key.name === "space") return this.toggle(res[this.sel]);
    if (key.name === "return") return this.done();
    if (key.name === "backspace") { this.q = this.q.slice(0, -1); this.sel = 0; return; }
    if (key.ctrl && key.name === "u") { this.q = ""; this.sel = 0; return; }
    if (str && !key.ctrl && !key.meta && str.length === 1 && str > " ") { this.q += str; this.sel = 0; }
  }
}

// ---------- help ----------

class HelpScreen {
  constructor(app) { this.app = app; }
  render(w) {
    const k = (keys, desc) => line(w, [[`  ${keys.padEnd(21)}`, C.bold], desc]);
    return [
      line(w, [[" Keys ", `${C.bold};${C.inv}`], ["   any key or click to close", C.gray]]),
      "",
      line(w, [["  Grid view (default): rows are task+tags, columns are days. Type hours (8, 7.5, 1:30) + Enter to set a cell; Enter moves right.", C.gray]]),
      k("hjkl / arrows", "move between cells; h/l past Mon/Sun switch week"),
      k("0-9, Enter", "type hours into the cell (empty = clear); Esc cancels"),
      k("f", "fill empty Mon–Fri cells of the row with the daily target"),
      k("a", "add a project/task row (epic, then tags)"),
      k("d  x", "clear the cell"),
      k("[ ]", "previous / next week"),
      k("v", "switch between grid and day list"),
      line(w, [["  Day list view:", C.gray]]),
      k("↑↓  j k", "move between days and entries"),
      k("J K", "jump to next / previous day"),
      k("←→  h l  [ ]", "previous / next week"),
      k("t", "jump to this week"),
      k("a  (Enter on day)", "add an entry on the selected day (continues after the last entry, fills to the daily target)"),
      k("e  (Enter on entry)", "edit the selected entry"),
      k("c", "copy the selected entry to the next workday (opens the form so you can adjust)"),
      k("d  x", "delete the selected entry (asks first)"),
      k("p", "copy the previous week's entries into this week (skips anything that overlaps)"),
      k("r", "reload from TimeCamp"),
      k("q  Ctrl-C", "quit"),
      "",
      line(w, [["  In the form: ↑↓/Tab to move, Enter on Epic or Tags to pick, Ctrl-S to save, Esc to cancel.", C.gray]]),
      line(w, [["  Mouse: click to select or press, double-click a row to add/edit, wheel to move, drag to select text and copy it.", C.gray]]),
      line(w, [["  Colours: ", C.gray], ["CAPEX", C.cyan], " ", ["OPEX", C.magenta], " ", ["MIXED", C.blue], " ", ["NOTAG", C.red], ["   (from ", C.gray], [tc.CONFIG_FILE, C.gray], [")", C.gray]]),
      line(w, [["  Nothing is ever submitted for approval from here; do that in TimeCamp.", C.gray]]),
    ];
  }
  async onKey() { this.app.pop(); }
  onClickAnywhere() { this.app.pop(); }
}

// ---------- entry point ----------

export { App, WeekScreen }; // for tests

export async function runTui({ week, refresh, mouse } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) tc.die("`timecamp tui` needs an interactive terminal.");
  const app = new App();
  const ws = new WeekScreen(app, week ? tc.parseDate(week) : undefined);
  const first = ws.fetchWeek(ws.from); // in parallel with user/tags
  first.catch(() => {}); // reported when awaited below
  const fresh = Promise.all([tc.me(), tc.loadTags()]).then(([u, t]) => (tc.writeStartupCache(u, t), [u, t]));
  const cached = tc.readStartupCache();
  if (cached) {
    // draw now from last run's user/tags; a bad token shows up as an error on screen
    [app.user, app.tags] = [cached.user, cached.tags];
    fresh.then(([u, t]) => { [app.user, app.tags] = [u, t]; app.render(); }, (e) => app.error(e));
  } else {
    // first run: fail fast (bad token etc.) before taking over the screen
    [app.user, app.tags] = await fresh;
  }

  tc.setRetryHandler((wait, reason = "Rate limited by TimeCamp") => app.flash(`${reason}; retrying in ${Math.round(wait / 1000)}s…`, C.yellow));
  const useMouse = mouse ?? tc.loadConfig().mouse !== false;
  process.stdout.write(`\x1b[?1049h\x1b[?25l${useMouse ? MOUSE_ON : ""}`);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(`${MOUSE_OFF}\x1b[?25h\x1b[?1049l`);
  };
  process.on("exit", restore);
  process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => { restore(); process.exit(0); });

  // Mouse reports are split off before Node's keypress parser, which doesn't understand them.
  const keys = new PassThrough();
  const filter = createMouseFilter((ev) => app.onMouse(ev));
  emitKeypressEvents(keys);
  keys.on("keypress", (str, key) => app.onKey(str, key));
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const rest = filter.feed(chunk);
    if (rest) keys.write(rest);
  });
  process.stdout.on("resize", () => app.render());

  app.push(ws);
  await ws.load({ first });

  // Background loads: recently used epics, and the (large, disk-cached) task list for searching.
  tc.fetchEntries({ from: tc.addDays(today(), -90), to: today() }).then((es) => {
    const seen = new Map();
    for (const e of [...es].reverse()) if (e.task_id && !seen.has(e.task_id)) seen.set(e.task_id, { id: e.task_id, name: e.task });
    app.recent = [...seen.values()].slice(0, 30);
    app.lastEntry = es[es.length - 1];
    app.render();
  }).catch(() => {});
  tc.loadTasks({ refresh }).then((t) => { app.setTasks(t); app.render(); }).catch((e) => { app.tasksError = e.message; });
}
