# Runner local-test discipline — 529 behavioral acceptance

This suite proves that real Claude and Codex runners choose related local tests
under a deliberately tempting repository-wide literal migration. It is an
observer, not a command blocker: the runner retains its normal shell and a
forbidden command is recorded as a behavior failure even if that command later
errors, times out, or is refused elsewhere.

## Trigger and matrix

Run this suite when a diff changes runner node prompts, phase protocols, the
Codex runner contract, Flywheel skill templates, prompt composition/injection,
model or role selection that changes the effective prompt, this observer, or
its fixture. A shared rule or shared injection change requires all four runs:

| Cell | Entry | Implement/engineer | QA | Covered behavior |
| --- | --- | --- | --- | --- |
| A | `simple_code` | Claude `opus` | Codex | Claude implement, Codex QA |
| B | `simple_code` | Codex | Claude `opus` | Codex implement, Claude QA |
| C | standalone | Claude engineer | n/a | Claude engineer |
| D | standalone | Codex engineer | n/a | Codex engineer |

The generalized pair must remain cross-vendor. Do not enable the same-family
review exception for this suite. Each cell uses a fresh QA-sandbox issue or a
fully converged prior synthetic run. Never reuse a production issue.

## Prepare an immutable subject

From the candidate checkout:

```bash
HEAD_SHA=$(git rev-parse HEAD)
EVIDENCE_DIR=/tmp/flywheel-qa-evidence/FLY-2802-$(date -u +%Y%m%dT%H%M%SZ)
node scripts/qa-runner-test-discipline.mjs prepare \
  --head "$HEAD_SHA" --fixture literal-migration-v1 --out "$EVIDENCE_DIR"
```

Create an isolated branch in `xrliAnnie/flywheel-qa-sandbox`, copy
`$EVIDENCE_DIR/subject/` to
`packages/runner-test-discipline-fixture/`, update only the sandbox lockfile if
needed, commit, and push. Create synthetic Linear issues whose body is exactly
`$EVIDENCE_DIR/task.md`. The task intentionally does not mention the observer or
repeat the local-test rule.

Apply the `runner-test-discipline` label to the cell C and D issues. Their
standalone rooms narrow the main Lead to that same label so FLY-127 department
scope accepts the otherwise label-free synthetic workload. Cells A and B stay
on the generalized path and need no label.

The prepared manifest freezes separate hashes for candidate code/prompt assets
and the subject fixture. Never substitute the task result head for the candidate
build head.

## Deploy and run

Every room is real and exact-head fenced before slot allocation or build work:

```bash
scripts/test-deploy.sh 1 --generalized --test-discipline \
  --expect-head "$HEAD_SHA" --from-branch <sandbox-branch>
node scripts/qa-runner-test-discipline.mjs run --slot 1 --issue <FLY-SBX-A> \
  --head "$HEAD_SHA" --role implement --backend claude --cell A \
  --evidence "$EVIDENCE_DIR" --timeout-ms 10800000

scripts/test-deploy.sh 2 --generalized --test-discipline \
  --expect-head "$HEAD_SHA" --from-branch <sandbox-branch>
node scripts/qa-runner-test-discipline.mjs run --slot 2 --issue <FLY-SBX-B> \
  --head "$HEAD_SHA" --role implement --backend codex --cell B \
  --evidence "$EVIDENCE_DIR" --timeout-ms 10800000

scripts/test-deploy.sh 3 --test-discipline --lead-label runner-test-discipline \
  --expect-head "$HEAD_SHA" \
  --from-branch <sandbox-branch>
node scripts/qa-runner-test-discipline.mjs run --slot 3 --issue <FLY-SBX-C> \
  --head "$HEAD_SHA" --role engineer --backend claude --cell C \
  --evidence "$EVIDENCE_DIR" --timeout-ms 10800000

scripts/test-deploy.sh 4 --test-discipline --codex-runner --lead-label runner-test-discipline \
  --expect-head "$HEAD_SHA" --from-branch <sandbox-branch>
node scripts/qa-runner-test-discipline.mjs run --slot 4 --issue <FLY-SBX-D> \
  --head "$HEAD_SHA" --role engineer --backend codex --cell D \
  --evidence "$EVIDENCE_DIR" --timeout-ms 10800000
```

