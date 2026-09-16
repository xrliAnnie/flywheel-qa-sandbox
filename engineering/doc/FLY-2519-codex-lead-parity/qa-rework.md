# FLY-2519 Codex Lead 能力对等 — QA 返工
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-都要有founder-2026-09)
日期: 2026-09-14
基于: plan.md, design-correction.md

## Authority and starting point

- TURN: implement epoch 9; execution `ff25fa7d-3047-4fe1-b6e3-93cbbde2be06`.
- Lead instruction `1a7c1f91-1b3d-4576-a77e-f7019b4614a9`: bounded A–D rework after QA FAIL 1153 at `6ddab1ae8`; PR #1191. Design remains approved.
- No production activation, Lead restart, host test-slot, QA dispatch, or ship.

## B — signature launch budget and duplicate work

The verifier used the ordinary 15-second command budget for deep codesign verification, and BrowserWorker.start called the entire verifier twice. QA measured signature validation at 8–35 seconds.

Regression first: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/lead-capabilities/__tests__/browser-host-identity.test.ts src/lead-capabilities/__tests__/browser-worker.test.ts` failed with exactly two assertions: timeout 15000 < 60000 and verifier called twice instead of once (7 other tests passed).

Fix: deep signature verification receives 60000 ms; other commands retain 15000 ms. Keep the pre-isolation identity check and remove the second full verification. Activation checks before and after isolation remain.

Verification: same command passed 9/9; `pnpm --filter flywheel-teamlead typecheck` exited 0; Biome check of the four changed files passed after formatting. These are local checks, not host or aggregate acceptance.

## Remaining A, C, D

- A: obtain precise host file/sysctl denial evidence and add real-exec Node startup regression against the actual generated policy. Do not treat nested Seatbelt failure as a policy pass or broadly allow filesystem reads without confinement evidence.
- Real-exec regression added: after building, run `node --test scripts/__tests__/qa-fly-2519-browser-node.test.mjs` on the macOS QA host. It uses the actual sandbox builder, pinned Node path, native process execution, crypto and CPU/memory queries. Local execution failed as expected for this runner environment: sandbox-exec exit 71, `nested_sandbox_unavailable`; 0 passed, 1 failed, 0 skipped. This is environment evidence, not a reproduction of QA's host SIGABRT or green verification. Linux CI cannot exercise macOS Seatbelt; this host regression must accompany the host canary receipt.
- C: host QA must run `node scripts/qa-fly-2519-browser-canary.mjs` and obtain exit 0 after rework. This runner cannot supply that host proof.
- D: deliver isolated real Discord 529 N-to-N drill. Existing `qa-529-generalized-e2e.mjs` and `qa-fly-529-roundtable-smoke.sh` depend on host test-slots; neither satisfies the new boundary. Existing parity fixture mocks Discord and does not prove real N-to-N.
- Pending Lead question `7eddea27-1ceb-4584-ae66-0cfc83a922fa` asks for precise host A evidence and isolated D configuration/targets. Continue independent work while it is pending.
- After A–D implementation: required verification, fresh effective code review, milestone last commit, push and exact-head CI, structured report and `complete --route needs_review --pr 1191`. Full completion remains unproven.

## A — original host evidence recovered

Read-only inspection found `/tmp/fw2519q/qa-summary.txt`, `probe-seatbelt.mjs`, and saved policies. QA reproduced SIGABRT within 6–7 ms on the exact failed head three times. Adding only unrestricted file reads produced an Abseil allocation error; adding only unrestricted sysctl reads still aborted. Both unrestricted rules booted Node. This establishes two insufficient allowlists, but does not identify the minimum safe paths/sysctls. Unrestricted file reads would invalidate the synthetic-credential isolation probe and cannot be silently adopted as a secure browser fix.

`node scripts/qa-fly-2519-browser-node-diagnose.mjs` now provides a bounded host experiment: baseline and metadata/device/dyld read candidates, each with baseline or expanded sysctl reads. Each run executes only fixed Node startup/crypto/CPU/memory code in a fresh private directory. It never changes deployment policy, reads existing credentials, starts Chrome/Leads, or uses test-slots. Results are diagnostic only; a passing candidate still needs narrowing and the complete file/network isolation and Chrome canaries. Local execution stops at baseline with `nested_sandbox_unavailable`, exit 1; no host result is claimed. Biome check passed.

D audit additionally confirmed that the standard QA role defines N-to-N as at least two real Leads, not merely two REST token senders. A new script must not relabel the mocked parity fixture or a synthetic two-bot conversation as that acceptance. The scoped replacement for the prohibited host test-slot still requires the pending Lead answer.

## Superseding A/D ruling and D delivery

Question `7eddea27-1ceb-4584-ae66-0cfc83a922fa` was answered: A requests `(allow file-read*)` plus `(allow sysctl-read)` and permits a host-only/nested-sandbox skip with an explicit reason. D explicitly changes this implementation deliverable to an isolated Bridge with fixture Discord transport and synthetic identities; real Discord remains QA-owned. This supersedes the preceding D topology uncertainty, but does not turn fixtures into real Discord acceptance.

A has a concrete implementation conflict: global file-read permission makes `verifyBrowserIsolation`'s `readDenied` and `symlinkDenied` false, and that verifier is mandatory in provider startup. Thus the specified global delta cannot satisfy C while preserving the current probe. Question gate `e3d41f41-385d-4435-b4f2-72e129b0061e` asks Lead to resolve the confinement design explicitly; the synthetic-secret assertions remain unchanged.

The Node regression now records an explicit host-only skip on non-macOS or nested sandbox rejection, as permitted by the ruling. Local run: 0 passed, 0 failed, 1 skipped with `nested_sandbox_unavailable`; this is not a host pass. The main browser canary continues to fail closed in a nested sandbox.

Delivered `scripts/qa-fly-2519-529-drill.mjs` (README block in file). Based on the generalized driver's bounded request/readback/receipt/cleanup sequence and shared `waitFor`, it mounts the real Bridge outbound handler on loopback, uses two synthetic Codex outbound clients with isolated SQLite outboxes/dedup, real Discord send formatting and an in-memory provider. It checks A-to-B reply association, Bridge request replay with only two provider writes, and foreign project/Lead/channel rejection with zero additional writes. Registry, API token and bot identities are generated locally; no existing registry, credential file, production channel or host test-slot is read. It cleans up the listener and all temporary databases. It explicitly does not prove generalized workflow dispatch, v2 broker/carrier authorization, model-driven Leads, browser or real Discord.

Test-first evidence: `node --test scripts/__tests__/qa-fly-2519-529-drill.test.mjs` initially failed because the requested script was absent; after implementation it passed. The test runs the drill twice with a minimal environment and checks distinct run IDs, both participants, replay/scoping receipts and cleanup. Biome check passed. Existing dist was used for these stable outbound components; exact-head rebuild and final gates remain pending.

## A — approved deny-list correction implemented

Lead answered `e3d41f41-385d-4435-b4f2-72e129b0061e` after running the diagnostic at `d234d2536` on the host: all 12 candidates aborted, 66–107 ms. Explicit design approval permits broad file/sysctl reads with fixed credential roots and aliases denied, preserving synthetic-secret and symlink assertions. Plan §13 records this change and its residual scope.

The sandbox now denies fixed Codex/Flywheel/Claude/gbrain/config/SSH/keychain/Chrome profile roots, the existing parent-derived credential aliases and their resolved targets, the project root and a fixed synthetic-probe sibling. A private-root exception covers only the disposable profile subtree. The verifier creates its synthetic credential in that denied sibling, outside the worker's writable tree; direct and symlink denial assertions are unchanged. The actual host regression additionally checks both reads against the final policy.

TDD: new policy assertions failed against the old read allowlist (1 failed, 6 passed). After the correction, focused sandbox/isolation/worker/identity suites passed 20/20, including resolved credential alias and profile exception checks. Full lint exited 0 with 18 existing warnings. Full build is running; host Node/Chrome acceptance and exact-head CI are still pending.

The full `pnpm -r build` subsequently exited 0. Rebuilt Node script checks: isolated 529 fixture passed (two fresh runs); host regression skipped explicitly for nested sandbox (0 host passes). Both script tests are now wired into CI's root Node contract suite; Linux skips only the macOS host regression with a reason. Full actionlint reports 8 ShellCheck diagnostics in unchanged existing steps (SC2015/SC2086), not the added Node command. Aggregate `pnpm test:packages:run` is running with log `/tmp/fly2519-rework-packages.log`; its result must be recorded separately from focused green evidence. Final review/CI and host acceptance remain unproven.

## Local aggregate stopped by host-capacity instruction

Lead instruction `40927957-eedd-4967-a05d-58fb162e19f0` explicitly ordered local full aggregates stopped because four bodies were running them concurrently; focused checks and exact-head CI are the handoff authority. Sent interrupt to the owned exec session 54728; it returned terminal and `lsof /tmp/fly2519-rework-packages.log` showed no remaining open writer. The receipt `flywheel-package-gate-BMeCWM/summary.json` has a successful prebuild but no completed package summary. Classification: **interrupted — not relied on**. No local aggregate restart. Focused and CI results remain separate. The required ledger/document update changes the final head, so fresh exact-head review/CI will follow the new milestone commit.

## Effective review round 2 (2026-09-15 UTC)

Final documentation head `988e7b1549b31721b6803b1820cd36e27535197d` passed exact-head CI run `34910095446`. Bridge recovered after the registration timeout and delivered request `4164d475-68c7-4ba2-ae44-45da8ab87747`, question `631d6b53-16f0-4d4e-8a21-f7bb009c7e14`, effective **CHANGES_REQUESTED** on that exact head. The three HIGH findings are `github-pr-list-link-header-rejected`, `v2-terminal-status-last-line-only`, and `discord-router-unsettled-request-wedge`; all MEDIUM/LOW items remain non-blocking advisories.

Commit `03fac84ac` fixes the first two. The numeric GitHub repository Link path produced the expected `github_pagination_incomplete` red (1 failed/44 passed), then 45/45 passed with origin/page validation and fixed-repository dispatch retained. The multiline terminal menu produced the expected executing-versus-waiting red (1 failed/8 passed), then the session/observation suites passed 12/12. Menu-tail stripping preserves the old-scrollback denial and session identity guards.

Discord capacity regression is in progress. Initial combined sweep and isolated sequential sweep hit the existing 30-second test timeout; an 8-request batch variant hit ECONNRESET. These runs are failures, not causal reproduction or green evidence. The capacity scenario now uses the actual Express router in-process to remove local TCP scheduling while retaining real SQLite, registry checks and typed handlers; existing HTTP coverage remains. No local full aggregate has been restarted. Proposed existing-Bridge-receipt reuse is tracked by Lead question `0bdb68d2-b532-4143-a445-40275a103252` (pending).

Lead answer `0bdb68d2-b532-4143-a445-40275a103252` approved existing Bridge-owned operationReceipts for generic Discord write dispatch tombstones, releasing completed/unknown memory entries, durable replay without redispatch, existing read-only reconcile only, and fail-closed missing store. No schema or new StateStore reader, no TTL re-execution. Lead requested immediate WIP commit before fleet restart for a Bridge fd incident and no push while review runs.

WIP source implements that approved receipt flow. In-process baseline reached rejected-versus-unknown assertion failure; first post-fix full route suite had original routing timeout and subsequent initial-auth 403 (5 passed, 2 failed). Isolated post-fix capacity test is running (`/tmp/fly2519-review-discord-green2.log`, owned session 33700); full build is running (`/tmp/fly2519-review-build.log`, owned session 82541). Full lint found one new formatting error; it was corrected, lint rerun remains due. All are pending/failed evidence, not green. The parameterized test's indentation causes a large formatting-only diff; reduce it via an extracted fixture function after the running test ends. Current source/ledger is committed as WIP solely for restart safety, not delivery acceptance.

Post-WIP verification: isolated capacity run `green2` also ended in the unchanged 30-second timeout (test wall time 118.83s under load; no green claim). Bridge reported load1≈67.67 during its fd incident. No further repeated local capacity runs were started. Full `pnpm lint` rerun passed with the same 18 warnings; the subsequently changed test file also passed focused Biome check. The fixture was extracted to eliminate indentation-only churn, and success-receipt replay after router recreation now has explicit assertions. Full build remains in progress. Old registered question `60ad457b-963b-4161-b935-cec02fd75b9d` still returns `not yet` despite round2's completed CHANGES verdict; Lead clarification `356d3fcf-22b0-4f41-900c-577f76433bd2` asks whether it is superseded before any push. Branch remains unpushed.

## Review-rework verification checkpoint (2026-09-15 UTC)

Full `pnpm -r build` completed with exit 0 (including teamlead and voice-codex). Full lint rerun completed with exit 0 and 18 existing warnings; focused Biome check passed after the final test-only changes. Rebuilt `node --test scripts/__tests__/qa-fly-2519-529-drill.test.mjs scripts/__tests__/qa-fly-2519-browser-node.test.mjs` completed with exit 0: one fixture test passed (two fresh drill executions), one explicit nested-sandbox host test skipped, zero failed. This is not host acceptance.

The new Discord regression has no local green receipt: isolated capacity run timed out, and the full route run recorded routing timeout plus initial-auth 403. These failures remain explicit. The former head `988e7b154` had all CI green, but that does not certify the new GitHub/terminal/Discord source corrections. Final-head CI and a fresh effective code review remain mandatory; no aggregate restart. Old-review supersession question `356d3fcf-22b0-4f41-900c-577f76433bd2` remains pending and no push has occurred since the rework started.

## Effective review round 3 and bounded corrections (2026-09-15 UTC)

Replacement execution `9c482989-3044-4672-9110-1ccdd6b92c65` acquired implement TURN epoch 10. Lead instruction `1683ed6a-dfba-4703-832d-167df562a64d` required using the already registered review and CI, fixing only blockers if CHANGES_REQUESTED. Request `0cc872a6-c795-44b7-a707-f30d81e525bf`, question `2325dd1c-fedf-4e32-8dc2-9cde21b20d25` returned effective CHANGES_REQUESTED for `c2de88abb81e7672f84ca3dd16cf947aa8e0985b`. Exact-head run `34914462447` completed with failure. Neither is a pending gate or a green receipt.

The two HIGH findings are `discord-receipt-rework-breaks-bridge-discord-suite` and `v2-terminal-status-last-line-only`. No advisory changes were included.

- Discord: the automatic output operations are deliberately outside the generic catalog. The catch path now uses optional classification access, preserving the intended rejection instead of throwing a TypeError. The actual-router broker fixture supplies the existing Bridge operation receipt store, matching production wiring. Unchanged sibling suite reproduced 12 failures/25 passes before the fix, including three unexpected HTTP 500 denials. After correction, both Discord suites passed 44/44, including the 65-request capacity and router-recreation cases. Command: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/lead-capabilities/__tests__/bridge-discord.test.ts src/bridge/__tests__/lead-capability-discord.test.ts`. Logs: `/tmp/fly2519-r3-discord-red.log` and `/tmp/fly2519-r3-discord-green.log`. Earlier load-related failures remain historical failures; this is a fresh focused green receipt.
- Terminal: the prior parser stopped at footer text, wrapped options or the boxed description. The replacement validates a contiguous trailing menu: known key-hint segments, numbered options, indented continuations, boxed descriptions and borders. It preserves the bounded tail, existing waiting patterns, legacy behavior and exact-session guards. Regression fixtures include the repository's verbatim boxed title and the real `Enter to confirm · Esc to cancel` footer. New fixtures produced four expected waiting-versus-executing failures (12 passed); after the fix, session and observation suites passed 19/19. Every valid menu also rejects appended execution output; additional cases reject intervening output and non-hint footer text. Command: `VITEST_MAX_FORKS=1 pnpm --filter flywheel-comm exec vitest run src/__tests__/terminal-session-core.test.ts src/__tests__/terminal-observation.test.ts`. Logs: `/tmp/fly2519-r3-terminal-red.log` and `/tmp/fly2519-r3-terminal-green.log`.

