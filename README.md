# timecamp-cli

A small, dependency-free CLI and TUI for automating TimeCamp (app.timecamp.com)
time entries. It's designed to be driven by an AI agent through the bundled
skill (`skills/timecamp/SKILL.md`), and has an interactive week editor for
humans.


<img width="846" height="982" alt="image" src="https://github.com/user-attachments/assets/6fe3ded5-379c-46ca-8302-c4701491c30c" />


## Setup

Install it globally with npm (no registry or publish needed):

```bash
git clone git@github.com:mod3-tech/timecamp-cli.git ~/programming/work/timesheet
cd ~/programming/work/timesheet
npm install -g .
timecamp setup
```

`npm install -g .` links the `timecamp` command to your clone, so `git pull`
updates it. Only re-install if `package.json` changes (`bin`, name); code
changes need nothing. `npm link` does the same thing without recording a
global install. To remove it: `npm uninstall -g timecamp-cli`.

The command runs on [Bun](https://bun.sh) when it's installed (faster
startup) and falls back to Node otherwise. It needs a POSIX shell, so on
Windows use WSL or Git Bash.

Install straight from git instead, without keeping a clone:

```bash
npm install -g git+https://github.com/mod3-tech/timecamp-cli.git
```

That copies the code, so re-run it to update.

### First run

```bash
timecamp setup
```

It logs you in (hidden token prompt), works out which tag lists are CAPEX and
which are OPEX from their names, writes `~/.config/timecamp/config.json`, and
checks everything. It's safe to re-run; `--force` rebuilds the classification
after your tag lists change.

Doing it by hand is also fine:

1. Get your API token: TimeCamp → avatar → **Profile Settings** → *API token*
   (bottom of the page).
2. Log in: `timecamp login`, or pipe it in: `timecamp login < tokenfile`.
   The token is verified before it's saved to `~/.config/timecamp/token`
   (mode 600). `timecamp logout` removes it.
   (`TIMECAMP_API_TOKEN`, if set, overrides the saved token.)
3. Check it: `timecamp me`
4. Optional: create `~/.config/timecamp/config.json` to classify tag lists as
   CAPEX or OPEX and to set your working day. Find the list ids with
   `timecamp tags`. `timecamp setup` writes this for you.

   ```json
   {
     "classification": { "capex": [54149, 54150, 54156, 54157], "opex": [54158, 54159, 54842] },
     "dayStart": "08:00",
     "dayHours": 8
   }
   ```

### Install the skill

```bash
timecamp skills install              # this project: .claude/skills/timecamp
timecamp skills install --opencode   # ... or .opencode/skills/timecamp
timecamp skills install --pi         # ... or .pi/skills/timecamp (--global: ~/.pi/agent/skills)
timecamp skills install --global     # every project: ~/.claude/skills (or ~/.config/opencode/skills)
```

With no agent flag it uses `.claude/skills` (read by both Claude Code and
OpenCode) when a `.claude` directory exists, `.opencode/skills` when only
`.opencode` exists, and `.claude/skills` when there's neither. `--claude` and
`--opencode` choose explicitly; passing both installs twice, which is opt-in
because agents expect skill names to be unique across locations. `--global`
applies the same rules to `~/.claude` and `~/.config/opencode` instead of the
current directory. Pi doesn't read `.claude/skills`, so it's never picked
automatically: pass `--pi`.

The skill is copied, so a project commit carries it and other machines don't
need this tool; re-run the command after upgrading to refresh it. `--link`
symlinks instead (handy while developing the skill), `--force` replaces a
locally modified copy, and `--dry-run` shows what would happen.

## TUI

```bash
timecamp tui            # this week
timecamp tui --week -7  # last week
```

The default view is a week grid (epic+tags rows, day columns); `?` lists the keys, `v` toggles the list view. Submitted weeks are labelled and read-only.

The list view shows one week at a time: days with totals, a warning on days that are
short or empty, and every entry with its CAPEX/OPEX class, epic, tags and note.

| Key | Action |
|---|---|
| `↑↓` / `j k`, `J K` | Move between rows; jump between days |
| `←→` / `h l` | Previous / next week (`t` jumps to this week) |
| `a` or Enter on a day | Add an entry. It starts after the day's last entry, fills to your daily target, and reuses the nearest epic and tags, so often you can just press Enter. |
| `e` or Enter on an entry | Edit it |
| `c` | Copy the entry to the next workday (opens the form) |
| `d` | Delete (asks first) |
| `p` | Copy the previous week into this one, skipping overlaps |
| `r` / `?` / `q` | Reload / help / quit |

In the form, Enter on **Epic** opens a search over all tasks (epics are listed
before stories), and Enter on **Tags** opens a multi-select labelled CAPEX or
OPEX. Ctrl-S saves. `s` submits the week for approval, after a confirmation. The CLI and the agent skill never submit.

### Mouse

The mouse is on by default:

| Gesture | Effect |
|---|---|
| Click | Select a row; press header, footer and form buttons (`‹ h`, `l ›`, `a add`, `[ Create entry ]`, `[ y: yes ]` …); focus a form field (Epic and Tags open their pickers); toggle a tag |
| Double-click | On a day: add an entry. On an entry: edit it. In the epic picker: pick. |
| Wheel | Move the selection |
| Drag | Select text anywhere on screen. On release it's copied to the clipboard (shown in the status line). |

Copying uses OSC 52, which Windows Terminal, iTerm2, kitty, WezTerm and most
modern terminals support. Under tmux, enable `set -g set-clipboard on`. If your
terminal doesn't support it, add a clipboard command to the config, e.g.
`"clipboardCommand": ["powershell.exe", "-noprofile", "-command", "$input | Set-Clipboard"]`
on WSL, or `["wl-copy"]` / `["xclip", "-selection", "clipboard"]` on Linux.
Shift-drag still gives you your terminal's own selection.

To turn the mouse off, run `timecamp tui --no-mouse` or set `"mouse": false` in
the config.

## CLI

```bash
timecamp tasks --search "L27-1100]"
timecamp summary --week
timecamp add --date today --start 09:00 --end 12:30 --task 173712697 --tags 140851 --note "API work"
timecamp bulk week.json --dry-run && timecamp bulk week.json
timecamp help
```

The full task list is cached for 24h in `~/.cache/timecamp/`. Pass
`--refresh` to re-download it.

## Development

`npm test` runs the CLI against a local mock of the TimeCamp API. You don't
need a token or network access.

To run the tests before every commit, enable the bundled hook once per clone:
`git config core.hooksPath .githooks`. Skip it for one commit with
`git commit --no-verify`.

The code is split into `lib/core.mjs` (API client and entry logic), `bin/timecamp.mjs`
(CLI), `lib/tui.mjs` (TUI), `lib/mouse.mjs` (mouse parsing, click-vs-drag
detection, text selection) and `lib/skills.mjs` (installing the bundled skill).

Environment overrides: `TIMECAMP_BASE_URL`, `TIMECAMP_API_TOKEN_FILE`,
`TIMECAMP_CONFIG`, `TIMECAMP_CACHE_DIR`.

## TimeCamp API docs

OpenAPI spec: <https://developer.timecamp.com/reference/dist/api-prod.yaml> (the docs site needs a JS browser).
`GET /approval` status: 0 open, 1 approved, 2 pending, 3 rejected; no user filter.
