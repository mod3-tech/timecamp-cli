// Shared TimeCamp logic used by the CLI (bin/timecamp.mjs) and the TUI (lib/tui.mjs).

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const BASE_URL = (process.env.TIMECAMP_BASE_URL || "https://app.timecamp.com/third_party/api").replace(/\/+$/, "");
export const TOKEN_FILE = process.env.TIMECAMP_API_TOKEN_FILE || join(homedir(), ".config", "timecamp", "token");
export const CONFIG_FILE = process.env.TIMECAMP_CONFIG || join(homedir(), ".config", "timecamp", "config.json");
const CACHE_DIR = process.env.TIMECAMP_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "timecamp");
export const TASK_CACHE_FILE = join(CACHE_DIR, "tasks.json");
const TASK_CACHE_TTL_MS = 24 * 3600 * 1000;

// ---------- errors ----------

export class CliError extends Error {}
export function die(msg) { throw new CliError(msg); }

// ---------- dates & durations ----------

export const pad = (n) => String(n).padStart(2, "0");
export const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateObj = (s) => new Date(`${s}T12:00:00`);

export function addDays(s, n) {
  const d = dateObj(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

export function mondayOf(s) {
  const d = dateObj(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return fmtDate(d);
}

export function parseDate(s) {
  if (s === undefined || s === true) return fmtDate(new Date());
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  if (s === "today") return fmtDate(now);
  if (s === "yesterday") { now.setDate(now.getDate() - 1); return fmtDate(now); }
  if (s === "tomorrow") { now.setDate(now.getDate() + 1); return fmtDate(now); }
  if (/^[+-]\d+$/.test(s)) { now.setDate(now.getDate() + Number(s)); return fmtDate(now); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dateObj(s))) return s;
  die(`Invalid date "${s}" (use YYYY-MM-DD, today, yesterday, or ±N)`);
}

export function resolveRange(opts, defaultToToday = true) {
  if (opts.from || opts.to) {
    const from = parseDate(opts.from ?? opts.to);
    const to = parseDate(opts.to ?? opts.from);
    if (from > to) die(`--from ${from} is after --to ${to}`);
    return { from, to };
  }
  if (opts.week) {
    const from = mondayOf(parseDate(opts.week === true ? undefined : opts.week));
    return { from, to: addDays(from, 6) };
  }
  if (opts.month) {
    const d = dateObj(parseDate(opts.month === true ? undefined : opts.month));
    const from = fmtDate(new Date(d.getFullYear(), d.getMonth(), 1, 12));
    const to = fmtDate(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
    return { from, to };
  }
  if (opts.date || defaultToToday) {
    const d = parseDate(opts.date);
    return { from: d, to: d };
  }
  return null;
}

export function parseClock(s, flag = "time") {
  const m = /^(\d{1,2}):?(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) die(`Invalid ${flag} "${s}" (use HH:MM or HH:MM:SS, 24h)`);
  return `${pad(+m[1])}:${m[2]}:${m[3] || "00"}`;
}

export const clockToSec = (c) => { const [h, m, s] = c.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
export const secToClock = (t) => `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;

export function parseDuration(s) {
  const str = String(s).trim().toLowerCase();
  let m;
  if ((m = /^(\d+):(\d{2})$/.exec(str))) return +m[1] * 3600 + +m[2] * 60;
  if ((m = /^(\d+)s$/.exec(str))) return +m[1];
  if ((m = /^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+)m)?$/.exec(str)) && (m[1] || m[2])) {
    return Math.round((parseFloat(m[1] || 0) * 3600) + (+(m[2] || 0) * 60));
  }
  if ((m = /^(\d+(?:\.\d+)?)$/.exec(str))) return Math.round(parseFloat(m[1]) * 3600); // bare number = hours
  die(`Invalid duration "${s}" (use 1h30m, 1.5h, 90m, 1:30, or 5400s)`);
}

export function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h${pad(m)}m`;
}

export const hours = (sec) => Math.round((Number(sec) / 3600) * 100) / 100;

export function toList(obj) {
  if (!obj) return [];
  return Array.isArray(obj) ? obj : Object.values(obj);
}

// ---------- config & CAPEX/OPEX classification ----------

let configCache;
export function loadConfig() {
  if (configCache) return configCache;
  configCache = {};
  if (existsSync(CONFIG_FILE)) {
    try { configCache = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch (e) { die(`Invalid JSON in ${CONFIG_FILE}: ${e.message}`); }
  }
  return configCache;
}

/** Write the config file and update the in-process cache. */
export function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
  configCache = cfg;
  return CONFIG_FILE;
}

/**
 * Tag list names that conventionally belong to each classification. Used by `timecamp setup`
 * to build the config from the account's actual list ids instead of hardcoding them.
 */
const CLASSIFICATION_LISTS = {
  capex: [
    "design & development",
    "testing",
    "project management design & development phase",
    "implementation work not yet in production",
  ],
  opex: [
    "pre approval and pre design & development",
    "implementation & software maintenance",
    "administrative tasks (non-capex)",
  ],
};

const normListName = (s) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Match tag lists to CAPEX/OPEX by name: { capex: [{id,name}], opex: [...], unclassified: [...] }. */
export function deriveClassification(lists) {
  const out = { capex: [], opex: [], unclassified: [] };
  for (const l of lists) {
    if (String(l.archived) === "1") continue;
    const name = normListName(l.name);
    const cls = Object.keys(CLASSIFICATION_LISTS).find((k) => CLASSIFICATION_LISTS[k].includes(name));
    (cls ? out[cls] : out.unclassified).push({ id: Number(l.id), name: l.name });
  }
  return out;
}

/** CAPEX / OPEX for a tag list id, or null if the config doesn't say. */
export function classOfList(listId) {
  const c = loadConfig().classification || {};
  const id = Number(listId);
  if ((c.capex || []).map(Number).includes(id)) return "CAPEX";
  if ((c.opex || []).map(Number).includes(id)) return "OPEX";
  return null;
}

export const hasClassification = () => !!loadConfig().classification;

/** CAPEX, OPEX, MIXED, UNTAGGED, or UNKNOWN (tags present but not in config). */
export function classifyTags(tags) {
  if (!tags?.length) return "UNTAGGED";
  const set = new Set(tags.map((t) => classOfList(t.list_id)));
  set.delete(null);
  if (!set.size) return "UNKNOWN";
  return set.size > 1 ? "MIXED" : [...set][0];
}

export function dayStart() { return parseClock(loadConfig().dayStart || "08:00"); }
export function dayHours() { return Number(loadConfig().dayHours) || 8; }

// ---------- API client ----------

function getToken() {
  if (tokenOverride) return tokenOverride;
  if (process.env.TIMECAMP_API_TOKEN) return process.env.TIMECAMP_API_TOKEN.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  die(`No API token. Run \`timecamp login\`, or set TIMECAMP_API_TOKEN.\n(TimeCamp → avatar → Profile Settings → API token at the bottom)`);
}

let tokenOverride;
/** Use this token for subsequent API calls (e.g. to validate it before saving). */
export function setToken(token) { tokenOverride = token; meCache = undefined; }

export function saveToken(token) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600); // writeFileSync's mode only applies when creating the file
}

export function removeToken() {
  if (!existsSync(TOKEN_FILE)) return false;
  rmSync(TOKEN_FILE);
  return true;
}

/** True if a token is available from the environment, an override, or the token file. */
export function hasToken() {
  return !!(tokenOverride || process.env.TIMECAMP_API_TOKEN || (existsSync(TOKEN_FILE) && readFileSync(TOKEN_FILE, "utf8").trim()));
}

export let onRetry = (wait, reason = "Rate limited") => process.stderr.write(`${reason}; retrying in ${Math.round(wait / 1000)}s...\n`);
export function setRetryHandler(fn) { onRetry = fn; }

export async function api(method, path, { query, body } = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { Accept: "application/json", Authorization: `Bearer ${getToken()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  // Only GETs are retried on 5xx/network errors: a retried write could create the entry twice.
  const safe = method === "GET";
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      const why = e.name === "TimeoutError" ? "timed out after 30s" : `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`;
      if (safe && attempt < 4) {
        const wait = 2000 * 2 ** attempt;
        onRetry(wait, `TimeCamp request ${why}`);
        await pause(wait);
        continue;
      }
      die(`TimeCamp ${method} ${path} ${why}${safe ? "" : "; it may or may not have been applied, check before retrying"}`);
    }
    if ((res.status === 429 || (safe && [502, 503, 504].includes(res.status))) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
      onRetry(wait, res.status === 429 ? "Rate limited" : `TimeCamp returned ${res.status}`);
      await pause(wait);
      continue;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && typeof data === "object" && data.message) || (typeof data === "string" && data) || res.statusText;
      if (res.status === 401) die(`TimeCamp rejected the API token (401). Run \`timecamp login\` to set a new one.`);
      die(`TimeCamp ${method} ${path} failed (${res.status}): ${String(msg).slice(0, 500)}`);
    }
    return data;
  }
}