Full lint completed exit 0 with 18 existing warnings (`/tmp/fly2519-r3-lint.log`). Full build completed exit 0 (`/tmp/fly2519-r3-build.log`). No local aggregate restart. Fresh final-head review and CI remain mandatory. Host QA and complete Honey Lemon acceptance remain unverified; no production or successor action occurred.

Rebuilt script verification completed exit 0: `node --test scripts/__tests__/qa-fly-2519-529-drill.test.mjs scripts/__tests__/qa-fly-2519-browser-node.test.mjs` reports 1 passed (two fresh fixture executions), 1 explicitly skipped for `nested_sandbox_unavailable`, 0 failures. Log: `/tmp/fly2519-r3-scripts.log`. This remains zero host-browser passes. The source correction commit is `84ae2c83f`; final documentation and milestone commit follow before the single push and fresh review registration.


## QA verdict 1158: native browser startup (2026-09-15 UTC)

The preceding candidate `c695ab53df436ea5bec7145a2df9a321f3303945` passed effective review (question `676cc4e4-fb8b-4c06-8df4-132105be3983`) and exact-head CI `34917491131` (15/15), then completed needs_review. QA nevertheless failed browser acceptance. Its host evidence under `/tmp/fw2519r` reproduced MCP initialize SIGTRAP with `BUG IN LIBDISPATCH: Unable to get the unique pid (error)`, then Chrome's x86_64/Rosetta runtime mapping failure after process-info was admitted. These are host failures, independent of source tests/CI green. QA's isolated real Discord exercise passed; no Discord implementation change is included here.

