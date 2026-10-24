#!/usr/bin/env node
// TimeCamp CLI — manage your own time entries on app.timecamp.com from the shell.
// Zero dependencies; requires Node 18+ (global fetch). Run `timecamp help` for usage.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolveTargets, installSkills, bundledSkills, SKILLS_SOURCE } from "../lib/skills.mjs";
import {
  CliError, die, TOKEN_FILE, CONFIG_FILE, dateObj, fmtDate, resolveRange, fmtDuration, hours, toList,
  api, me, setToken, saveToken, removeToken, hasToken, loadTasks, resolveTask, loadTags, fetchEntries, buildEntryPayload, createEntry, updateEntry,
  deleteEntry, classTotals, hasClassification, loadConfig, saveConfig, deriveClassification, dayStart, dayHours, clockToSec, secToClock,
  TASK_CACHE_FILE,
} from "../lib/core.mjs";

// ---------- output ----------

const C_OK = "32";
const C_WARN = "33";
const C_DIM = "90";

const HELP = `timecamp — TimeCamp time-entry CLI

Auth:
  setup [--force]                      First-run setup: log in if needed, derive the CAPEX/OPEX
                                       config from your tag lists, check everything works
  login                                Paste your API token (hidden), verify it, save it to
                                       ${TOKEN_FILE}. Or pipe it: timecamp login < file
  logout                               Delete the saved token
  (TIMECAMP_API_TOKEN, if set, overrides the saved token)

Interactive:
  tui [--week D] [--no-mouse]          Full-screen week editor (press ? inside for keys)

Skills:
  skills install [--claude|--opencode|--pi] [--global] [--force] [--link] [--dry-run]
                                       Install the bundled agent skill into .claude/skills or
                                       .opencode/skills (--global: ~/.claude/skills or
                                       ~/.config/opencode/skills)

Read:
  me                                   Show the authenticated user
  tasks [--search TEXT] [--archived]   List tasks/projects you can track to (id + path)
  tags [--search TEXT]                 List tag lists and tags (ids, CAPEX/OPEX class)
  entries [RANGE] [--task T]           List your time entries (default: today)
  summary [RANGE]                      Hours per day, per task, and CAPEX/OPEX
  timer status                         Show the running timer

Write (all support --dry-run):
  add --date D (--start HH:MM --end HH:MM | --duration DUR)
      [--task T] [--note TEXT] [--tags ID,ID] [--billable | --no-billable]
      [--allow-duplicate]
  update ID [--date D] [--start HH:MM] [--end HH:MM] [--duration DUR]
      [--task T] [--note TEXT] [--tags ID,ID] [--billable | --no-billable]
  delete ID [ID...] --yes
  bulk FILE|-  [--allow-duplicate]      Create many entries from a JSON array
  timer start [--task T] | timer stop

RANGE:  --date D | --from D --to D | --week [D] | --month [D]
        D = YYYY-MM-DD, today, yesterday, or ±N (days from today, e.g. -3)
DUR:    1h30m, 1.5h, 90m, 1:30, or 5400s
T:      task id, or a task name / path fragment (must match exactly one task)

Global: --json      machine-readable output
        --dry-run   print the request that would be sent, change nothing
        --refresh   re-download the task list (it is cached for 24h)

Config: ${CONFIG_FILE} (CAPEX/OPEX tag lists, day start/length)
`;

// ---------- arg parsing ----------

const BOOL_FLAGS = new Set(["json", "dry-run", "yes", "archived", "billable", "no-billable", "allow-duplicate", "week", "month", "help", "refresh", "no-mouse", "force", "claude", "opencode", "pi", "global", "link"]);

function looksLikeDate(s) {
  return /^(\d{4}-\d{2}-\d{2}|today|yesterday|tomorrow|[+-]\d+)$/.test(s);
}

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { opts.help = true; continue; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL_FLAGS.has(k) && v === undefined) {
      // --week / --month optionally take a date argument
      if ((k === "week" || k === "month") && argv[i + 1] && !argv[i + 1].startsWith("--") && looksLikeDate(argv[i + 1])) {
        opts[k] = argv[++i];
      } else {
        opts[k] = true;
      }
      continue;
    }
    if (v === undefined) {
      if (i + 1 >= argv.length) die(`Missing value for --${k}`);
      v = argv[++i];
    }
    opts[k] = v;
  }
  return { pos, opts };
}

