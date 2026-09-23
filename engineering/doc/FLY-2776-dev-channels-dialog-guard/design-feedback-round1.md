# Design Review — FLY-2776 plan.md (Round 1)

Date: 2026-09-22
Author: independent fresh-context reviewer (Codex + Gemini lanes unavailable)
Status: CHANGES REQUESTED

## Summary

The diagnosis is right and well-evidenced. I independently re-derived the root cause from the
sources and agree: nothing in the dialog text changed; `capture-pane -p` returns a *rendered
viewport*, and at 49x16 the title scrolls out of it while the 56-char hint soft-wraps, so two of
the three `grep -qF` fixed-string probes in `_dev_channels_dialog_present`
(`packages/teamlead/scripts/claude-lead.sh:1629-1635` at HEAD) can never succeed. The chosen
strategy — a line-anchored *structural* feature (the focused option row) AND a whitespace-squashed
*semantic* feature (one of three body sentences) — is the correct shape, keeps two mutually
independent features, and preserves the P4 "quoted transcript" contract. The test plan (P8–P13 on
byte-verbatim real captures, a mutation case, alert-branch cases) is the right rigor.

But the plan cannot be implemented as written. I ran the plan's literal `_dev_channels_strip_frame`
/ `_dev_channels_squash_ws` / `_dev_channels_dialog_present` against all 13 fixtures under the
locale the launcher actually runs in, and **three of the four "present" cases — including P1, the
existing FLY-1679 regression guard — evaluate to `absent`.** The guard would be *more* broken in
production than it is today, while passing in any developer shell and in CI. Separately, the
proposed `permission_blocked --severity severe` alert has two concrete Bridge-side side effects the
plan does not mention (a release-readiness HOLD and a silent auto-resolve), and the new drift rule
as specified will fire on benign transcript screens — including the fixture the existing T4b case
already feeds the poller.

Eight blockers below, each measured, not argued. All are fixable inside the plan's chosen strategy;
none require a different approach.

## Note on the working tree (read this first)

While I was reviewing, an implementation appeared in this worktree
(`packages/teamlead/scripts/claude-lead.sh`, `scripts/__tests__/fly1679-dev-channels-v2.test.sh`,
`.github/workflows/ci.yml`, new `scripts/__tests__/fly2776-dev-channels-geometry.test.sh`). The
review below is of **plan.md**, as asked. For the caller's benefit I re-ran every measurement
against the WIP code as well. Status:

| Blocker | plan.md | WIP code in this worktree |
|---|---|---|
| 1 locale / bracket expression | broken | **already fixed** — `LC_ALL=C` pinned on every match, frame written as ERE alternation `(│[[:space:]]*)?`, and a comment that names the byte-set hazard explicitly. I re-ran all 13 fixtures against the WIP predicate: **green under both unset and UTF-8 locales.** |
| 2 `grep -qF '--…'` | broken | **already fixed** — `grep -qF -e "$feature"` |
| 3 squash on raw, not stripped, text | broken | **still present** — `squashed="$(_dev_channels_squash_ws "$text")"` on the raw capture |
| 4 pipefail / SIGPIPE | ambiguous | **already fixed** — no pipelines at all; single `LC_ALL=C tr -s '[:space:]' ' ' <<<"$1"` |
| 5 `--severity severe` | broken | **still present** |
| 6 `permission_blocked` ∈ `LEAD_KINDS` | unaddressed | **still unaddressed**, and the new code comment repeats the overstated "ten registration faces" claim, including "both FLY-2006 retention tables" — which are kind-agnostic (see BLOCKER 6) |
| 7 drift fires on benign screens | broken | **still present verbatim** — `[ "$match_warning" -eq 1 ] || [ "$match_local_dev" -eq 1 ] || …` |
| 8 real-`claude` E2E cannot gate in CI | broken | **partially** — the ci.yml registration is correct (added after `fly1679` at `:1390`, right step, right shard), but the G/M layers still `SKIP: no executable claude on PATH`, and CI has none, so the negative control never runs |

So BLOCKERs 1, 2 and 4 are live only against **plan.md's text**, which must still be corrected
before it is archived as the record of what was built. BLOCKERs 3, 5, 6, 7 and 8 are live against
both the plan and the code.

Two residual notes on the WIP that change the details below:
- The WIP's frame alternation accepts only `│`, not `┃` or `|`. That is fine for the observed
  renderings and is *safer* than the plan's set — no change needed, but P1's fixture is the only
  bordered coverage, so BLOCKER 3's new bordered-and-wrapped case is still missing.
- I checked `packages/claude-runner/test/kill-path-inventory.ts:57-74`: the new suite's only kill
  line is `tmux -S "$s" kill-server`, which matches none of the five patterns
  (`kill-window`/`kill-session` require quotes; `kill -FLAG` requires a dash). **No
  `kill-path-inventory.json` entry is needed** as the file stands today — but it becomes needed the
  moment the suite grows a `kill -0` or `kill -TERM`, which a poller-reaping test very plausibly
  will.

## What's Good (Keep)