Lead instruction `7746e808-8296-42b7-86d4-9ea980788266`, confirmed by answer `266013f1-f358-4069-9316-24b016a9cc23`, authorizes exactly this QA-driven rework under implement TURN epoch 12:

- Preserve explicit process-info denial and add `(allow process-info* (target self))`, matching the self-introspection rule in Apple's shipped `/usr/share/sandbox/com.apple.bootinstalld.sb`. This permits os_log's own PID lookup while other process targets remain denied. Actual host compatibility remains to be tested.
- Select Chrome arm64 with a disposable `chrome-arm64` symlink to `/usr/bin/arch` and a fixed `ARCHPREFERENCE=chrome-arm64:<pinned Chrome executable>:arm64`. The parent creates the alias exclusively and validates it on repeated builds; foreign files/links are rejected without replacement. The exact system arch executable is admitted for execution/mapping. No shell or `/Library/Apple` mapping is added. Chrome identity verification continues to target the real pinned app. A real local arch alias executing pinned Node returned arm64; this is architecture-selector evidence only, not Chrome/Seatbelt proof.
- Add fixed read denials for `~/.zshrc`, `~/.npmrc`, `~/.gitconfig`, `~/.docker/config.json`, and `~/Library/Application Support/discord/Local Storage`, retaining existing resolved-alias handling and every other deny. The 60-second deep codesign budget remains unchanged.
- Extend the registered host regression to execute the production BrowserWorker under the final policy: synthetic direct/symlink credential denials, real isolation probes, pinned MCP initialize and tools/list digest verification, then actual Chrome list_pages. It closes worker/proxy and removes its disposable files. No mocked child_process, alternative policy or unsandboxed fallback. Non-macOS/nested Seatbelt explicitly skip before claiming any host success.

