// Installs the bundled agent skills into a project's (or the user's) agent config directory.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

const AGENTS = {
  claude: { local: ".claude/skills", global: ".claude/skills", root: { local: ".claude", global: ".claude" } },
  opencode: { local: ".opencode/skills", global: ".config/opencode/skills", root: { local: ".opencode", global: ".config/opencode" } },
  // pi doesn't read .claude/skills, so it's only ever installed via --pi
  pi: { local: ".pi/skills", global: ".pi/agent/skills", root: { local: ".pi", global: ".pi/agent" } },
};

/** Every bundled skill: [{ name, dir }] for folders under skills/ that contain a SKILL.md. */
export function bundledSkills() {
  if (!existsSync(SKILLS_SOURCE)) return [];
  return readdirSync(SKILLS_SOURCE)
    .map((name) => ({ name, dir: join(SKILLS_SOURCE, name) }))
    .filter((s) => existsSync(join(s.dir, "SKILL.md")));
}

/**
 * Where to install. With no agent flags: `.claude/skills` when there's a `.claude` dir (both Claude Code
 * and OpenCode read it), otherwise `.opencode/skills` when that's the only one, and `.claude/skills`
 * when neither exists. Installing into both would duplicate the skill name across locations, which
 * agents warn about, so doing that takes explicit --claude --opencode.
 */
export function resolveTargets({ cwd = process.cwd(), home, claude = false, opencode = false, pi = false, global = false } = {}) {
  const wanted = [claude && "claude", opencode && "opencode", pi && "pi"].filter(Boolean);
  const base = global ? home : cwd;
  const exists = (agent) => existsSync(join(base, AGENTS[agent].root[global ? "global" : "local"]));
  const target = (agent, note) => ({ agent, dir: resolve(base, AGENTS[agent][global ? "global" : "local"]), ...(note ? { note } : {}) });

  if (wanted.length) return wanted.map((a) => target(a));

  const hasClaude = exists("claude");
  const hasOpencode = exists("opencode");
  if (!hasClaude && !hasOpencode) {
    return [target("claude", `No .claude or .opencode directory ${global ? "in your home" : "here"}, so using ${AGENTS.claude[global ? "global" : "local"]}, which both Claude Code and OpenCode read.`)];
  }
  if (hasClaude && hasOpencode) {
    return [target("claude", "Both .claude and .opencode exist, so using the Claude-compatible path, which both agents read. Pass --opencode or --claude to choose, or both to install twice.")];
  }
  return [target(hasClaude ? "claude" : "opencode")];
}

function sameAsSource(src, dest) {
  try {
    return readFileSync(join(src, "SKILL.md"), "utf8") === readFileSync(join(dest, "SKILL.md"), "utf8");
  } catch { return false; }
}

/**
 * Copy (or link) each bundled skill into each target directory.
 * Returns [{ skill, agent, dir, status }] with status installed | up-to-date | conflict | would-install.
 * Nothing is written for conflicts unless `force` is set. Returns a `dest` path for display.
 */
export function installSkills({ targets, force = false, link = false, dryRun = false } = {}) {
  const out = [];
  for (const t of targets) {
    for (const skill of bundledSkills()) {
      const dest = join(t.dir, skill.name);
      const entry = { skill: skill.name, agent: t.agent, dir: dest };
      if (existsSync(dest) && !force) {
        if (sameAsSource(skill.dir, dest)) { entry.status = "up-to-date"; out.push(entry); continue; }
        entry.status = "conflict";
        out.push(entry);
        continue;
      }
      if (dryRun) { entry.status = "would-install"; out.push(entry); continue; }
      mkdirSync(t.dir, { recursive: true });
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      if (link) symlinkSync(skill.dir, dest, "dir");
      else cpSync(skill.dir, dest, { recursive: true });
      // sanity check: a broken copy should not look like a success
      if (!statSync(dest).isDirectory() || !existsSync(join(dest, "SKILL.md"))) throw new Error(`installed ${dest} but it has no SKILL.md`);
      entry.status = "installed";
      out.push(entry);
    }
  }
  return out;
}