let meCache;
export async function me() {
  return (meCache ??= await api("GET", "/me"));
}

// ---------- tasks (cached on disk: the full list can be tens of MB) ----------

let tasksCache;

function readTaskCache() {
  try {
    if (!existsSync(TASK_CACHE_FILE)) return null;
    if (Date.now() - statSync(TASK_CACHE_FILE).mtimeMs > TASK_CACHE_TTL_MS) return null;
    const c = JSON.parse(readFileSync(TASK_CACHE_FILE, "utf8"));
    return c.baseUrl === BASE_URL && Array.isArray(c.tasks) ? c.tasks : null;
  } catch { return null; }
}

function writeTaskCache(tasks) {
  try {
    mkdirSync(dirname(TASK_CACHE_FILE), { recursive: true });
    const tmp = `${TASK_CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ baseUrl: BASE_URL, fetchedAt: new Date().toISOString(), tasks }));
    renameSync(tmp, TASK_CACHE_FILE);
  } catch { /* cache is best-effort */ }
}

/** All tasks with full paths. Uses a 24h disk cache unless refresh is true. */
export async function loadTasks({ refresh = false } = {}) {
  if (tasksCache && !refresh) return tasksCache;
  let raw = refresh ? null : readTaskCache();
  if (!raw) {
    raw = toList(await api("GET", "/tasks")).map((t) => ({
      id: Number(t.task_id),
      name: t.name,
      parent_id: Number(t.parent_id) || 0,
      billable: String(t.billable) === "1",
      archived: String(t.archived) === "1",
    }));
    writeTaskCache(raw);
  }
  const byId = new Map(raw.map((t) => [t.id, t]));
  const paths = new Map();
  const pathOf = (t, depth = 0) => {
    if (paths.has(t.id)) return paths.get(t.id);
    const parent = byId.get(t.parent_id);
    const p = parent && parent.id !== t.id && depth < 50 ? `${pathOf(parent, depth + 1)} / ${t.name}` : t.name;
    paths.set(t.id, p);
    return p;
  };
  tasksCache = raw.map((t) => ({ ...t, path: pathOf(t) }));
  return tasksCache;
}

export async function resolveTask(spec) {
  if (spec === undefined || spec === null || spec === "") return undefined;
  if (/^\d+$/.test(String(spec))) return Number(spec);
  const tasks = (await loadTasks()).filter((t) => !t.archived);
  const q = String(spec).toLowerCase().trim();
  const exactName = tasks.filter((t) => t.name.toLowerCase() === q);
  const exactPath = tasks.filter((t) => t.path.toLowerCase() === q);
  const fuzzy = tasks.filter((t) => t.path.toLowerCase().includes(q));
  const pick = exactPath.length === 1 ? exactPath : exactName.length === 1 ? exactName : fuzzy;
  if (pick.length === 1) return pick[0].id;
  if (!pick.length) die(`No task matches "${spec}". Run \`timecamp tasks --search ...\` (add --refresh if it was created in the last day).`);
  const shown = pick.slice(0, 15).map((t) => `  ${t.id}  ${t.path}`).join("\n");
  die(`"${spec}" matches ${pick.length} tasks; pass the id instead:\n${shown}${pick.length > 15 ? "\n  ..." : ""}`);
}