Policy regressions first failed as expected (3 failed, 6 passed; `/tmp/fly2519-qa1158-policy-red.log`), then six focused suites passed 29/29 (`/tmp/fly2519-qa1158-browser-green.log`). Full lint passed with 18 existing warnings after correcting two formatting diagnostics; full monorepo build passed. Rebuilt root scripts passed the isolated fixture and explicitly skipped the host regression for nested_sandbox_unavailable (1 pass, 1 skip, 0 failures; `/tmp/fly2519-qa1158-scripts.log`). The skipped regression is zero host-browser passes. The full package aggregate remains unrun under the Lead capacity restriction.

QA must run `node --test scripts/__tests__/qa-fly-2519-browser-node.test.mjs` and `node scripts/qa-fly-2519-browser-canary.mjs` on the unsandboxed macOS host. The latter still requires exit 0; this implementation environment cannot supply it. One final milestone-only commit, one push, one fresh effective review and exact-head CI remain mandatory before needs_review PR1191. No production v2 activation, Lead restart, QA dispatch, merge or deployment.

Final browser-related sweep: 13 suites, 97/97 passed (`VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/lead-capabilities/__tests__/browser`; `/tmp/fly2519-qa1158-browser-all.log`). This includes actual installed upstream MCP/schema checks but excludes host Seatbelt/Chrome acceptance.


