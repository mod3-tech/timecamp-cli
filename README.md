# timecamp-cli

A small, dependency-free CLI and TUI for automating TimeCamp (app.timecamp.com)
time entries. It's designed to be driven by an AI agent through the bundled
skill (`skills/timecamp/SKILL.md`), and has an interactive week editor for
humans.

## Setup

1. Put it on your PATH: `ln -s "$PWD/bin/timecamp.mjs" ~/.local/bin/timecamp`
2. Log in: `timecamp login`. Paste your API token from TimeCamp (avatar →
   **Profile Settings** → *API token*, at the bottom of the page). Input is
   hidden, the token is verified before it's saved, and it's stored in
   `~/.config/timecamp/token` with mode 600. Non-interactive:
   `timecamp login < tokenfile`. `timecamp logout` removes it.
   (`TIMECAMP_API_TOKEN`, if set, overrides the saved token.)
3. Check it: `timecamp me`
4. Optional but recommended: create `~/.config/timecamp/config.json` to
   classify tag lists as CAPEX or OPEX and to set your working day. Find the
   list ids with `timecamp tags`.

   ```json
   {
     "classification": { "capex": [54149, 54150, 54156, 54157], "opex": [54158, 54159, 54842] },
     "dayStart": "08:00",
     "dayHours": 8
   }
   ```

### Install the skill

```bash
ln -s "$PWD/skills/timecamp" ~/.claude/skills/timecamp
```

## TUI

```bash
timecamp tui            # this week
timecamp tui --week -7  # last week
```

The TUI shows one week at a time: days with totals, a warning on days that are
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
OPEX. Ctrl-S saves. The TUI never submits a timesheet for approval.

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

The code is split into `lib/core.mjs` (API client and entry logic), `bin/timecamp.mjs`
(CLI), `lib/tui.mjs` (TUI) and `lib/mouse.mjs` (mouse parsing, click-vs-drag
detection, text selection).

Environment overrides: `TIMECAMP_BASE_URL`, `TIMECAMP_API_TOKEN_FILE`,
`TIMECAMP_CONFIG`, `TIMECAMP_CACHE_DIR`.