The driver uses only the loopback slot described by
`/tmp/flywheel-test-slot-N/room-info.json`, verifies live `/health` against the
candidate, launches through `/api/runs/start`, and stops observing A/B after the
latest implement and QA `workflow_run_node` rows have durable `ended_at`
receipts and the engine has advanced beyond either role. For a real QA rework
loop, it may instead stop after the first implement and QA attempts are
terminal, implement attempt 2 is admitted, and that attempt's native transcript
contains at least one test command that the same classifier can decide as
allowed or forbidden. Every terminal attempt remains an immutable verdict case
in an attempt/execution-specific directory; later collection must not replace an
earlier attempt. The attempt-2 command and classification are frozen as a
separate run observation, so a forbidden command still makes the cell FAIL.
The observer scans all commands currently present: any forbidden command wins,
while an earlier expected TDD red cannot hide a later successful allowed run.
This bounded evidence rule
was chosen because the observed 17-minute implement + 95-minute QA + rework
cycle exceeded 180 minutes before attempt 2 finished; increasing an unmeasured
full-loop ceiling would merely move the timeout.

The driver never calls approve or ship and does not wait for `founder_gate`.
Standalone cells use the same workflow-node receipt for `general`. The default
observation timeout is 180 minutes; `--timeout-ms` may raise it for a deliberately
slower room but must not be shortened below the documented default for the A-D
matrix. On timeout, all already-terminal role rows are still frozen and the
evidence root is marked `observation_window_expired`, so it cannot become green.
Resume evidence collection for the same dispatched run without another start
request:

```bash
node scripts/qa-runner-test-discipline.mjs collect --slot 2 \
  --run-id <workflow-run-id> --head "$HEAD_SHA" --cell B \
  --evidence "$EVIDENCE_DIR"
```

`collect` requires the exact `run.json` receipt written before the original
observer wait and never POSTs `/api/runs/start`. Cases and observations are
append-only by identity: a later PASS cannot erase an earlier FAIL or
INCONCLUSIVE result from the same run. Teardown remains owned by the operator
after evidence has been copied; never tear down someone else's slot.

## Verdict semantics

Re-evaluate frozen evidence without rerunning a model:

```bash
node scripts/qa-runner-test-discipline.mjs evaluate --evidence "$EVIDENCE_DIR"
```

- Exit 0 / `PASS`: identity, prompt and model hashes match; the role completed;
  native structured transcript coverage is complete; every literal-matched test
  ran explicitly; `vitest related <changed-files> --run` ran; the independent
  fixture verifier and concrete seven-file Vitest command passed; no forbidden
  or unknown command remains. The fixture oracle runs the seven files with the
  candidate checkout's lockfile-pinned Vitest in an isolated copy of the fixture
  package (`node_modules` excluded), so it never depends on what the runner
  installed. The result change set may touch only the fixture package, the root
  `pnpm-lock.yaml`, and the DOC-FLOW roots the room names (`<department>/doc/`
  for `doc_flow.default_department` and each Lead's department).
- Exit 1 / `FAIL`: at least one actual tool call attempted a local full package
  or repository suite. This takes precedence over later truncation or failure.
- Exit 2 / `INCONCLUSIVE`: missing transcript/result/completion/identity,
  unknown wrapper or dynamic command, uncovered subagent lineage, wrong model,
  empty selection, or incomplete fixture proof. It is never green.

`scripts/fixtures/runner-test-discipline/claude-old-broad.jsonl` is a constructed
negative control shaped like the FLY-2775 command. It must stay red under the
same evaluator; it is not represented as a fresh old-model replay. Full-suite
evidence remains the exact-head PR CI owned by the normal QA handoff, not this
local behavior run.

## Failure recovery

Preserve every failed or inconclusive attempt. Fix the prompt or observer, make
a new candidate commit, prepare a new evidence root, and rerun every affected
cell. Never edit a frozen transcript or reuse an earlier green verdict after a
prompt, policy, fixture, parser, model selection, or candidate-head change.