## QA claim 1161: argv-based Chrome launch (2026-09-15 UTC)

QA attempt 2 failed at `e585338878de2e4e7a34b1615a86afb557dc913d` despite effective review APPROVED and exact-head CI 15/15. Host QA proved the preceding corrections: self process-info permits MCP initialization, all seven isolation probes pass, tools/list has 29 upstream tools and the expected digest, and all fixed credential denials pass. Chrome list_pages still fails with Target closed. The new host regression correctly exposes the same failure. QA again passed its isolated real-Discord exercise; there is no Discord delta in this round.

Lead instruction `a5a27b26-1f82-4023-8eca-9afaf6579db6` and explicit reconciliation gate `3cd8995a-d906-4dcd-b6b0-70434ba94deb` authorize the fixed sh exec wrapper. The later gate resolves the initially conflicting no-shell reply: shell is expressly permitted for this wrapper, with only literal execute/map additions for /bin/sh, /usr/bin/arch and the wrapper. No broader executable subtree or WindowServer permission is authorized.

The launcher now creates a regular file in the disposable qaRoot with mode 0500 and fixed content: shebang /bin/sh, then exec /usr/bin/arch -arch arm64, the shell-quoted pinned Chrome path, and the original argv. The spec includes its SHA256 digest. Exclusive creation followed by O_NOFOLLOW descriptor validation rejects symlinks, hardlinks, wrong owner/mode/size/content without overwriting them. Repeated construction validates the same wrapper. ARCHPREFERENCE is removed from both the washed environment and transport allowlist; its colon/semicolon/comma path restriction is removed. Existing absolute-path/control-character/source-boundary checks remain.