// ---------- output ----------

function table(rows, cols) {
  if (!rows.length) return "(none)";
  const widths = cols.map((c) => rows.reduce((w, r) => Math.max(w, String(r[c] ?? "").length), c.length));
  const line = (r) => cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))), ...rows.map(line)].join("\n");
}

function print(x) { console.log(JSON.stringify(x, null, 2)); }

function specFromOpts(opts) {
  const spec = { date: opts.date, start: opts.start, end: opts.end, duration: opts.duration, task: opts.task, note: opts.note ?? opts.description, tags: opts.tags };
  if (opts.billable) spec.billable = true;
  if (opts["no-billable"]) spec.billable = false;
  return spec;
}

/** Shorten a path for display: ~/… inside the home directory, relative to cwd otherwise. */
function displayPath(p) {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  const cwd = process.cwd();
  if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return p;
}

const shortClass = (c) => ({ CAPEX: "CAPEX", OPEX: "OPEX", MIXED: "MIXED", UNTAGGED: "no-tag", UNKNOWN: "?" })[c] ?? "";

async function readHidden(prompt) {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      err ? reject(err) : resolve(buf);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\x03") return done(new CliError("Cancelled."));
        if (ch === "\x7f" || ch === "\b") { if (buf) { buf = buf.slice(0, -1); process.stderr.write("\b \b"); } continue; }
        if (ch === "\x15") { process.stderr.write("\b \b".repeat(buf.length)); buf = ""; continue; }
        if (ch < " ") continue; // ignore other control chars / escape sequences
        buf += ch;
        process.stderr.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

// ---------- commands ----------

const commands = {
  async skills(pos, opts) {
    const sub = pos[0] || "install";
    if (sub !== "install") die("Usage: timecamp skills install [--claude|--opencode|--pi] [--global] [--force] [--link] [--dry-run]");
    if (!bundledSkills().length) die(`No bundled skills found in ${SKILLS_SOURCE}.`);

    const targets = resolveTargets({ cwd: process.cwd(), home: homedir(), claude: opts.claude, opencode: opts.opencode, pi: opts.pi, global: opts.global });
    if (opts.claude && opts.opencode && !targets.length) die("Nothing to install into.");
    const results = installSkills({ targets, force: opts.force, link: opts.link, dryRun: opts["dry-run"] });
    const conflicts = results.filter((r) => r.status === "conflict");

    if (opts.json) {
      print({ targets: targets.map((t) => ({ agent: t.agent, dir: t.dir })), results });
      if (conflicts.length) process.exitCode = 1;
      return;
    }

    for (const r of results) {
      const where = displayPath(r.dir);
      if (r.status === "installed") console.log(`✓ installed ${r.skill} → ${where}${opts.link ? " (symlink)" : ""}`);
      else if (r.status === "up-to-date") console.log(`· ${r.skill} already up to date in ${where}`);
      else if (r.status === "would-install") console.log(`would install ${r.skill} → ${where}`);
      else console.log(`✗ ${where} exists and differs from the bundled skill`);
    }
    for (const note of new Set(targets.map((t) => t.note).filter(Boolean))) console.log(`\n${note}`);
    if (conflicts.length) {
      console.error("\nRe-run with --force to replace it (your version will be overwritten).");
      process.exitCode = 1;
      return;
    }
    if (!opts["dry-run"] && results.some((r) => r.status === "installed")) console.log("\nStart a new agent session to pick up the skill.");
  },

  async setup(_pos, opts) {
    const log = (mark, msg, style = "") => { if (!opts.json) console.log(`${mark} ${style ? `\x1b[${style}m${msg}\x1b[0m` : msg}`); };
    const result = { user: null, configFile: CONFIG_FILE, classification: null, unclassified: [], wroteConfig: false };

    if (!opts.json) console.log("TimeCamp setup\n");

    // 1. Authentication
    if (!hasToken()) {
      if (!process.stdin.isTTY) die("No API token. Run `timecamp login` first, or set TIMECAMP_API_TOKEN.");
      process.stderr.write("No API token found.\n");
      await commands.login([], opts);
    }
    try {
      result.user = await me();
    } catch (e) {
      if (process.env.TIMECAMP_API_TOKEN) die("TIMECAMP_API_TOKEN is set but rejected by TimeCamp. Fix or unset it, then re-run `timecamp setup`.");
      if (!process.stdin.isTTY) throw e;
      process.stderr.write("The saved token was rejected; logging in again.\n");
      removeToken();
      await commands.login([], opts);
      result.user = await me();
    }
    log("✓", `Logged in as ${result.user.display_name} <${result.user.email}>`, C_OK);

    // 2. CAPEX/OPEX classification from the account's tag lists
    const lists = toList(await api("GET", "/tag_list"));
    const derived = deriveClassification(lists);
    result.unclassified = derived.unclassified;
    const cfg = { ...loadConfig() };
    if (cfg.classification && !opts.force) {
      result.classification = cfg.classification;
      log("·", `Kept the existing classification in ${CONFIG_FILE} (use --force to rebuild it).`, C_DIM);
    } else if (derived.capex.length || derived.opex.length) {
      result.classification = { capex: derived.capex.map((l) => l.id), opex: derived.opex.map((l) => l.id) };
      cfg.classification = result.classification;
      saveConfig(cfg);
      result.wroteConfig = true;
      log("✓", `Wrote ${CONFIG_FILE}`, C_OK);
    } else {
      log("!", "No known CAPEX/OPEX tag lists found; classification left unset. Add them to the config by hand.", C_WARN);
    }
    if (result.classification) {
      log(" ", `CAPEX lists: ${derived.capex.map((l) => l.name).join(", ") || "(none matched)"}`, C_DIM);
      log(" ", `OPEX lists:  ${derived.opex.map((l) => l.name).join(", ") || "(none matched)"}`, C_DIM);
    }
    if (derived.unclassified.length) {
      log("!", `Not classified: ${derived.unclassified.map((l) => `${l.name} (${l.id})`).join(", ")}`, C_WARN);
      log(" ", `Add them to "classification" in ${CONFIG_FILE} if they should count.`, C_DIM);
    }

    // 3. Day defaults / current settings
    if (!opts.json) {
      log(" ", `Working day: ${dayStart().slice(0, 5)}–${secToClock(clockToSec(dayStart()) + dayHours() * 3600).slice(0, 5)} (${dayHours()}h)`, C_DIM);
      log(" ", `Task cache: ${TASK_CACHE_FILE} (built on first use, valid 24h)`, C_DIM);
    }

    if (opts.json) return print(result);
    console.log("\nNext:");
    console.log("  install the agent skill:  timecamp skills install --global");
    console.log("  try it:                   timecamp tui");
    console.log("  checks:                   timecamp me && timecamp summary --week");
  },

  async login(pos, opts) {
    if (pos.length) die("Don't pass the token as an argument (it would end up in your shell history). Run `timecamp login` and paste it, or pipe it in: `timecamp login < file`.");
    let token;
    if (process.stdin.isTTY) {
      process.stderr.write("Get your token from TimeCamp: avatar (top right) → Profile Settings → \"API token\" at the bottom.\n");
      token = await readHidden("API token: ");
    } else {
      token = readFileSync(0, "utf8");
    }
    token = token.trim();
    if (!token) die("No token given.");
    if (/\s/.test(token)) die("That doesn't look like a token (it contains whitespace).");

    setToken(token);
    const user = await me(); // throws a clear error on 401, nothing is saved
    saveToken(token);
    if (opts.json) return print({ saved: TOKEN_FILE, user });
    console.log(`Logged in as ${user.display_name} <${user.email}>. Token saved to ${TOKEN_FILE} (mode 600).`);
    if (process.env.TIMECAMP_API_TOKEN && process.env.TIMECAMP_API_TOKEN.trim() !== token) {
      console.error("note: TIMECAMP_API_TOKEN is set in your environment and takes precedence over the saved token. Unset it to use this one.");
    }
  },

  async logout(_pos, opts) {
    const removed = removeToken();
    if (opts.json) return print({ removed, file: TOKEN_FILE });
    console.log(removed ? `Removed ${TOKEN_FILE}.` : `No saved token at ${TOKEN_FILE}.`);
    if (process.env.TIMECAMP_API_TOKEN) console.error("note: TIMECAMP_API_TOKEN is still set in your environment.");
  },

  async me(_pos, opts) {
    const u = await me();
    if (opts.json) return print(u);
    console.log(`${u.display_name} <${u.email}>  user_id=${u.user_id}  root_group_id=${u.root_group_id}`);
  },

  async tasks(_pos, opts) {
    let tasks = await loadTasks({ refresh: opts.refresh });
    if (!opts.archived) tasks = tasks.filter((t) => !t.archived);
    if (opts.search) {
      const q = String(opts.search).toLowerCase();
      tasks = tasks.filter((t) => t.path.toLowerCase().includes(q));
    }
    tasks = [...tasks].sort((a, b) => a.path.localeCompare(b.path));
    if (opts.json) return print(tasks);
    console.log(table(tasks.map((t) => ({ id: t.id, path: t.path, billable: t.billable ? "yes" : "", archived: t.archived ? "yes" : "" })), ["id", "path", "billable", "archived"]));
  },

  async tags(_pos, opts) {
    let rows = await loadTags();
    if (opts.search) {
      const q = String(opts.search).toLowerCase();
      rows = rows.filter((r) => r.tag.toLowerCase().includes(q) || r.list.toLowerCase().includes(q));
    }
    if (opts.json) return print(rows);
    const cols = hasClassification() ? ["id", "class", "tag", "list", "list_id"] : ["id", "tag", "list", "list_id"];
    console.log(table(rows.map((r) => ({ ...r, class: r.class ?? "?" })), cols));
  },

  async entries(_pos, opts) {
    const range = resolveRange(opts);
    const entries = await fetchEntries(range, await resolveTask(opts.task));
    if (opts.json) return print(entries);
    const withClass = hasClassification();
    console.log(`${range.from}${range.to !== range.from ? ` → ${range.to}` : ""}`);
    console.log(table(entries.map((e) => {
      const tags = e.tags.map((t) => t.name).join(",");
      return {
        id: e.id, date: e.date, start: e.start, end: e.end, time: fmtDuration(e.duration), class: shortClass(e.class),
        task: e.task || "(no task)", note: e.note.slice(0, 40), tags: tags.length > 50 ? `${tags.slice(0, 49)}…` : tags,
        flags: [e.billable ? "$" : "", e.locked ? "locked" : ""].filter(Boolean).join(" "),
      };
    }), ["id", "date", "start", "end", "time", ...(withClass ? ["class"] : []), "task", "note", "tags", "flags"]));
    console.log(`Total: ${fmtDuration(entries.reduce((s, e) => s + e.duration, 0))} in ${entries.length} entries`);
  },

  async summary(_pos, opts) {
    const range = resolveRange(opts);
    const entries = await fetchEntries(range);
    const byDay = {};
    const byTask = {};
    for (const e of entries) {
      byDay[e.date] = (byDay[e.date] || 0) + e.duration;
      const k = e.task || "(no task)";
      byTask[k] = (byTask[k] || 0) + e.duration;
    }
    // include empty days so gaps are visible
    const days = [];
    for (let d = dateObj(range.from); fmtDate(d) <= range.to; d.setDate(d.getDate() + 1)) {
      const ds = fmtDate(d);
      days.push({ date: ds, weekday: d.toLocaleDateString("en-US", { weekday: "short" }), seconds: byDay[ds] || 0, hours: hours(byDay[ds] || 0) });
    }
    const tasks = Object.entries(byTask).map(([task, s]) => ({ task, seconds: s, hours: hours(s) })).sort((a, b) => b.seconds - a.seconds);
    const total = entries.reduce((s, e) => s + e.duration, 0);
    const classes = Object.fromEntries(Object.entries(classTotals(entries)).filter(([, s]) => s).map(([k, s]) => [k, hours(s)]));
    if (opts.json) return print({ ...range, total_seconds: total, total_hours: hours(total), classes_hours: classes, days, tasks });
    console.log(`${range.from} → ${range.to}   total ${fmtDuration(total)} (${hours(total)}h)`);
    if (hasClassification() && total) console.log(Object.entries(classes).map(([k, h]) => `${k} ${h}h`).join("   "));
    console.log("");
    console.log(table(days.map((d) => ({ date: d.date, day: d.weekday, time: d.seconds ? fmtDuration(d.seconds) : "-", hours: d.hours || "" })), ["date", "day", "time", "hours"]));
    console.log("");
    console.log(table(tasks.map((t) => ({ task: t.task, time: fmtDuration(t.seconds), hours: t.hours })), ["task", "time", "hours"]));
  },

  async add(_pos, opts) {
    const { body, tags } = await buildEntryPayload(specFromOpts(opts));
    const r = await createEntry(body, tags, { dryRun: opts["dry-run"], allowDuplicate: opts["allow-duplicate"] });
    if (opts.json) return print(r);
    if (r.skipped) { console.error(`Not created: ${r.reason}. Use --allow-duplicate to force.`); process.exitCode = 3; return; }
    if (r.dryRun) return print(r.request);
    console.log(`Created entry ${r.id}: ${body.date} ${body.start ? `${body.start.slice(11, 16)}-${body.end.slice(11, 16)}` : ""} ${fmtDuration(body.duration)}${body.task_id ? ` task=${body.task_id}` : ""}`);
  },

  async update(pos, opts) {
    const id = pos[0];
    if (!/^\d+$/.test(id || "")) die("Usage: timecamp update ENTRY_ID [--date ...] [--start ...] ...");
    const { body, tags } = await buildEntryPayload(specFromOpts(opts), { forUpdate: true });
    if (!Object.keys(body).length && tags === undefined) die("Nothing to update — pass at least one field.");
    if (opts["dry-run"]) {
      const reqs = [];
      if (Object.keys(body).length) reqs.push({ method: "PUT", path: "/entries", body: { id: Number(id), ...body } });
      if (tags !== undefined) reqs.push({ method: "PUT", path: `/entries/${id}/tags`, body: { tags: tags.join(",") }, replacesExistingTags: true });
      return print(reqs);
    }
    const result = await updateEntry(id, body, tags);
    if (opts.json) return print({ updated: true, id: Number(id), result });
    console.log(`Updated entry ${id}`);
  },

  async delete(pos, opts) {
    if (!pos.length || !pos.every((x) => /^\d+$/.test(x))) die("Usage: timecamp delete ENTRY_ID [ENTRY_ID...] --yes");
    if (opts["dry-run"]) return print(pos.map((id) => ({ method: "DELETE", path: "/entries", body: { id: Number(id) } })));
    if (!opts.yes) die("Refusing to delete without --yes. Deletion is permanent.");
    const out = [];
    for (const id of pos) out.push({ id: Number(id), result: await deleteEntry(id) });
    if (opts.json) return print(out);
    for (const o of out) console.log(`Deleted ${o.id}: ${o.result}`);
  },

  async bulk(pos, opts) {
    const src = pos[0];
    if (!src) die("Usage: timecamp bulk FILE.json   (or `-` for stdin)");
    const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    let items;
    try { items = JSON.parse(text); } catch (e) { die(`Invalid JSON: ${e.message}`); }
    if (!Array.isArray(items)) items = items.entries;
    if (!Array.isArray(items)) die("Expected a JSON array of entries (or {\"entries\": [...]}).");

    // Validate everything before writing anything.
    const built = [];
    for (const [i, item] of items.entries()) {
      try { built.push(await buildEntryPayload(item)); } catch (e) { die(`Entry #${i + 1}: ${e.message}`); }
    }
    const dates = built.map((b) => b.body.date).sort();
    const existing = opts["allow-duplicate"] ? [] : await fetchEntries({ from: dates[0], to: dates[dates.length - 1] });

    const results = [];
    let failure;
    for (const [i, { body, tags }] of built.entries()) {
      let r;
      try {
        r = await createEntry(body, tags, { dryRun: opts["dry-run"], allowDuplicate: opts["allow-duplicate"], existing });
      } catch (e) {
        // stop, but still report what was already written
        failure = `Entry #${i + 1} failed, ${built.length - i - 1} not attempted: ${e.message}`;
        break;
      }
      if (!opts["allow-duplicate"] && !r.skipped) {
        // so later items in the same batch are checked against earlier ones
        existing.push({ date: body.date, start: body.start?.slice(11, 16) ?? "", end: body.end?.slice(11, 16) ?? "", duration: body.duration, task_id: body.task_id ?? null, note: body.description ?? "", id: r.id ?? "(pending)", task: "" });
      }
      results.push(r);
    }
    if (failure) process.exitCode = 1;
    const report = () => failure && console.error(`error: ${failure}${opts["allow-duplicate"] ? "" : "\nRe-running is safe: entries already created are skipped as duplicates."}`);
    if (opts.json) { print(results); return report(); }
    for (const r of results) {
      if (r.skipped) console.log(`SKIP     ${r.entry.date} ${fmtDuration(r.entry.duration)} — ${r.reason}`);
      else if (r.dryRun) console.log(`DRY-RUN  ${JSON.stringify(r.request.body)}`);
      else console.log(`CREATED  ${r.id}  ${r.entry.date} ${fmtDuration(r.entry.duration)}`);
    }
    const n = (k) => results.filter((r) => r[k]).length;
    console.log(`\n${n("created")} created, ${n("skipped")} skipped${opts["dry-run"] ? `, ${n("dryRun")} would be created` : ""}`);
    report();
  },

  async timer(pos, opts) {
    const action = pos[0] || "status";
    if (action === "status") {
      const running = toList(await api("GET", "/timer_running"));
      if (opts.json) return print(running);
      if (!running.length) return console.log("No timer running.");
      for (const t of running) console.log(`Running since ${t.started_at}${t.name ? ` on "${t.name}"` : ""}${t.task_id ? ` (task ${t.task_id})` : ""}`);
      return;
    }
    if (action !== "start" && action !== "stop") die("Usage: timecamp timer status|start [--task T]|stop");
    const body = { action };
    if (action === "start") {
      const t = await resolveTask(opts.task);
      if (t) body.task_id = t;
    }
    if (opts["dry-run"]) return print({ method: "POST", path: "/timer", body });
    const r = await api("POST", "/timer", { body });
    if (opts.json) return print(r);
    console.log(action === "start" ? "Timer started." : `Timer stopped${r?.elapsed ? ` (${fmtDuration(r.elapsed)})` : ""}.`);
  },

  async tui(_pos, opts) {
    const { runTui } = await import("../lib/tui.mjs");
    await runTui({ week: opts.week === true ? undefined : opts.week, refresh: opts.refresh, mouse: opts["no-mouse"] ? false : undefined });
  },

  help() { process.stdout.write(HELP); },
};

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  if (!cmd || opts.help || cmd === "help") return commands.help();
  const fn = commands[cmd] || (cmd === "rm" ? commands.delete : cmd === "ls" ? commands.entries : undefined);
  if (!fn) die(`Unknown command "${cmd}". Run \`timecamp help\`.`);
  await fn(pos, opts);
}

main().catch((e) => {
  if (e instanceof CliError) {
    console.error(`error: ${e.message}`);
    process.exit(e.message.startsWith("Usage") ? 2 : 1);
  }
  console.error(e?.cause ? `error: ${e.message} (${e.cause.code || e.cause.message})` : e);
  process.exit(1);
});
