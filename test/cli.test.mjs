// Offline tests: run the CLI against a fake TimeCamp API. `npm test`
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/timecamp.mjs", import.meta.url));
const CONFIG = join(mkdtempSync(join(tmpdir(), "tc-config-")), "config.json");
writeFileSync(CONFIG, JSON.stringify({ classification: { capex: [3], opex: [4] } }));

let server, baseUrl, requests, entries, nextId;

function reset() {
  requests = [];
  nextId = 1000;
  entries = [
    { id: 1, duration: "3600", user_id: "7", task_id: "11", date: "2026-10-19", start_time: "09:00:00", end_time: "10:00:00", locked: "0", name: "Backend", billable: 1, description: "standup + review", tags: [] },
  ];
}

const tasks = {
  10: { task_id: "10", parent_id: "0", name: "Acme", archived: "0", billable: "1" },
  11: { task_id: "11", parent_id: "10", name: "Backend", archived: "0", billable: "1" },
  12: { task_id: "12", parent_id: "10", name: "Frontend", archived: "0", billable: "1" },
  13: { task_id: "13", parent_id: "0", name: "Internal", archived: "0", billable: "0" },
  14: { task_id: "14", parent_id: "13", name: "Backend", archived: "0", billable: "0" },
  15: { task_id: "15", parent_id: "0", name: "Old", archived: "1", billable: "0" },
};