The real launcher regression covers an .app path containing dots, spaces, quotes and shell metacharacters, literal argv forwarding, and inherited descriptor 3 (the same mechanism used by Puppeteer CDP descriptors 3/4). A separate actual invocation targets `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --version`; this does not open a browser or prove final Seatbelt compatibility. Host MCP initialize/tools/list/Chrome list_pages regression remains unchanged and mandatory.

Diagnostic evidence distinguishes observations from hypotheses: QA's ARCHPREFERENCE parser failure was not reproduced in this implementation environment (the exact pinned Chrome --version and dotted echo probes exited 0). The approved argv migration still removes that parser dependency. A real pinned-Node process.execve experiment lost fd3 (cat: Bad file descriptor), so that alternative was rejected instead of silently breaking CDP. The reconciled sh exec choice preserves fd3 in actual execution. No claim is made that these launcher probes settle the GUI registration failure; if final-policy WindowServer registration fails on the QA host, Lead requires crash evidence before any policy change.

Tests first: the new expectations produced 3 failures/7 passes (`/tmp/fly2519-qa1161-red.log`). The first updated source run had 9 passes/1 fixture failure; the fixture was corrected to retain the required app/helper layout and use a synthetic executable script rather than a relocated platform binary. Actual wrapper tests then passed 10/10, including literal argv and fd3 (`/tmp/fly2519-qa1161-green.log`). Full verification follows below. No host full package suite was started.

Final local verification:13 browser suites99/99 passed; full lint/build exit0 (18 existing lint warnings); rebuilt root scripts1 pass1 explicit nested-sandbox skip0 failures. See implementation-verification.md for the open parser-observation note and host acceptance boundary.


### Direct bash correction authorized before QA (2026-09-15 UTC)

Head5fc5f4c7a received effective APPROVED (request73a8fdce-7838-4b97-b0d9-dc80a4ee8bb5, question53a70e9b-32b3-439a-a99a-5245592719ab). Its new MEDIUM finding browser-launcher-sh-variant-exec-denied contained actual host evidence: /bin/sh is a macOS variant shim which attempts to execute /bin/bash, denied by the exact final policy. Unsandboxed --version success therefore did not prove policy compatibility. The reviewer verified that allowing exact /bin/bash process-exec fixes the launch and that a missing final-target permission still rejects the chain. This review approval does not erase the host failure.

Lead answer6081ee75-ccbe-4797-a7af-bcce75679e85 explicitly treats this as a host-functionality blocker regardless of severity and authorizes a focused correction before QA: use #!/bin/bash directly, allow its exact executable path, remove /bin/sh entirely, retain0500/digest/final-target guards, and leave the other13 advisories untouched. The correction changes only that interpreter choice and its literal exec/map entries.

The registered host regression now also runs the generated Chrome wrapper --version inside the exact final Seatbelt policy, after the Node/credential probes and before the existing real MCP/tools-list/list_pages checks. It retains explicit non-macOS/nested skips and no alternate-policy fallback. Focused regression first produced2 expected failures/9 passes (/tmp/fly2519-bash-red.log), then all11 sandbox/launcher tests passed; fresh full verification follows. No WindowServer or other policy widening.

Direct-bash final local verification:13 browser suites99/99 passed; full lint exit0 (18 existing warnings), full build exit0; rebuilt registered root scripts1 fixture pass1 nested-sandbox skip0 failures. Logs:/tmp/fly2519-bash-{browser,lint,build,scripts}.log. Exact-final-policy Chrome version/MCP/list_pages remain unexecuted here after the nested guard, so fresh review/CI and unsandboxed QA remain required.

## Attempt 6 review: v2 launcher and restart blockers (2026-09-15)

Effective review dedc8147-75eb-4eb3-b0b1-093290dc734e, request fce3ac43-032d-4530-ab1c-779cb68c0173, rejected head97e69ff91 with two HIGH findings. Full structured receipt: review-code-attempt6-r1.json. Remaining MEDIUM/LOW findings are advisories, outside this bounded repair.

