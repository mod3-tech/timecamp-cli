---
name: timecamp
description: Log, review, fix, and delete the user's time entries in TimeCamp (app.timecamp.com) with the `timecamp` CLI, logging against Jira epics and choosing tags that classify the time as CAPEX or OPEX. Use when the user asks to fill in or automate their timesheet, log hours against a project, epic or task, record what they worked on today or this week, check how many hours they've logged or which days are missing, classify time as CAPEX or OPEX, correct or remove an entry, or start or stop the TimeCamp timer.
---

# TimeCamp timesheet CLI

`timecamp` (on PATH via `~/.local/bin/timecamp` → `~/programming/work/timesheet/bin/timecamp.mjs`)
is a dependency-free Node 18+ CLI. It talks to the TimeCamp REST API
(`https://app.timecamp.com/third_party/api`) as the token owner, so it only
reads and writes **the user's own** entries.

## Setup

```bash
npm install -g .        # one-time, from the clone; then:
timecamp setup          # user's job: logs in, writes the CAPEX/OPEX config
timecamp me             # sanity check: prints name/email/user_id
```

If a command fails with a 401 or "No API token", ask the user to run
`timecamp login` (or `timecamp setup`) in their own terminal. In OpenCode they
can prefix it with `!`. Never run `login` yourself and never ask the user to
paste the token into the chat. `TIMECAMP_API_TOKEN`, if set, overrides the
saved token.

`~/.config/timecamp/config.json` maps tag lists to CAPEX/OPEX and sets the
working day. With it in place, `entries`, `summary`, `tags` and the TUI show a
CAPEX/OPEX class for each entry and tag:

```json
{ "classification": { "capex": [54149, 54150, 54156, 54157], "opex": [54158, 54159, 54842] },
  "dayStart": "08:00", "dayHours": 8 }
```

The task list (~150k tasks, ~30s to download) is cached for 24h in
`~/.cache/timecamp/tasks.json`. Pass `--refresh` to `tasks` (or any command
that looks up a task by name) if an epic was created recently and isn't found.

`timecamp tui` is an interactive week editor for the **user**. Agents can't
drive it, so use the commands below. Do suggest it when the user wants to
review or tweak a week by hand.

## Commands

| Command | Purpose |
|---|---|
| `login` / `logout` | **User-only.** Save (after verifying) or remove the API token. |
| `setup` | **User-only.** First-run setup: login + CAPEX/OPEX config. Safe to re-run. |
| `skills install` | **User-only.** Copy the skill into `./.claude/skills`, `./.opencode/skills` or `./.pi/skills` (or `--global`). |
| `me` | Who the token belongs to. |
| `tasks [--search TEXT] [--archived]` | Projects and tasks you can track to, as `id` + full path (`Client / Project / Task`). |
| `tags [--search TEXT]` | Tag ids, grouped by tag list. |
| `entries [RANGE] [--task T]` | Your entries (id, date, start–end, duration, CAPEX/OPEX class, task, note, tags, `$`=billable, `locked`). Defaults to today. JSON includes `class`: `CAPEX`, `OPEX`, `MIXED`, `UNTAGGED`, or `UNKNOWN`. |
| `summary [RANGE]` | Hours per day (including empty days), per task, and per CAPEX/OPEX class. Use it to find gaps and check the split. |
| `add --date D (--start HH:MM --end HH:MM \| --start HH:MM --duration DUR \| --duration DUR) [--task T] [--note TEXT] [--tags ID,ID] [--billable\|--no-billable]` | Create one entry. |
| `update ID [--date] [--start] [--end] [--duration] [--task] [--note] [--tags ID,ID] [--billable\|--no-billable]` | Change only the fields you pass. `--tags` replaces the entry's tag set; `--tags ""` clears it. |
| `delete ID [ID...] --yes` | Permanently delete entries. |
| `bulk FILE.json` / `bulk -` | Create many entries from a JSON array (see below). |
| `timer status` / `timer start [--task T]` / `timer stop` | Live timer. |

- **RANGE**: `--date D`, `--from D --to D`, `--week [D]` (Mon–Sun containing D), `--month [D]`.
- **D**: `YYYY-MM-DD`, `today`, `yesterday`, or `-N`/`+N` days relative to today.
- **DUR**: `1h30m`, `1.5h`, `90m`, `1:30`, `5400s`. A bare number means hours.
- **T**: a numeric task id (preferred), or a name/path fragment that matches
  exactly one active task. If it matches several, the CLI exits with an error
  and lists the candidates.