- **The root-cause work.** The exploration's disproof of the issue's own premise (same binary,
  `matched` at 04:18Z and `NOT_SEEN` at 07:02Z; all three strings present in 2.1.277/278/280;
  identical `pane_sha256` across two failures proving determinism) is exactly the standard this
  repo's `missing-history-is-not-completion-evidence` lesson asks for. Do not re-litigate it.
- **Two independent features, one structural + one semantic.** This is strictly stronger than the
  old three-fixed-strings rule, because the structural one ("a Select is rendering and the cursor
  is parked on option 1") is evidence that *pressing a key now is safe*, not merely that some text
  appeared. Keep it.
- **Rejecting scrollback (`capture-pane -S -N`).** I agree, and for the reason the FLY-1679 comment
  already gives at `packages/teamlead/scripts/claude-lead.sh:1622-1628`: a `--resume` cold start
  replays the prior transcript into scrollback, and this Lead's own content is literally about this
  dialog. Widening the search surface to history trades a 17-hour park for a stray keystroke into a
  live prompt on *every* cold start. Keep the "visible viewport only" rule. My BLOCKER 8 is about
  the *alert* widening that same surface, not the predicate.
- **Not touching the keystroke.** Single `1`, no Enter, verified live. Correct.
- **P8–P13 built from byte-verbatim real captures rather than hand-approximations.** The fixtures
  already staged in the working tree
  (`scripts/__tests__/fly1679-dev-channels-v2.test.sh:157-233`) are the right artifact; I used them
  as the oracle for every measurement below.
- **Milestone as literal-last commit** (`engineering/doc/milestones/FLY-2776.md`) matches
  `CLAUDE.md`'s single-writer contract. Keep.

## Issues & Recommendations

### BLOCKER 1 (already fixed in the WIP code; plan text still wrong) — `[│┃|]` is a *byte* set in the launcher's real locale; it eats the first byte of `❯` and `│`, and kills P1/P8/P9

**Issue.** `plan.md` §2 defines

```bash
_dev_channels_strip_frame() {
  sed -e 's/^[[:space:]]*[│┃|][[:space:]]*//' ...
}
```

`│` is `U+2502` = `E2 94 82`, `┃` is `U+2503` = `E2 94 83`, `❯` is `U+276F` = `E2 9D AF`. Under a
non-UTF-8 `LC_CTYPE`, BSD `sed` treats a bracket expression as a set of **bytes**, here
`{E2, 94, 82, 83, 7C}`. Every one of those three characters *starts* with `E2`, so the expression
matches and deletes a single `E2` byte — including the leading byte of `❯` itself on an unbordered
capture.

The launcher runs with no locale at all. Chain of evidence:

- `~/Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-cos-lead.plist` sets exactly one
  `EnvironmentVariables` entry, `FLYWHEEL_LEAD_MODEL`. No `LANG`/`LC_ALL`/`LC_CTYPE`.
- `launchctl getenv LANG` and `launchctl getenv LC_ALL` both return empty on this host.
- `~/.flywheel/bin/flywheel-lead-wrapper-v2.sh:532` —
  `for name in TMPDIR LANG LC_ALL LC_CTYPE CLAUDE_CONFIG_DIR; do [ -z "${!name:-}" ] || SERVER_ENV+=("$name=${!name}"); done`
  — forwards the locale to the tmux server **only if already set**. It is not.
- `packages/teamlead/scripts/claude-lead.sh:2324-2326` does the same conditional forwarding to the
  Claude child.

Measured, running the plan's code verbatim against the repo's own fixtures:

```
###### locale UNSET (production launchd reality) ######
FAIL P1     want=present got=absent      <-- the existing FLY-1679 regression guard
ok   P2..P7 want=absent  got=absent
FAIL P8     want=present got=absent      <-- the 49x16 capture this issue exists to fix
FAIL P9     want=present got=absent      <-- the historically-matching 120x40 capture
ok   P10..P13 want=absent got=absent

###### LANG=en_US.UTF-8 ######
ok   P1 .. P13   (all 13 green)
```

Byte-level proof on the P1 row:

```
input : e2 94 82 20 e2 9d af 20 31 2e 20 49 ...   "│ ❯ 1. I ..."
output: 94 82 20 e2 9d af 20 31 2e 20 49 ...      one E2 byte removed; line now starts with 0x94
```

**Why it matters.** This is the worst failure shape available: green on every developer laptop
(`LANG` is set in a login shell), green in CI (`.github/workflows/ci.yml` sets no locale, but the
GitHub ubuntu image exports `LANG=C.UTF-8` and ships GNU sed), and **dead in production**, where
the guard's entire job is to prevent an unattended Lead from parking. The current `grep -qF`
implementation is locale-immune by construction (fixed strings compare byte-wise); the plan would
trade that immunity away without noticing. It also silently regresses P1 — the bordered wide
dialog that works *today*.

**Suggested fix.** Two parts, both required.

1. Never put a multi-byte character inside a bracket expression. Either use one whole literal per
   `sed -e` expression, or collapse the whole thing into a single alternation regex and drop
   `_dev_channels_strip_frame` entirely. I measured this formulation green on all 13 fixtures in
   **both** locales:

   ```bash
   grep -qE '^[[:space:]]*(│|┃|\|)?[[:space:]]*(❯[[:space:]]+)?1\.[[:space:]]+I am using this for local development[[:space:]]*(│|┃|\|)?[[:space:]]*$' <<<"$text" || return 1
   ```

   (Alternation branches are whole literal byte sequences, so they are correct byte-wise and
   character-wise alike. `(❯…)?` is the BLOCKER-free version of NIT 5.)

   If you keep `_dev_channels_strip_frame`, the byte-safe form is one literal per expression —
   also measured green in both locales:

   ```bash
   sed -e 's/^[[:space:]]*│[[:space:]]*//' -e 's/^[[:space:]]*┃[[:space:]]*//' \
       -e 's/^[[:space:]]*|[[:space:]]*//' \
       -e 's/[[:space:]]*│[[:space:]]*$//' -e 's/[[:space:]]*┃[[:space:]]*$//' \
       -e 's/[[:space:]]*|[[:space:]]*$//'
   ```

2. **The suite must pin the production locale, or it cannot catch this class at all.** Run the
   predicate layer with `env -u LANG -u LC_ALL -u LC_CTYPE` (ideally a matrix: unset *and*
   `en_US.UTF-8`). `scripts/__tests__/fly1679-dev-channels-v2.test.sh` currently mentions no locale
   anywhere — I grepped. Without this the plan's own P8–P13 would have gone green on the author's
   machine and shipped a dead guard. This is the repo's `test-stub-pins-host-identity` lesson
   applied to `LC_CTYPE`.

`_dev_channels_squash_ws` is *not* affected — I verified `tr '\n' ' ' | tr -s '[:space:]' ' '`
produces byte-identical output in both locales, because every character in `[:space:]` is ASCII and
UTF-8 continuation bytes are all `>= 0x80`. Only the bracket expression is broken.

### BLOCKER 2 (already fixed in the WIP code; plan text still wrong) — `grep -qF '--dangerously-…'` is parsed as an option; that third body-sentence alternative never matches

**Issue.** `plan.md` §2, third `return 0` line:

```bash
grep -qF 'Please use --channels to run a list of approved channels.' <<<"$squashed" && return 0
grep -qF '--dangerously-load-development-channels is for local channel development only.' <<<"$squashed" && return 0
```

The pattern begins with `--`, so getopt consumes it. Measured:

```
$ grep -qF '--dangerously-load-development-channels is for local channel development only.' <<<"$s"
grep: unrecognized option `--dangerously-load-development-channels is for local channel development only.'
rc=2
```

**Why it matters.** `rc=2` is indistinguishable from "no match" in a `&& return 0` chain, so the
alternative is dead code. The narrow capture happens to also satisfy the `Please use --channels…`
alternative, so P8 would still pass once BLOCKER 1 is fixed — which means this bug is *invisible to
the test suite as designed* and quietly removes one third of the claimed redundancy. It matters in
exactly the geometry where the hint sentence is the one that scrolls off.

**Suggested fix.** Use `grep -qF -e '<pattern>'` (or `grep -qF -- '<pattern>'`) on **all three**
alternatives, not just the offending one, so the next literal that grows a leading dash is safe.
Add a fixture where only the `--dangerously-…` sentence is present (title and hint both gone) and
assert `present`; that is the case P8 currently masks.

### BLOCKER 3 (live in both plan and code) — squashing the *raw* capture, not the frame-stripped capture, leaves the wrapped-sentence fix incomplete

**Issue.** `plan.md` §2 computes `squashed="$(_dev_channels_squash_ws "$text")"` from the raw
capture, *after* `_dev_channels_strip_frame` has been used only for the option-row check. When the
dialog renders with a box border **and** the sentence wraps, the border glyphs land between the two
halves and the substring never rejoins. Measured (bordered 49-col rendering, UTF-8 locale so
`strip_frame` works at all):

```
squash of raw text      -> "... Please use --channels to run a list of │ │ approved channels. ..."  => BROKEN
squash of stripped text -> "... Please use --channels to run a list of approved channels. ..."      => REJOINED
```

**Why it matters.** The plan's headline claim is "宽度无关" — width-independent. It is only
width-independent for the *unbordered* rendering. `REAL_DIALOG`
(`scripts/__tests__/fly1679-dev-channels-v2.test.sh:66-82`, taken "verbatim from
DevChannelsDialog.tsx") is bordered; the 2.1.280 captures are not. Both renderings exist in this
repo's own evidence, so a future Claude version, theme, or `FORCE_COLOR`/width combination that
restores the border at a narrow width walks straight back into FLY-2776. Fixing it now costs one
line.

**Suggested fix.** Strip the frame first, then squash: `squashed="$(_dev_channels_squash_ws "$(_dev_channels_strip_frame "$text")")"`
(or, if you adopt the single-regex option-row form from BLOCKER 1, keep `_dev_channels_strip_frame`
solely for this purpose). Add a P14 fixture: bordered, narrow, title absent, sentence wrapped across
two bordered lines → `present`. That case currently has no coverage at all.

### BLOCKER 4 (already fixed in the WIP code; plan text still wrong) — the pipefail/SIGPIPE containment is under-specified, and a plain subshell is not enough

**Issue.** `plan.md` §2 closes with: "`_dev_channels_strip_frame` 的输出走管道进 `grep -qE`,必须在
函数体内把 pipefail 关掉再恢复;实现时用子 shell (`( set +o pipefail; ... )`) 隔离". Two problems:

1. "函数体内" is ambiguous. The pipeline lives in the **caller** (`_dev_channels_dialog_present`).
   `set +o pipefail` inside `_dev_channels_strip_frame` does nothing for the caller's pipeline
   status. The containment must wrap the pipeline itself.
2. A subshell **alone** does not contain it — `set +o pipefail` must be inside. Measured, with
   `set -euo pipefail` active and a producer large enough to actually SIGPIPE:

```
A ( strip | grep -qE ... )                  rc=141   <-- subshell alone: still a false negative
B strip | grep -qE ...                      rc=141   <-- bare pipeline
C ( set +o pipefail; strip | grep -qE ... ) rc=0
D s="$(strip)"; grep -qE ... <<<"$s"        rc=0
```

`rc=141` with `|| return 1` means the predicate reports **absent on a successful match** — the exact
false-negative class this issue is about.

**Why it matters.** The production input (a 49x16 or 200x50 pane, well under the 64 KiB pipe buffer)
will usually *not* SIGPIPE, so this would be a rare, geometry-dependent, unreproducible flake in the
one code path that must never produce a false negative. Worse, the plan introduces pipes into a
function whose own comment block, six lines above it, says the opposite
(`packages/teamlead/scripts/claude-lead.sh:1626-1627`): *"Here-strings, not pipes: `set -o pipefail`
is active in this launcher and a short-circuiting `grep -q` can SIGPIPE its producer."*

**Suggested fix.** Don't contain the hazard — delete it. Use form **D**, the style the file already
mandates and the surrounding code already uses everywhere:

```bash
local stripped squashed
stripped="$(_dev_channels_strip_frame "$text")"
grep -qE '<anchor>' <<<"$stripped" || return 1
squashed="$(_dev_channels_squash_ws "$stripped")"
grep -qF -e '<sentence>' <<<"$squashed" && return 0
```

Do the same inside `_dev_channels_squash_ws` — `tr '\n' ' ' | tr -s '[:space:]' ' ' | sed …` is a
three-stage pipeline whose status under `pipefail` becomes the function's status. It is consumed as
`squashed="$(_dev_channels_squash_ws "$text")"`, and in the **C2 classification path** that
assignment runs *outside* an `if` condition, where errexit is live — a non-zero there aborts the
poller before it writes the `NOT_SEEN classification` line and before the drift alert, destroying
the observability this ticket is adding. A single `tr -s '[:space:]' ' '` (the leading `tr '\n' ' '`
is redundant — `[:space:]` already covers `\n`) plus bash trimming removes the pipeline entirely.

Also: adopt BLOCKER 1's single-regex form and `_dev_channels_strip_frame` is needed only for
BLOCKER 3's squash input — two helpers become one, and the whole pipefail discussion evaporates.

### BLOCKER 5 (live in both plan and code) — `--severity severe` puts release readiness into HOLD, on *every* invocation, before dedup

**Issue.** `plan.md` §3 sends `--kind permission_blocked --severity severe`. Both values are
accepted by `scripts/lead-alert.sh` (allowlist at `:256`, severity check at `:264-271`), so this
will not error. But:

- `scripts/lead-alert.sh:1210-1213` inserts into `alert_version_observations` with the caller's
  `--severity` **unconditionally, inside the same transaction, *before* the
  `INSERT OR IGNORE INTO alert_claims` dedup at `:1214`.** Delivery is deduped; the observation is
  not.
- `packages/teamlead/src/bridge/release-readiness/policy.ts:7` — `severeHold: 1`.
- `packages/teamlead/src/bridge/release-readiness/evaluate.ts:274` collects `severity === "severe"`
  rows attributed to the subject commit; `:357-365` adds reason `severe_alerts` when
  `rows.length >= threshold`; `:367` returns `state: reasons.length ? "hold" : "green"`.
- The kind's own canonical severity is **warning**, not severe:
  `packages/teamlead/src/bridge/alert-kind-copy.ts:491` —
  `if (kind === "permission_blocked") return "warning";`

**Why it matters.** One dev-channels drift observation — a *diagnostic* signal about a guard, not a
product defect in the subject commit — flips the 12-hour release soak to `hold`. And because the
observation insert precedes dedup, it is recorded on every poller run even when the Discord
delivery is suppressed as a duplicate. Combined with BLOCKER 8 (spurious drift firing), this is a
mechanism for silently freezing releases.

**Suggested fix.** Send `--severity warning`. It matches `severityFor()`, keeps the kind's contract
coherent, and moves the readiness threshold from 1 to 5 (`policy.ts:8 warningHold: 5`). If you
genuinely want a release hold on guard drift, say so explicitly in the plan and in the milestone —
don't acquire it as a side effect of picking a severity word.

### BLOCKER 6 (live in both plan and code) — `permission_blocked` is in `AlertChannelHub.LEAD_KINDS`; the ticket auto-resolves itself

**Issue.** `packages/teamlead/src/bridge/AlertChannelHub.ts:280-286` —

```ts
const LEAD_KINDS: ReadonlySet<AlertEventType> = new Set([
	"rate_limit", "usage_limit", "login_expired", "permission_blocked", "crash_loop",
]);
```

On every reconcile tick (`:699-710`) the Hub captures the Lead's pane and calls
`shouldResolveLead` (`:819-821`), which is `classifyLeadAlertPane(pane) !== eventType`.
`packages/teamlead/src/bridge/pane-blocked-classifier.ts:18-21` recognizes `permission_blocked`
**only** via `/\bpermission\b.*\b(?:required|denied)\b/i`. A dev-channels dialog contains neither
word, so the classifier returns something else and the ticket is **resolved** — "the Lead recovered"
— while the Lead is still parked on the dialog.

The happy path dodges this: the shell POSTs to Discord directly and never writes an `alert_threads`
row (`lead-alert.sh:1358-1363`). But on a transient Discord failure the alert spills to
`~/.flywheel/alert-queue/` (`:1380`), the Bridge drains it, and `attachDeliveredAlertLifecycles`
creates the lifecycle row — after which the pane probe applies.

**Why it matters.** The exact scenario this ticket is fixing is "the Lead is offline and nobody
knows". The failure-path behavior of the chosen kind is "close the ticket claiming recovery". That
is the same class of bug, one layer up. The plan does not mention `LEAD_KINDS` at all; the research
§6 justification rests on `alert-kind-copy.ts:513`'s canned body, which — worth noting — is never
rendered for this alert, because the shell passes its own `--title`/`--body` (`lead-alert.sh:1355`,
`:1360-1363`). So the stated reason for reuse is weaker than it looks.

**Why the rest of the reuse argument holds.** I checked the other surfaces and found no violation:
`kind-contract.ts:78` is `{ owner: "founder_direct", arc: "human_by_design" }` with no
producer-keyed state (FLY-2075 note at `:27-30` says `arc` no longer drives escalation);
`infra-event-router.ts:39` routes it as a `TICKET_KIND` to `claude-infra-bot-lead` purely as a
function of `kind`; `ticket-owner-map.ts:73-77` puts it in `NO_OWNER_KINDS` and
`ticket-owner-map.test.ts:87-91` is a pure-function assertion no new producer can break;
`doc/oncall/contact-book.md:103` and `doc/architecture/infra-alerts-spec.md:55` both say
founder / no bot owner / human acts, and **neither document states a 1:1 kind↔producer rule** —
`deploy_failed`, `bin_integrity_drift`, `restart_guard_bypass` and `tui_window_lost` already have
both shell and Bridge producers. Retention is a non-issue: `fly-2006-retention-registry.mjs` /
`-engine.mjs` are table-level over the `comm` and `teamlead` DBs and contain no kind logic at all,
and `claims.db` is not registered — which also means the research §6 "十处登记面" cost estimate for
a *new* kind is overstated (it is roughly six, several one-line).

**Suggested fix.** Pick one, and write the choice into the plan:

- **(a) Minimum correct alternative, if you keep reuse:** it is acceptable *only* if you also state
  that the queue-drain path can self-resolve the ticket, and accept it. Weak.
- **(b) Preferred:** add `permission_blocked` handling that the pane classifier can satisfy, i.e.
  don't — that means teaching `pane-blocked-classifier.ts` about the dev-channels dialog, which
  re-introduces the recognizer you are trying to fix, in a second place.
- **(c) Cleanest:** use a dedicated kind (e.g. `lead_startup_dialog_drift`) that is **not** in
  `LEAD_KINDS`. Real cost, measured against the code, is: the `ALERT_EVENT_TYPES` union in
  `LeadAlertNotifier.ts`, `kind-contract.ts`, the `titleFor`/`bodyFor`/`severityFor` switches in
  `alert-kind-copy.ts`, the `lead-alert.sh:256` allowlist, `infra-event-router.ts` `TICKET_KINDS` +
  `ticket-owner-map.ts`, and the two docs. Six or seven one-liners, all mechanical, all guarded by
  `kind-contract.test.ts`. That is not disproportionate for a fleet-wide guard.
- **(d) Zero-registration escape hatch:** `external_config_error` is already shell-allowlisted,
  already in `contact-book.md:47-48`, already precedented at `claude-lead.sh:477-486`, and is **not**
  in `LEAD_KINDS`. It routes to Tadashi rather than the founder and understates urgency — but it
  ships tonight with no TS change and no self-resolve.

I would take (c); (d) is a defensible "make the bus" compromise. Do not take the plan as written.

### BLOCKER 7 (live in both plan and code) — the drift rule fires on benign transcript screens, and the plan's own existing T4b fixture is one of them

**Issue.** `plan.md` §3: "NOT_SEEN 且屏幕上出现了任何一个 dev-channels 专属特征
(`match_warning` / `match_local_dev` / `match_channels_hint` / `match_option_row` 任一为 1)→ …
发告警". `match_local_dev` is a bare substring probe for `I am using this for local development`.

`scripts/__tests__/fly1679-dev-channels-v2.test.sh:275` already runs the poller against
`TRANSCRIPT_A_PLUS_B` — a pure conversation transcript — and `:392` asserts the resulting
classification is `match_warning=1 match_local_dev=1 match_channels_hint=0 banner_channels=0
prompt_caret=1`. Under the new rule that screen would emit a **severe** drift alert. It is a Lead
talking in Discord, which is its job.

**Why it matters.** Three compounding effects:

1. Any Lead whose restored transcript or live Discord conversation mentions this flag alerts at the
   90-second mark. Aunt Cass was *literally discussing this issue* when the incident happened; the
   exploration and this very plan now contain the strings verbatim in the repo.
2. The dedup signature is the **pane digest**. A live conversation screen differs on every cold
   start, so every restart mints a new signature → a new alert. `KeepAlive` + `ThrottleInterval 30`
   in the plist means a churning Lead can cold-start every 30 s.
3. Each one carries `severity=severe` into `alert_version_observations` *before* dedup
   (BLOCKER 5) → repeated release-readiness holds.

That is an alert storm plus a release freeze, produced by the observability improvement.

**Suggested fix.** Gate the drift verdict on the **structural** flag, not "any of four":

- Alert when `match_option_row=1` (the box is rendering and waiting for a key, but required 2
  failed) — this is the genuinely dangerous state and it is exactly what the new
  `match_option_row` flag was added to distinguish.
- For the residual case where the option row itself wrapped (pane < ~44 cols, see BLOCKER 8's
  discussion), require **two or more** semantic flags rather than one; a transcript rarely carries
  the title *and* the unwrapped hint sentence *and* the `--dangerously-…` sentence.
- Make the signature **structural**, not a raw screen digest: e.g.
  `dev-channels-drift-<lead>-<match_option_row><match_warning><match_local_dev><match_channels_hint>`.
  One alert per Lead per distinct failure *shape*, which is what an operator actually needs, and it
  caps the storm. (Note `alert_claims` / `alert_deliveries` have **no** pruner — I searched; a
  `sent` row short-circuits to `exit 0` forever at `lead-alert.sh:1249-1253`. A digest signature is
  therefore a *permanent, unclearable* mute for that exact screen: an identical regression six
  months later is silent. A structural signature has the same permanence but a far smaller,
  intentional key space.)
- Add a negative test: feed the poller `TRANSCRIPT_A_PLUS_B` (the existing T4b fixture) and assert
  **no** alert is emitted. The plan's A2 covers "all flags 0"; it does not cover "benign screen with
  flags set", which is the real false-positive.

And note the plan's "P1–P7 一行不动" claim: **T4b at `:392` will break.** It pins the classification
line with an anchored regex ending `pane_sha256=([a-f0-9]{64}|-)$`, and C2 adds `cols=`, `rows=` and
`match_option_row=`. That edit must be in the change list.

### BLOCKER 8 (partially addressed in the WIP code) — the real-`claude` end-to-end cannot run in CI, so the mutation criterion never gates anything

**Issue.** `plan.md` §4 T2/E1 proposes launching `${FLYWHEEL_CLAUDE_BIN:-$(command -v claude)}` in a
real 49x16 tmux pane, with "没有可用 claude / 无凭据时 SKIP 并打印原因". CI never installs a `claude`
binary — the only global install in `.github/workflows/ci.yml` is `npm i -g npm@11.9.0` (`:1660`).
So E1 is a permanent SKIP in CI, and **E2, the mutation case that is supposed to prove the fix is
load-bearing, never runs.**

The house convention is the opposite of what the plan proposes: fly1679's own E layer is
**real tmux + fake Claude** (`scripts/__tests__/fly1679-dev-channels-v2.test.sh:746-748`,
"Fake Claude: paint a screen, then read RAW bytes from the pane tty"), with a three-tier guard where
the *only* legitimate skip is an affirmative raw-tty denial (`:866-874`) and everything else is red
(`:855-861`, `:878-882`), itself proven fail-closed by the H layer (`:1090-1143`). tmux *is*
available on the shards (`ci.yml:1367-1369`, `bash scripts/ci-apt-install.sh tmux lsof sqlite3 ripgrep`).

**Why it matters.** The plan's QA criteria 1 and 3 are its proof of correctness. If both live only
in a suite that always skips in CI, the guard is protected by nothing but the P-layer — which, per
BLOCKER 1, would itself have been green while production was dead. This is the
`quiet-gates-require-qualified-evidence` failure mode.

**Suggested fix.**

1. Restructure E1/E2 as **real tmux + a fake Claude that paints the byte-verbatim 49x16 capture**,
   exactly like fly1679's E layer. That gates in CI, runs in seconds, and still proves the
   send-keys path end-to-end. Keep a *separate*, explicitly manual real-`claude` verification and
   record its output in the PR body as one-time acceptance evidence — that is where the real binary
   belongs.
2. Run the mutation check (E2) against the fake-Claude E1, so it actually turns red in CI.
3. **Registration, precisely** (the plan says only "登记进 ci.yml 的 shell 套件枚举"):
   - `.github/workflows/ci.yml` — add `bash scripts/__tests__/fly2776-dev-channels-geometry.test.sh`
     to the existing step *Test — FLY-1663 launchd-native Lead lifecycle* in job `script-tests-6`,
     immediately after the `fly1679` line at **`:1389`**. Appending to an existing step avoids
     editing `scripts/__tests__/ci-structure.test.sh`'s `expected_shard_tests` (shard-6 list at
     `:1173-1190`, asserted at `:1239-1242`); creating a *new named step* would require that edit,
     and new steps may carry neither `if:` nor `continue-on-error:` (`:1244-1249`).
   - The classification guard the plan is worried about is
     `scripts/__tests__/ci-shell-suite-enumeration.test.sh` (run in `quick-gate`, `ci.yml:94`); its
     alternative registration surface is `scripts/__tests__/ci-shell-suite-manual-only.txt`, and the
     two are **mutually exclusive** (`:43`).
   - **Not named in the plan at all:** `packages/claude-runner/test/fixtures/kill-path-inventory.json`.
     The scanner (`packages/claude-runner/test/kill-path-inventory.ts:131-140`) sweeps `scripts/`
     and the test asserts exact equality (`kill-path-inventory.test.ts:227-234`). fly1679 has
     **five** entries there (`:2072-2100`). The suite as currently written needs none (its only
     `kill` line is `tmux … kill-server`, which matches no pattern at `kill-path-inventory.ts:57-74`),
     but it needs one the moment a `kill -0` / `kill -TERM` appears — which a poller-reaping test
     will want. Put it in the plan so it is not discovered by a red vitest.
   - Budget: `engineering/doc/FLY-1870-script-tests-timeout-cliff/research.md:98` records that the
     fly1679 E/H family already dominates shard 6, and `plan.md:162` marks the step "上限已紧". Each
     shard models 565 s against a 20 min / 85 % tripwire (`ci.yml:306-310`, `:1543-1545`). Budget the
     new suite's wall time explicitly; a real-`claude` launch with a 90 s dialog timeout would blow
     it even if a binary existed.

## NITs

### NIT 1 (partly addressed in the WIP: it now logs when the script is missing, but still re-derives the path) — re-derive nothing: `LEAD_ALERT_SH` and a near-identical helper already exist
`packages/teamlead/scripts/claude-lead.sh:3410` already defines
`LEAD_ALERT_SH="${FLYWHEEL_ROOT}/scripts/lead-alert.sh"`, and `:3412-3419` defines
`_lead_identity_alert()` with the same `--lead/--project/--kind/--severity/--title/--body || true`
shape. The plan's `_dev_channels_drift_alert` re-derives the path as `"${FLYWHEEL_ROOT:-}/scripts/lead-alert.sh"`.
`FLYWHEEL_ROOT` is set and exported at `:295`, so the `:-` default is dead — but if it ever weren't,
the path becomes `/scripts/lead-alert.sh`, `[ -x ]` fails, and the alert silently becomes a no-op:
the whole observability fix, gone, with no log line. Use `LEAD_ALERT_SH` (or extend
`_lead_identity_alert` with an optional `--signature`), and log a line when the script is missing
rather than returning 0 silently.

### NIT 2 — `|| _log_startup "drift alert delivery failed"` will lie on a *successful* queue
`scripts/lead-alert.sh` exits **0** for both dedup outcomes (`:1249-1253` already-sent,
`:1264-1269` duplicate lease), but exits **2** when the alert was durably queued (`:1254-1258`) or
dead-lettered (`:1259-1263`), and **3** on a `shasum` failure (`:1152-1155`, undocumented in its own
header). Exit 2 for "durably queued" is a *success* — the alert will be delivered by the Bridge
drain — yet the plan logs it as a delivery failure. Distinguish: treat 0 and 2 as delivered, log
only 1/3/other. Minor, but this log line is what a future on-call will read.

### NIT 3 — the alert call is a bare external command inside the background pane job
`packages/teamlead/scripts/claude-lead.sh:1690-1698` documents, from a *measured* incident, that a
bare external command in this position can be exec-replaced by bash's subshell optimization and take
the poller's process with it — which is why every `tmux` call in the function is wrapped in `$( )`.
The plan's `"$alert_sh" … >/dev/null 2>&1` is a bare external command in that same job. It is
followed by `return 0`, so the optimization should not apply — but this function's entire comment
history says "do not reason about when it applies". Wrap it in a command substitution for
consistency, and bound it (`lead-alert.sh` does `curl` + `sqlite3` + `jq`; a hang leaves the poller
resident until reap, which happens only when Claude exits — hours later).

### NIT 4 — `lead-alert.sh` needs credentials the poller may not have
Unless both `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` and `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` are set
(`lead-alert.sh:794-807`), the script resolves the Lead from `projects.json` (`:828-856`) and needs
that Lead's `alertBotTokenEnv` live in the environment; a miss is `exit 1`. The trusted-`.env`
auto-load only fires for `LEAD_ID = "system"` or `FLYWHEEL_CMUX_SUPERVISED=1` (`:483`) — neither
applies here. It also needs `jq`, `sqlite3`, `shasum`, `curl`. The plan should say what the operator
sees when this degrades; right now it is one `_log_startup` line inside a `|| true`. Add an A4 case:
`lead-alert.sh` exits 1 (config) → poller still exits 0 **and** the startup log names the reason.

### NIT 5 — the anchor hard-requires the cursor to be parked on option 1
`^❯[[:space:]]+1\.…` is strictly stronger than today's predicate: it now also asserts focus. That is
a feature (it is what makes "pressing 1 is safe" true), but it means a future Claude that renders
the dialog with focus elsewhere, or with a different caret glyph, silently kills the guard fleet-wide.
Making the caret optional — `(❯[[:space:]]+)?1\.[[:space:]]+I am using this for local development` —
costs nothing and still excludes P4/P12, because those quote the row *mid-line*. I measured this
variant green on all 13 fixtures in both locales. Recommend it.

### NIT 6 — line-anchoring defends against inline quoting, not against a block paste
P4 and P12 quote the option row *inside* a prose line, which is why anchoring works. A Lead that
pastes or renders a fenced capture block — which is now literally present in
`engineering/doc/FLY-2776-dev-channels-dialog-guard/exploration.md` and in the test fixtures — puts
the option row on its own line *and* the body sentence on screen, and the predicate says `present`.
The old predicate had the same hole, so this is not a regression, but the plan widens it (one
whitespace-squashed sentence anywhere on screen instead of three exact unwrapped lines) and does not
name it. Cost is bounded (a stray `1` into an input box, never Enter — research §2 is right about
that), so I am not blocking. Two cheap mitigations worth considering: require the *absence* of the
live input-box markers (`⏵⏵ auto mode on`, the `╰─` prompt frame) — the dialog is modal and hides
them, a transcript does not; and/or require the footer `Enter to confirm · Esc to cancel` as a third
line-anchored structural feature. Either way, **name the residual risk in the plan.**

### NIT 7 (already done in the WIP code) — stale comments will contradict the new code
`packages/teamlead/scripts/claude-lead.sh:1616-1627` says "All three must be on screen at once" and
"Here-strings, not pipes". After this change the first is false and the second is either restated or
violated. Rewrite that block as part of C1 — it is the only place the next engineer will look.

### NIT 8 (already done in the WIP code) — `_dev_channels_squash_ws`'s first `tr` is redundant
`tr '\n' ' '` then `tr -s '[:space:]' ' '` — the second already covers `\n`. One `tr` (or, with
BLOCKER 4's fix, one `tr` plus bash trimming) is enough.

### NIT 9 — pane geometry is in the classification but not in the alert
C2 adds `cols=`/`rows=` to the classification log — good, that is the single most diagnostic field
and it is what would have made this incident a five-minute triage. Put it in the **alert body** too.
It is shape, not content, so it carries no FLY-1948 / FLY-220 exposure, and it is the first thing
the responder will want.

### NIT 10 — the "residual risk" registration in research §4 deserves a number
"pane 窄到 < ~44 列" — I confirmed the row is exactly 44 columns
(`2 + ❯ + space + "1." + space + 37`). Failing closed there is the right call: a stray keystroke into
a live prompt is worse than a no-op, and with BLOCKER 7's fix the drift alert makes the failure
loud rather than silent. Put the literal `44` in the code comment so the next person can reason
about a geometry change without re-measuring.

## Verdict

CHANGES REQUESTED.

The strategy is right and the diagnosis is excellent. BLOCKERs 1, 2 and 4 — the shell constructs
that behave differently under the launcher's real `set -euo pipefail` + unset-locale environment
than they do in a terminal — have **already been fixed** in this worktree's implementation, which I
verified green on all 13 fixtures in both locales; the plan text must still be corrected so the
archived record matches what was built. BLOCKER 1 is worth keeping in the record regardless: as
written, the plan would have shipped a guard that is green on every developer machine and in CI
while being *more* broken in production than today, across every Claude-carrier Lead (17 lead
plists installed on this host), and the suite as designed could not have caught it.

What remains open is BLOCKER 3 (the width-independence claim is only true for the unbordered
rendering) and the whole alert leg, BLOCKERs 5–7: as specified and as coded it fires on benign
transcript screens — including the fixture the existing T4b case already feeds the poller — mints a
fresh permanent dedup key on every cold start, freezes release readiness at `severeHold: 1`, and on
the queue-drain path closes its own ticket via a pane regex a dev-channels dialog can never match.
BLOCKER 8 is that the negative control meant to prove the fix is load-bearing still cannot run in CI.

None of this requires abandoning the approach — the predicate is already there and already correct.
Fix BLOCKER 3, settle the alert kind and severity (BLOCKERs 5–6), narrow the drift trigger and make
its signature structural (BLOCKER 7), move the negative control onto a fake Claude so it gates
(BLOCKER 8), and bring plan.md's §2 code block in line with what shipped. Then this is ready.

One process note: the plan is being implemented while it is under design review. That is the
caller's call, not mine, but it means plan.md is now behind the code in three places, and plan.md is
what the archive will keep.