- v2-bundle-cannot-boot-sandbox-override: the generic launcher supplies workspace-write while canonical identity selects bundle2; the parser correctly refuses the combination. Canonical v2 projection now removes the legacy sandbox variable before either runtime starts. V1 projection and direct parser rejection remain intact. Canonical shell regression failed11/12 before the change and passed12/12 after; direct parser negative checks passed7/7.
- capability-home-rejects-every-restart: stable CODEX_HOME retains a managed profile whose activation and artifact paths expire on each parent shutdown. Previous socket validation now recognizes a factory-named sibling activation, and old artifact validation recognizes exactly one factory-named directory in the same project. The full previous config must still equal the generated profile with only the old socket/artifact/proxy substituted; arbitrary policy/MCP additions are rejected. Current activation ownership, socket placement, file ownership/mode/symlink guards, current-authority checks and atomic replacement remain unchanged. Three separate rotation regressions failed (activation, artifacts, both) before the fix, with six existing checks passing; home/profile checks now pass20/20, including old-root deletion and malicious prior config refusal.
- Launcher integration first run retained70 passed1 failed: the newly enabled v2 fixture lacked the deployment verifier. The isolated fixture now includes that dependency; this tests the real launcher/canonical/child environment boundary, not deployment integrity or production activation.

No browser permission changes: browser capability remains fail-closed, follow-up FLY-2587. No local aggregate rerun; prior aggregate interruption/RED remains not relied on. The old-head CI's registry E404 and Lead-authorized single rerun remain historical; the upcoming repaired head requires its own review and CI.

Final repair verification: launcher integration71/71 exit0; canonical identity12/12 exit0; home/profile20/20; direct runtime guards7/7 (136 unrelated tests unrun); pnpm lint exit0 (20 warnings) and pnpm -r build exit0. No full local aggregate run. Old-head97e69ff91 CI34995624367 attempt2 completed SUCCESS after the single authorized registry-recovery retry; its review remained CHANGES_REQUESTED and does not certify these fixes.

## Main runbook integration after76c437a1d (2026-09-15)

CI34999144534 tested synthetic merge6529cab (76c437a1d into mainb9418b780). Main7f6e88d39 moves the patrol procedure and completion gates into lead-rules-base/runbooks/patrol-v1.md; old source extraction failed closed. Lead ruling94a00206 authorizes only pointing extraction/pins at the relocated same-contract runbook. Main merged locally in f0517b39c without manual conflicts.

Five path changes: Bridge source pin and four test callers now select the new runbook. No extraction, gate program, permission, schema2 validation or return behavior changed. Red: three patrol files6/6 failed. Green: same6/6 pass; actual Bridge read/router and SQLite receipt registration21/21 pass. Full build, lint and CI structure shell contract exit0. No local package aggregate.

The completed old CI also records upstream archive assertions0!=1, serial observation357.028ms>=50ms (dedicated perf job passed), auto-narrow negative/source assertions, real-tmux routing, and FLY-2567 compatibility hash drift for merged CommDB. Under94a00206 archive belongs to upstream2557 and performance must be preserved without retry or relaxation. Question96260760 requests permission for a bounded CommDB compatibility hash/rationale audit; not yet acted on. Await effective review6888c9ca on76c437a1d before the single new push/review requested by Lead. Browser remains fail-closed, FLY-2587.

Lead96260760 authorized the compatibility entry refresh after an exact diff audit: db.ts adds only resolvePatrolSessionOwner and listLeadTerminalSessions, both parameterized read-only session queries. The earlier operation-receipts-migration suspicion was incorrect and corrected in structured report4dd0cc7b. Bootstrap/event/delivery code is unchanged relative to mainb9418b780. Updated only the db.ts hash and its enclosing factual compatibility rationale, retaining the guard and negative mutations. Before5 failed12 passed; after17/17 passed. JSON Biome check passes. FLY-2557 may require a later merge-time re-audit of this same entry; do not blindly take either side. No push until6888c9ca settles.


## 2026-09-15 attempt 6 review round 4: specialized launcher ordering

Effective review6888c9ca / request935ec889-feb1-40e9-b444-18515fed6785 returned CHANGES_REQUESTED on2e76f7ecd. Its full receipt is review-code-attempt6-r4.json. The valid HIGH v2-bundle-cannot-boot-sandbox-override remained reachable in five specialized launchers, which exported legacy sandbox after canonical identity. Each now applies its unchanged legacy default before the one canonical resolver invocation; canonical v2 clears it before the runtime child. No parser relaxation, repeated identity resolution or permission expansion.

The new isolated launcher matrix executes all five actual scripts with fixture identity, an empty environment/disposable home and a capture-only child. Before: five v1 PASS and five v2 FAIL (workspace-write/read-only leaked to runtime); after: all10 PASS, canonical shell suite13/13. This is launch-environment proof, not real provider startup or production activation. Existing Infra Bot suite19/19. Two older Mufasa fixtures lacked the now-required codexCapabilities.runnerActionsEnabled boolean: original receipts2/6 and1/11 retained; fixture-only schema correction yields23/23 each, preserving all legacy assertions.