/** Case-insensitive multi-term search over task paths; shallower tasks (epics) first. */
// Sorted once per task list (epics before stories, then by path), so a search can stop at `limit`.
const searchIndex = new WeakMap();
function indexFor(tasks) {
  let idx = searchIndex.get(tasks);
  if (!idx) {
    const cmp = new Intl.Collator().compare;
    idx = tasks.filter((t) => !t.archived)
      .map((t) => ({ t, p: t.path.toLowerCase(), d: t.path.split(" / ").length }))
      .sort((a, b) => a.d - b.d || cmp(a.t.path, b.t.path));
    searchIndex.set(tasks, idx);
  }
  return idx;
}

export function searchTasks(tasks, query, limit = 200) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const { t, p } of indexFor(tasks)) {
    if (out.length >= limit) break;
    if (terms.every((term) => p.includes(term))) out.push(t);
  }
  return out;
}

// ---------- tags ----------

let tagsCache;
export async function loadTags() {
  if (tagsCache) return tagsCache;
  const lists = toList(await api("GET", "/tag_list", { query: { tags: 1 } }));
  const rows = [];
  for (const l of lists) {
    if (String(l.archived) === "1") continue;
    for (const t of toList(l.tags)) {
      if (String(t.archived) === "1") continue;
      rows.push({ id: Number(t.id), tag: t.name, list: l.name, list_id: Number(l.id), class: classOfList(l.id) });
    }
  }
  return (tagsCache = rows);
}