- Global: `--json` gives machine-readable output on every command. `--dry-run`
  prints the exact API request(s) and changes nothing.
- Exit codes: `0` ok, `1` error, `2` usage error, `3` `add` skipped because it
  overlaps an existing entry.

## Bulk format

```json
[
  { "date": "2026-10-19", "start": "09:00", "end": "12:30", "task": 11, "note": "API pagination", "tags": [21] },
  { "date": "2026-10-19", "start": "13:30", "duration": "3h", "task": "Acme / Frontend", "note": "Checkout bugs" },
  { "date": "2026-10-20", "duration": "7.5h", "task": 13, "note": "Planning", "billable": false }
]
```

Fields per item: the same ones `add` takes. `date` and either
`start`+`end`/`duration` are required. `tags` can be an array or `"21,22"`.
Every item is validated before anything is written, so if one is bad, nothing
gets created. Items that overlap an existing entry (same date, same task,
overlapping time range) or duplicate one (same duration and note) are
**skipped**. This makes re-running a bulk file safe. Pass `--allow-duplicate`
to turn that check off.

## What these timecards are for: CAPEX vs OPEX

The main purpose of this timesheet is to split time into **capitalizable
(CAPEX)** and **operating (OPEX)** work. **The tags decide the classification,
not the task.** Getting the tags right matters more than getting the task
detail right.

### Task level: log against the epic

TimeCamp mirrors Jira: `Jira / <Project> / [KEY-n] <bucket> / [KEY-nnnn] <Epic> / [KEY-nnnn] <Story>`.
Log against the **epic**, e.g. `[L27-1100] Developer Ownership Transfer`
(id 188181304). Don't log against individual stories or tickets
(`[L27-1103] ...`), and don't log against the top-level bucket
(`[L27-1] (Time Camp) Software Maintenance`).

- The account has ~150k tasks. **Always use `tasks --search`** (search by Jira
  key, e.g. `--search "L27-1100]"`, or by epic name). Never list everything.
  Prefer numeric ids once found.
- If the user names a story or ticket, walk up its path to the epic and log
  there.
- The bucket name (e.g. "Software Maintenance") does **not** set the
  classification. The tags do.

### Tag classification

| Classification | Tag list (list id) | Tags (id) |
|---|---|---|
| **CAPEX** | Design & Development (54149) | Design Workshops/Meetings (138484), Architecture Design Documents (138491), Database Architecture (138492), Solution Design Documentation (138493), Screen Mockups / Straw mans (138494), Developing API's (138495), Developing Front end (138496), Developing Back End (Data base) (138497), Developing Middle Tier (141003), Unit Testing Development (138498), Preparation of Migration of Code (138499), Development of DB Migration Scripts (138500), Addressing Identified Bugs (not yet in production) (138501), Documenting Epics / Stories (139970) |
| **CAPEX** | Testing (54150) | Test Plan / Script Preparation (138487), Test Automation / Execution (138488), Test Documentation (138489), Documenting Bugs not yet in production (138490) |
| **CAPEX** | Project Management Design & Development Phase (54156) | Project Management Design & Development Phase (139671) |
| **CAPEX** | Implementation Work not yet in Production (54157) | Pilot Phase (Beta) before release to all/majority of customers (138508), Platform Configuration (for production) (138509) |
| **OPEX** | Pre Approval and Pre Design & Development (54158) | Pre Approval and Pre Design & Development (139670) |
| **OPEX** | Implementation & Software Maintenance (54159) | Implementation Data Migration / Associated Testing (138523), Implementation Release Documentation (138524), Implementation Communication (138525), Implementation Production Release Tasks (138526), New Feature/Platform Training & Documentation (138527), Post Go Live Work (139669), External Defect Resolutions (139971), Bug Fixes (post production) (140851) |
| **OPEX** | Administrative Tasks (Non-Capex) (54842) | Administrative Tasks (Non-Capex) (140850) |

Ids were taken from `timecamp tags` on 2026-10-23. If a tag id is rejected,
re-run `timecamp tags` because the list may have changed.

Choosing tags:
- Pick tags that describe **what was actually done**: building or testing
  something not yet in production is CAPEX; fixing, releasing, supporting, or
  training on something already in production is OPEX. The key question is
  usually **"is this in production yet?"** (bugs before release → 138501 /
  138490 CAPEX; bugs after release → 140851 / 139971 OPEX).
- **Keep tags minimal.** The tags only need to make CAPEX vs OPEX clear. One or
  two accurate tags per entry are enough; don't try to list every activity.
  Production bug work, for example, needs only Bug Fixes (post production)
  (140851).