before(async () => {
  reset();
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
    const send = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { message: "bad token" });
    const p = url.pathname.replace(/^\/api/, "");
    if (p === "/me") return send(200, { user_id: "7", email: "me@example.com", display_name: "Me", root_group_id: "1" });
    if (p === "/tasks") return send(200, tasks);
    if (p === "/tag_list") return send(200, { 3: { id: "3", name: "Type", archived: "0", tags: { 21: { id: "21", name: "Meeting", archived: "0" } } } });
    if (p === "/entries" && req.method === "GET") {
      const { from, to } = Object.fromEntries(url.searchParams);
      return send(200, entries.filter((e) => e.date >= from && e.date <= to));
    }
    if (p === "/entries" && req.method === "POST") {
      const id = nextId++;
      entries.push({ id, duration: String(body.duration), task_id: String(body.task_id || 0), date: body.date, start_time: body.start?.slice(11) || "00:00:00", end_time: body.end?.slice(11) || "00:00:00", name: tasks[body.task_id]?.name || "", description: body.description || "", billable: 0, locked: "0", tags: [] });
      return send(200, { entry_id: id });
    }
    if (p === "/entries" && req.method === "PUT") return send(200, { entry_id: String(body.id) });
    if (p === "/entries" && req.method === "DELETE") { entries = entries.filter((e) => e.id !== body.id); return send(200, { message: "removed" }); }
    const tagM = /^\/entries\/(\d+)\/tags$/.exec(p);
    if (tagM) {
      const e = entries.find((x) => x.id === Number(tagM[1]));
      if (req.method === "GET") return send(200, { [tagM[1]]: e.tags });
      const ids = String(body.tags).split(",");
      if (req.method === "PUT") for (const id of ids) e.tags.push({ tagId: id, tagListId: "3", name: `t${id}` });
      if (req.method === "DELETE") e.tags = e.tags.filter((t) => !ids.includes(String(t.tagId)));
      return send(200, ids);
    }
    if (p === "/timer_running") return send(200, []);
    send(404, { message: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function cli(args, { input, token = "test-token" } = {}) {
  const env = {
    ...process.env, TIMECAMP_BASE_URL: baseUrl, TIMECAMP_API_TOKEN: token, TIMECAMP_API_TOKEN_FILE: "/nonexistent",
    TIMECAMP_CACHE_DIR: mkdtempSync(join(tmpdir(), "tc-cache-")), TIMECAMP_CONFIG: CONFIG,
  };
  try {
    const p = run(process.execPath, [CLI, ...args], { env });
    if (input !== undefined) { p.child.stdin.end(input); }
    const { stdout, stderr } = await p;
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("lists tasks with parent paths, hiding archived", async () => {
  const r = await cli(["tasks", "--json"]);
  const list = JSON.parse(r.stdout);
  assert.ok(list.find((t) => t.id === 11 && t.path === "Acme / Backend"));
  assert.ok(!list.find((t) => t.id === 15));
});

test("add with start/end resolves task path and sends correct payload", async () => {
  reset();
  const r = await cli(["add", "--date", "2026-10-20", "--start", "9:00", "--end", "12:30", "--task", "acme / backend", "--note", "API work", "--tags", "21", "--billable"]);
  assert.equal(r.code, 0, r.stderr);
  const post = requests.find((q) => q.method === "POST");
  assert.deepEqual(post.body, { date: "2026-10-20", start: "2026-10-20 09:00:00", end: "2026-10-20 12:30:00", duration: 12600, task_id: 11, description: "API work", billable: true, tags: [{ tagId: 21 }] });
});

test("ambiguous task name fails with candidates", async () => {
  const r = await cli(["add", "--date", "2026-10-20", "--duration", "1h", "--task", "Backend", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /matches 2 tasks/);
  assert.match(r.stderr, /14\s+Internal \/ Backend/);
});

test("duration-only add and duration formats", async () => {
  reset();
  for (const [d, s] of [["1h30m", 5400], ["1.5h", 5400], ["90m", 5400], ["1:30", 5400], ["45m", 2700]]) {
    const r = await cli(["add", "--date", "2026-10-21", "--duration", d, "--task", "12", "--note", d, "--dry-run", "--json"]);
    assert.equal(JSON.parse(r.stdout).request.body.duration, s, d);
  }
});

test("overlapping entry is skipped unless --allow-duplicate", async () => {
  reset();
  const r = await cli(["add", "--date", "2026-10-19", "--start", "09:30", "--end", "10:30", "--task", "11"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /existing entry 1/);
  const r2 = await cli(["add", "--date", "2026-10-19", "--start", "09:30", "--end", "10:30", "--task", "11", "--allow-duplicate"]);
  assert.equal(r2.code, 0, r2.stderr);
});

test("bulk validates first, creates, and is idempotent on re-run", async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "tc-"));
  const file = join(dir, "week.json");
  writeFileSync(file, JSON.stringify([
    { date: "2026-10-20", start: "09:00", end: "12:00", task: 11, note: "a" },
    { date: "2026-10-20", start: "13:00", duration: "2h", task: "Frontend", note: "b" },
    { date: "2026-10-21", duration: "7.5h", task: 13, note: "c" },
  ]));
  let r = await cli(["bulk", file]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /3 created, 0 skipped/);
  const second = requests.filter((q) => q.method === "POST")[1].body;
  assert.equal(second.end, "2026-10-20 15:00:00");
  r = await cli(["bulk", file]);
  assert.match(r.stdout, /0 created, 3 skipped/);

  const bad = await cli(["bulk", "-"], { input: JSON.stringify([{ date: "2026-10-22", duration: "1h" }, { date: "2026-10-22" }]) });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Entry #2/);
});

test("summary totals and week range (Mon-Sun)", async () => {
  reset();
  const r = await cli(["summary", "--week", "2026-10-21", "--json"]);
  const s = JSON.parse(r.stdout);
  assert.equal(s.from, "2026-10-19");
  assert.equal(s.to, "2026-10-25");
  assert.equal(s.days.length, 7);
  assert.equal(s.total_hours, 1);
});

test("delete requires --yes", async () => {
  reset();
  let r = await cli(["delete", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--yes/);
  r = await cli(["delete", "1", "--yes"]);
  assert.equal(r.code, 0);
  assert.equal(entries.length, 0);
});

test("bad token gives a clear error", async () => {
  const r = await cli(["me"], { token: "nope" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rejected the API token/);
});

test("entries and summary classify CAPEX / OPEX / MIXED from config", async () => {
  reset();
  entries[0].tags = [{ tagId: "21", tagListId: "3", name: "Dev" }];
  entries.push({ ...entries[0], id: 2, date: "2026-10-20", tags: [{ tagId: "22", tagListId: "4", name: "Fix" }] });
  entries.push({ ...entries[0], id: 3, date: "2026-10-21", tags: [{ tagId: "21", tagListId: "3" }, { tagId: "22", tagListId: "4" }] });
  entries.push({ ...entries[0], id: 4, date: "2026-10-22", tags: [] });
  const list = JSON.parse((await cli(["entries", "--week", "2026-10-19", "--json"])).stdout);
  assert.deepEqual(list.map((e) => e.class), ["CAPEX", "OPEX", "MIXED", "UNTAGGED"]);
  const s = JSON.parse((await cli(["summary", "--week", "2026-10-19", "--json"])).stdout);
  assert.deepEqual(s.classes_hours, { CAPEX: 1, OPEX: 1, MIXED: 1, UNTAGGED: 1 });
});

test("update replaces the tag set by diffing, and recomputes duration from start/end", async () => {
  reset();
  entries[0].tags = [{ tagId: "21", tagListId: "3" }, { tagId: "22", tagListId: "3" }];
  const r = await cli(["update", "1", "--start", "09:00", "--end", "11:30", "--tags", "22,23"]);
  assert.equal(r.code, 0, r.stderr);
  const put = requests.find((q) => q.method === "PUT" && q.path.endsWith("/entries"));
  assert.deepEqual(put.body, { id: 1, start_time: "09:00:00", end_time: "11:30:00", duration: 9000 });
  assert.deepEqual(requests.filter((q) => q.path.endsWith("/tags") && q.method !== "GET").map((q) => [q.method, q.body.tags]), [["DELETE", "21"], ["PUT", "23"]]);
});

test("task list is cached on disk between runs", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "tc-cache-"));
  const env = { ...process.env, TIMECAMP_BASE_URL: baseUrl, TIMECAMP_API_TOKEN: "test-token", TIMECAMP_CACHE_DIR: cacheDir, TIMECAMP_CONFIG: CONFIG };
  reset();
  await run(process.execPath, [CLI, "tasks"], { env });
  await run(process.execPath, [CLI, "tasks"], { env });
  assert.equal(requests.filter((q) => q.path.endsWith("/tasks")).length, 1);
  await run(process.execPath, [CLI, "tasks", "--refresh"], { env });
  assert.equal(requests.filter((q) => q.path.endsWith("/tasks")).length, 2);
});

test("login verifies a piped token, saves it 0600, and logout removes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tc-login-"));
  const tokenFile = join(dir, "sub", "token");
  const { TIMECAMP_API_TOKEN: _drop, ...base } = process.env;
  const env = { ...base, TIMECAMP_BASE_URL: baseUrl, TIMECAMP_API_TOKEN_FILE: tokenFile, TIMECAMP_CONFIG: CONFIG };
  const login = (input) => {
    const p = run(process.execPath, [CLI, "login"], { env });
    p.child.stdin.end(input);
    return p.then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  };

  let r = await login("wrong-token\n");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rejected the API token/);
  assert.ok(!existsSync(tokenFile), "bad token must not be saved");

  r = await login("  test-token\n");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Logged in as Me <me@example.com>/);
  assert.equal(readFileSync(tokenFile, "utf8"), "test-token\n");
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);

  // the saved token is used by later commands
  const me = await run(process.execPath, [CLI, "me"], { env });
  assert.match(me.stdout, /user_id=7/);

  const args = await run(process.execPath, [CLI, "login", "test-token"], { env }).catch((e) => e);
  assert.equal(args.code, 1);
  assert.match(args.stderr, /shell history/);

  const out = await run(process.execPath, [CLI, "logout"], { env });
  assert.match(out.stdout, /Removed/);
  assert.ok(!existsSync(tokenFile));
});