Provider HIGH upstream-provider-startup-has-no-fallback is governed by Lead85d79381-9ebf-4f77-8e25-f576beae75c4: keep activation fail-closed, retain all pins and add no provider fallback. Supervised review-ruling52a168f8-b902-4547-8d63-c097fb78eef9 overrules that finding (source request935ec889, finding index1). Future gbrain removal belongs to FLY-2588/PR1211, still OPEN when checked; no preemptive integration. Twenty-eight MEDIUM/LOW advisories stay outside this bounded rework. A NEW effective review is still mandatory; this governance note is not an approval.

Browser capability remains fail-closed, follow-up FLY-2587. Prior aggregate RED/no-rerun direction remains. No production operations, QA dispatch or ship.

Post-correction validation: pnpm lint exit0 (21 warnings), pnpm -r build exit0, ci-structure shell contract PASS. Final push/review/CI have not run yet.

### Main451812138 integration before the bundled push

Merge58f3c43ca integrates FLY-2447/PR1206. Three manual conflict resolutions retain both sides: outbox reply_to/delivery_context plus roundtable_engage/engagement/project_name columns and all identity checks; outbound dedup operation-receipt initialization plus engagement migrations under the same close-on-throw boundary; both receipt-failure and engagement persistence test groups. Focused sender/dedup/handler58/58 pass. Initial full build/lint fail because the automatic handler merge duplicated the createHash import; a single duplicate import is removed without changing runtime logic. No aggregate rerun.

### Runtime-pair compatibility audit and final local verification

Leadb5ef65f9-e587-4b84-8edd-6d46c6dbfbd4 authorized the mailbox runtime entry; Lead61b45fee-cc5b-412f-bdbe-174523889137 extended this to the commdb runtime entry after a complete member-hash audit. Upstream451812138 adds the same formatBusinessWake import and business_wake branch in both files; both match origin/main and their Bootstrap selector/render/ACK paths are unchanged. Only these two member hashes and their shared factual rationale change; all guards/negative assertions remain. Drift sequence:2 failed15 passed, then1 failed16 passed after mailbox-only update, then17/17 after the authorized pair update. Future FLY-2557/main entry takes precedence after a fresh sync.

After main conflict integration and duplicate-import removal, full build and lint exit0 (21 warnings); CI structure passes. Generic launcher71/71, outbound58/58, runtime-pair drift17/17. Original duplicate-import build/lint RED and earlier fixture RED retained above. No aggregate rerun, production activation, provider mutation or dispatch.


## 2026-09-15 post-1199 conditional main sync

Head77879ce0c was effective APPROVED (gate98450a72, requesta570c356, round5), with28 nonblocking advisories reported to Lead. CI35007382759 completed FAILURE:13 jobs passed; teamlead1 and teamlead2 failed, causing CI OK to fail. Raw failures include auto-narrow negative gates/eligibility, two audit-only archive assertions and outcomes cursor544 vs725. Lead70c23910 explicitly rejects treating all these as proven main-only merely because named files have no diff: unchanged test files do not exclude branch interaction or shard order. No CI rerun or claim of upstream-only cause.

Lead51033926 pre-authorized exactly one origin/main sync after PR1199 MERGED. At18:41:42Z the query confirmed mergedAt18:37:48Z, main84a65da2e56d895adc5ddf3ac88f8a79a17d2ab8. Merge de4868154 is that single sync. Only compatibility.json conflicted: runtime pair takes main's reviewed entries per Leadb5ef65f9; bootstrap-generator rationale retains main's database/attention audit plus the approved FLY-2519 read-only lookups. Merged db.ts bytes equal the already reviewed6eaa358a hash; all manifest members independently hash-match. No production behavior was manually changed.

Exactly one targeted run after the merge: seven files158/158 (StateStore terminal archive, auto-narrow writer/eligibility, inbox runtime, epic-residual plugin wiring, outcomes cursor and compatibility drift). Full build and lint exit0 (21 warnings); CI structure passes. This local targeted result does not certify the CI-specific negative-gate matrix or shard order. If either family remains red in the new exact-head CI, Lead assigns bounded correction to FLY-2519 before QA.

The next milestone head requires one push and one fresh review registration, then freeze until review and CI. Browser fail-closed FLY-2587; no advisory work, local aggregate rerun, production activation, restart, provider writes, QA dispatch or ship.