- **Mixing CAPEX and OPEX tags on one entry is fine.** Finance handles the
  split. In earlier weeks the user tagged a dev day with Test Plan / Script
  Preparation, Test Automation / Execution, Test Documentation, Architecture
  Design Documents and Administrative Tasks (Non-Capex)
  (`[138487,138488,138489,138491,140850]`). More tags than that aren't needed.
- Every project entry should have at least one tag. When a description is
  vague, ask the user rather than defaulting to CAPEX tags. Over-capitalizing
  is the costly mistake.
- To mirror a previous period, copy the tags from that period's entries
  (`entries --week D --json` shows the tag ids) and confirm they still apply.

### Non-project time

Use the **Administrative Projects - (Non-capex)** tasks, tagged with
Administrative Tasks (Non-Capex) (140850):

| Situation | Task id |
|---|---|
| PTO, holidays, sick days | 173232315 `Time Off (Holidays, PTO, Sick, etc)` |
| Training | 173232325 `Training` |
| General overhead or meetings not tied to an epic | 173232333 `Non-Project time` |
| Marketing | 177563874 `Marketing` |

## Workflow for an agent

1. **Orient.** Run `timecamp me`. Map the user's work to **epic task ids**
   with `tasks --search`, and pick tags using the CAPEX/OPEX section above. If
   an epic or tag choice is ambiguous, ask once and reuse the answer for the
   rest of the session. Never guess a project for billable time.
2. **Look before writing.** Run `timecamp summary --week` (or the relevant
   range) and `timecamp entries --week` to see what's already logged and which
   days are short. Don't double-log.
3. **Draft, then confirm.** For anything beyond a single entry the user spelled
   out, write the planned entries to a bulk JSON file (e.g. under
   `/tmp/opencode/`). Run `timecamp bulk FILE --dry-run` and show the user a
   short table (date, time, hours, epic, tags with CAPEX/OPEX marked). Write
   only after they agree.
4. **Write.** Run `timecamp bulk FILE` (or `add` for one entry). Read the
   CREATED/SKIP lines. If an entry was skipped, explain why rather than forcing
   it with `--allow-duplicate`.
5. **Verify.** Re-run `timecamp summary` for the range and report the per-day
   totals and the CAPEX/OPEX hours so the user can see the result. Flag any
   `UNTAGGED` entries.
6. **Don't submit.** The CLI can't submit a timesheet for approval, and that's
   deliberate. The user reviews and submits the week in TimeCamp themselves.

### Epics the user commonly logs to (Launch27, under `[L27-1] (Time Camp) Software Maintenance`)

| Epic | Task id |
|---|---|
| [L27-14] General Bugs - BackEnd | 173712697 |
| [L27-5] General Bugs - Old FE | 173607800 |
| [L27-1022] General Bugs - FE | 187608885 |
| [L27-1100] Developer Ownership Transfer | 188181304 |
| [L27-601] System Performance | 181328513 |
| [L27-16] AWS Infrastructure | 173712695 |
| [L27-8] General Bugs - Android | 173712702 |
| [L27-9] General Bugs - iOS | 173712701 |
| [L27-11] Automaid Project Management | 173712699 |
| [L27-94] Meetings, Deployments and Requirement discussions | 174374345 |

When the user splits a day across several epics without giving proportions,
split it evenly within their usual 08:00–16:00 day and say so in the draft.

Fixing mistakes: find the id with `entries --date D`, then `update ID ...` or
`delete ID --yes`. Only delete entries the user asked you to remove, or entries
you created in this session.

## Gotchas

- **Locked entries.** Entries in an approved or pending timesheet show
  `locked`. TimeCamp returns 403 when you try to edit them. Tell the user;
  don't try to work around it.
- **Times are in the user's TimeCamp timezone**, as a local wall clock with no
  offset. An entry can't cross midnight: split it into two.
- Duration-only entries (no `--start`) have no meaningful clock time. Prefer
  start/end when the user knows the times, so overlap detection works.
- If your account requires tags or tasks on every entry, TimeCamp returns 400
  or 403 with a message. Pass that message on as-is.
- Rate limits depend on the TimeCamp plan. The CLI retries on 429 with
  backoff, but `bulk` makes one request per entry, so for big backfills do a
  week at a time.
- `tasks` hides archived tasks unless you pass `--archived`. You can't log to
  archived tasks.
- Writes are permanent. There's no undo except `update` or `delete`, so dry-run
  first when you're unsure.