export function parseTagIds(s) {
  if (s === undefined) return undefined;
  if (s === "" || s === true) return [];
  const ids = String(s).split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of ids) if (!/^\d+$/.test(id)) die(`Tag ids must be numeric (got "${id}"). Run \`timecamp tags\`.`);
  return ids.map(Number);
}

// ---------- entries ----------

export function normEntry(e) {
  const tags = (e.tags || []).map((t) => ({ id: Number(t.tagId), name: t.name, list: t.tagListName, list_id: Number(t.tagListId) || null }));
  return {
    id: Number(e.id),
    date: e.date,
    start: (e.start_time || "").slice(0, 5),
    end: (e.end_time || "").slice(0, 5),
    duration: Number(e.duration),
    hours: hours(e.duration),
    task_id: Number(e.task_id) || null,
    task: e.name || "",
    note: e.description || "",
    billable: String(e.billable) === "1" || e.billable === true,
    locked: String(e.locked) === "1",
    tags,
    class: classifyTags(tags),
  };
}

export async function fetchEntries({ from, to }, taskId) {
  const user = await me();
  const data = await api("GET", "/entries", {
    query: { from, to, user_ids: user.user_id, opt_fields: "tags" },
  });
  let entries = toList(data).map(normEntry);
  if (taskId) entries = entries.filter((e) => e.task_id === taskId);
  return entries.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/** Hours by classification for a set of entries: { CAPEX, OPEX, MIXED, UNTAGGED, UNKNOWN } in seconds. */
export function classTotals(entries) {
  const t = { CAPEX: 0, OPEX: 0, MIXED: 0, UNTAGGED: 0, UNKNOWN: 0 };
  for (const e of entries) t[e.class] += e.duration;
  return t;
}

/**
 * Turn a loose entry spec ({date,start,end,duration,task,note,tags,billable}) into an API body.
 * For updates only the provided fields are included.
 */
export async function buildEntryPayload(spec, { forUpdate = false } = {}) {
  const body = {};
  if (spec.date !== undefined || !forUpdate) body.date = parseDate(spec.date);
  const hasStart = spec.start !== undefined;
  const hasEnd = spec.end !== undefined;
  if (spec.duration !== undefined) body.duration = parseDuration(spec.duration);

  if (!forUpdate) {
    if (hasStart !== hasEnd && body.duration === undefined) die("Give both --start and --end, or a --duration.");
    if (!hasStart && !hasEnd && body.duration === undefined) die("Need --start/--end or --duration.");
    const start = hasStart ? parseClock(spec.start, "--start") : undefined;
    let end = hasEnd ? parseClock(spec.end, "--end") : undefined;
    if (start && !end && body.duration !== undefined) {
      const t = clockToSec(start) + body.duration;
      if (t >= 86400) die("Entry would cross midnight; split it into two entries.");
      end = secToClock(t);
    }
    if (start && end) {
      if (end <= start) die(`End ${end.slice(0, 5)} must be after start ${start.slice(0, 5)} (split entries that cross midnight).`);
      body.start = `${body.date} ${start}`;
      body.end = `${body.date} ${end}`;
      body.duration = clockToSec(end) - clockToSec(start);
    }
  } else {
    if (hasStart) body.start_time = parseClock(spec.start, "--start");
    if (hasEnd) body.end_time = parseClock(spec.end, "--end");
    if (body.start_time && body.end_time) {
      if (body.end_time <= body.start_time) die("End must be after start.");
      if (body.duration === undefined) body.duration = clockToSec(body.end_time) - clockToSec(body.start_time);
    }
  }

  if (body.duration !== undefined && body.duration <= 0) die("Duration must be positive.");
  const taskId = await resolveTask(spec.task);
  if (taskId !== undefined) body.task_id = taskId;
  const note = spec.note ?? spec.description;
  if (note !== undefined) body.description = String(note);
  if (spec.billable !== undefined) body.billable = !!spec.billable;
  const tags = parseTagIds(Array.isArray(spec.tags) ? spec.tags.join(",") : spec.tags);
  return { body, tags };
}

export function findDuplicate(existing, body) {
  return existing.find((e) => {
    if (e.date !== body.date) return false;
    if ((body.task_id ?? null) !== (e.task_id ?? null) && body.task_id !== undefined) return false;
    if (body.start) {
      const s = body.start.slice(11, 16);
      const en = body.end.slice(11, 16);
      return s < e.end && en > e.start; // overlapping time range
    }
    return e.duration === body.duration && (body.description ?? "") === e.note;
  });
}

export async function createEntry(body, tags, { dryRun, allowDuplicate, existing } = {}) {
  if (!allowDuplicate) {
    const dup = findDuplicate(existing ?? (await fetchEntries({ from: body.date, to: body.date })), body);
    if (dup) return { skipped: true, duplicateOf: dup, reason: `overlaps/duplicates existing entry ${dup.id} (${dup.date} ${dup.start}-${dup.end} ${dup.task})`, entry: body };
  }
  const payload = { ...body };
  if (tags?.length) payload.tags = tags.map((tagId) => ({ tagId }));
  if (dryRun) return { dryRun: true, request: { method: "POST", path: "/entries", body: payload } };
  const res = await api("POST", "/entries", { body: payload });
  const id = Number(res?.entry_id);
  if (!id) die(`Unexpected response creating entry: ${JSON.stringify(res)}`);
  return { created: true, id, entry: payload };
}

/** Apply an update built by buildEntryPayload(..., {forUpdate:true}). `tags` (if given) replaces the tag set. */
export async function updateEntry(id, body, tags) {
  let result;
  if (Object.keys(body).length) result = await api("PUT", "/entries", { body: { id: Number(id), ...body } });
  if (tags !== undefined) {
    const current = await api("GET", `/entries/${id}/tags`);
    const currentIds = toList(current?.[id] ?? current).map((t) => Number(t.tagId)).filter(Boolean);
    const remove = currentIds.filter((t) => !tags.includes(t));
    const add = tags.filter((t) => !currentIds.includes(t));
    if (remove.length) await api("DELETE", `/entries/${id}/tags`, { body: { tags: remove.join(",") } });
    if (add.length) await api("PUT", `/entries/${id}/tags`, { body: { tags: add.join(",") } });
  }
  return result;
}

export async function deleteEntry(id) {
  const r = await api("DELETE", "/entries", { body: { id: Number(id) } });
  return r?.message ?? r;
}
