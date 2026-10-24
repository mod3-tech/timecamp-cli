import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// core.mjs fixes its paths at import time, so point them at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), "tc-startup-"));
process.env.TIMECAMP_CACHE_DIR = dir;
process.env.TIMECAMP_CONFIG = join(dir, "config.json");
process.env.TIMECAMP_API_TOKEN = "token-a";
const tc = await import("../lib/core.mjs");

test("startup cache is only used for the token that wrote it", () => {
  assert.equal(tc.readStartupCache(), null); // nothing cached yet
  tc.writeStartupCache({ user_id: "1" }, [{ id: "7", tag: "x", list_id: "3" }]);
  assert.equal(tc.readStartupCache().user.user_id, "1");
  process.env.TIMECAMP_API_TOKEN = "token-b"; // e.g. after `timecamp login` as someone else
  assert.equal(tc.readStartupCache(), null);
  process.env.TIMECAMP_API_TOKEN = "token-a";
  assert.equal(tc.readStartupCache().tags[0].id, "7");
});
