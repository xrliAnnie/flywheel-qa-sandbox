# FLY-2519 Codex Lead 能力对等 — 调研
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: plan.md

## 设计产物验证

- `git diff --check` 通过。
- `FLYWHEEL_HTML_TEST_PACKAGE_JSON=/Users/xiaorongli/Dev/flywheel/packages/teamlead/package.json node engineering/doc/FLY-2519-codex-lead-parity/verify-founder-html.mjs` 通过。验证每 section 评论、单 nonce script、无 CSP meta/inline event/external dependency/innerHTML、HTML escaping、pathname storage 与不可用 storage、精确 marker、Unicode 长评论分块、clipboard 成功/缺失/promise reject fallback。
- HTML 14,519 bytes，小于 512KiB。所有 issue/标题等模板内容经 HTML escape；运行时评论只走 textContent/value。
- 两张 Mermaid：本机 mmdc 11.12.0 首次与标准重试都 exit 1，失败为 `MachPortRendezvousServer ... Permission denied (1100)`。每张标准命令均为 `mmdc -i <source> -o <svg> -w 1000 -b white --svgId FLY-2519-d<N>`。未产生可交付 SVG，HTML 含两个 `DIAGRAM PENDING LOCAL RENDER`；保留两份 .mmd，未远程渲染。
- 已核对 package.json：teamlead/comm 的 `test:run`、teamlead `typecheck` 实际存在。计划中的新实现测试还未创建/运行，本节点不编写业务代码。

## 需求映射自查

| 原任务要求 | 当前设计证据 | 生产状态 |
|---|---|---|
| Claude/Codex 全能力盘点 | research.md P01–P17、文件锚点和非秘密配置观察 | 后续须补 tools/skills 实际调用证据 |
| 优先补日常能力 | plan.md §5 分操作契约、§8 C1–C5 | 未实现 |
| Codex 原生浏览器 | plan.md §6 配置/生命周期/进程隔离/工具要求 | 未在 Honey Lemon 验证 |
| founder-only/R1–R5 不变 | plan.md §2、Lead 答复、reserved deny 测试 | 本设计未改权限 |
| secret broker 内存通道 | plan.md §4，覆盖 env、credential files、CLI、profile 优先级 | 未实现/未真机证明 |
| Honey Lemon 完整 issue 验收 | plan.md §9 同 activation 证据序列与矩阵 | 未执行；设计节点禁止 live drill |
| #1162 依赖 | GitHub merged SHA 在本分支 | 本轮 Bridge health 为早期版本，未证明部署 |
| founder HTML | founder-design.html + verifier + Mermaid 源 | 待有效评审通过后 publish-only/hosted verify |

## 限制

本轮证据不证明 Codex Lead live inventory、auth 可用、浏览器隔离、secret confinement 或 production parity。macOS 本地 Mermaid 渲染失败已按任务允许的降级交付；不能在报告中声称图已渲染。设计评审与托管页验证记录将在最终交付前补齐。

## R1 后补充

- 已核对 buildCodexLeadMcpArgv.ts:36–40 的 MCP 沙箱外运行边界，以及 plugin.ts:2605 起 fleet console、runner-routes.ts 与 workflow-decision-routes.ts:943 起的 loopback/same-origin/confirmToken 管理路径。R1 HIGH 属实，方案已改为独立 OS 隔离和只读管理台入口。
- 当前设计 runner 的 chrome_devtools/list_pages 在300秒工具超时；new_page重试返回 `MCP tool call requires approval, but approval policy is never`。实际浏览器操作/截图未完成。已报告 Lead，receipt c0835b52-e6bf-41bb-b598-f30c4d73a2f6；未调用 Claude-in-Chrome。

## 评审通过与最终 HTML

- R2 effective APPROVED，见 review-history.md / review-r2.json。
- 最终 HTML 14,765 bytes，SHA256 `f3bb8ed2045668c7e1c08cf1ba0cc7568ee90b6e12f017e46545be9b608bdae2`；与 R2 reviewed head 的 HTML 字节一致。
- R2 后只留档非阻断 advisories，没有修改 HTML 或实施设计修复。

## Hosted verification

2026-09-13 发布后：`verify-report` 返回 ok=true、status=200，http/noncePlaceholder/scriptCsp/scriptNonce/expect 全 pass、warnings=[]。具体 URL、reportId 与 Lead report receipt 见 delivery.md。hasInlineSvg=false/screenshot=null 如实保留；这次验证不宣称真实浏览器行为或本地 Mermaid 渲染成功。

## 2026-09-14 重派校准

- 当前 TURN 返回 `yours phase=design epoch=4`，activation `activation:4c428168-c403-4b03-b2b9-ffa47bf68433:c176229a-5fe3-4d4d-886b-e1e7527ec9e2:eng_design:1`；未借历史 TURN 写入。
- 本分支/远端起点均为 `63a1448062e6afdf3112e5d7be2d409fcc68f985`；当前 issue/branch 无 PR，故不存在本次可核对的实现头 CI 或真机 parity 结果。
- 实时 `check c2a10f39-eec6-4ee4-8db1-895dee044167` 返回有效 APPROVED；原 URL 再次 `verify-report` 为 HTTP200、五项 pass、warnings=[]。
- 新任务注入的 QA 裁定逐项落在 `design-correction.md`：broker result-only/replay、Bridge 单写者、Discord/Linear/GitHub、180s/4GiB push、原生浏览器/cookie 边界、marker/清理/shutdown、隔离宿主真机/UDS/SQLite、精确头 CI/非 draft 与原始最终验收的证据区别。`plan.md` 明确链接附录并规定冲突优先级。
- HTML 新增可评论的验收边界卡片；全部文本经 HTML escape 插入，现有单 nonce script 未改。使用上述 `verify-founder-html.mjs` 再验证通过，`git diff --check` 通过。本轮仅文档改动，不运行或宣称业务实现测试。
- 原两张 Mermaid 源及已经完成的两次本地失败证据保留；新增卡片是文字说明，不增加流程图或伪造 SVG。本轮不宣称旧的宿主渲染错误已消失。
- 本次补充需取得当前 execution 的有效设计评审，并重新发布包含该卡片的已提交 HTML、核验托管页及向 Lead 报告；这些结果单独追加，不能复用旧 HTML 的 hash 作为新页面证明。

## Lead 接续指令与最终差距清单

- `[lead-instruction b1077734-89fe-4664-a170-c7dbe61015f7]` 要求只补默认工厂/TUI/parity/review/PR。通过 `git stash list` 按名找到 `4bd662c013b8253b7eab209deab48b990dc2d382`，第一 parent `ce0e761a9`；`git log/show/diff/ls-tree` 证明 164 文件实现差异与 3 tracked + 2 untracked WIP。当前分支尚未包含这些实现，但对象仍可恢复；未 pop/apply/drop stash，未写实现代码。
- 只读审计 `ce0e761a9` 的 runtime、catalog、handler、browser schemas、inventory/verification/review 与 stash report-publish 文件。research 并行审计也仅使用该 Git 对象；确认默认 parent 缺生产 consumer、TUI 显式拒绝 v2、技能未物化/读回、inventory 固定 unverified。每项已有/缺失与具体测试见 gap-checklist.md。
- 重派 R1 HIGH 的表述问题已修正。最终附录不提供 identity/department/claim 写权限，也不声称旧 chat-threads/send 有 UUID 幂等；基于 preserved typed Bridge/持久 outbox 的真实实现。
- 新增五项剩余卡片与纠正后的业务写说明后，既有 HTML 验证再次通过；git diff --check 通过。原生 `chrome_devtools.new_page` 返回 `MCP tool call requires approval, but approval policy is never`，本轮实际浏览器交互仍未取得，未切用 Claude-in-Chrome。
- 后续实现按 Lead 要求把台账/里程碑与最后代码提交同推，code review 后不单独推文档改变待审 head；设计交付的实时评审/发布/完成 receipt 通过 comm 保持可追溯。

## QA attempt 4 / BLOCKER C mapping rework (2026-09-15)

Authority: [lead-instruction cff51596-187a-4787-99a5-e705d4cf295d], QA host bisect against 5a76d42bd. The explicit blanket `deny file-map-executable` produced Rosetta runtime mapping failure even through the arm64 argv launcher. Remove that operation from the blanket deny; retain `deny default`, scoped executable-map grants, iokit/nvram deny, all credential read denials, writes and network policy. No `/Library/Apple` grant and no launcher change.

- TDD policy regression: 1 expected failure / 11 passes before fix; 12/12 after fix. Browser group: 13 files, 100/100 passes.
- `pnpm lint`: no errors, 18 existing warnings. `pnpm -r build`: exit 0.
- Root Node tests: 2 passed, 1 explicitly skipped for `nested_sandbox_unavailable`; no host acceptance claim. Native/headed observation parser rejects translated flags, headless mode, non-arm64 host and malformed observations; ignores foreign profiles.
- Host canary and real-exec root test now check live Chrome after successful MCP `list_pages`. Host-side `/bin/ps` binds the exact Chrome executable and disposable profile to a PID, reads hexadecimal `sys/proc.h` flags, and rejects `P_TRANSLATED` (0x00020000). It also rejects headless argv. No process-observation permission is added to the browser policy. Evidence logs contain only PID/flags/native/headed results, no command lines.
- The real headed `list_pages` plus live non-headless process check exercises the GUI startup path. Host QA must still run `node scripts/qa-fly-2519-browser-canary.mjs` and the root regression; this implementation environment cannot supply WindowServer/Seatbelt acceptance.
- Full package gate, fresh effective review and exact-head CI remain pending at this entry.

Follow-up only per the same Lead instruction: the verified launcher lives in writable qaRoot and could be replaced between construction and spawn. No attempt to fix that advisory in this rework; other existing advisories remain unchanged.

## Schema2 integration verification (2026-09-15)

After merge cea457c95, the five CI patrol failures reproduced locally: 5 failed / 20 passed, log `/tmp/fly2519-patrol-merged.log`. Header mismatch caused snapshot, registration and mounted route failures; schema2 review/finding contracts caused completion and judgment failures. The earlier branch-only runs passed 23/23 and 2/2 because they lacked #1198. No CI retries were consumed; these were merge-result contract incompatibilities.

Snapshot parser now requires the exact schema2 header. Typed judgment accepts explicit stable finding identity/category, optional explicit mechanism review, append-only declarations and canonical disposition objects. Existing declarations cannot be cleared or rebound. No missing review becomes `none`; incomplete records remain incomplete. The third completion gate also uses canonical `validatePatrolReport`, so shell-only success cannot bypass JSON disposition, Linear readback or activity evidence requirements. No #1198 source/semantics changed.

TDD: three initial mechanism cases failed on missing typed fields, then passed. A subsequent incident-with-disposition negative first failed because fields were ignored, then passed after explicit rejection. Final four-path test covers existing, created, no_issue without source and no_issue with a source comment; rejects identity rebind/none-clearing and keeps invalid reason or mismatched dedup class incomplete. Reports awaiting explicit review remain incomplete.

Validation receipts:
- Snapshot/mounted Bridge/registration: 23/23 after header correction.
- Patrol capability group: 7/7, followed by expanded mechanism cases 4/4. Stalled-pane fixture now carries schema2 activity records and full reference evidence.
- Broader capabilities + patrol Bridge: 81 files passed / 1 failed, 546 passed / 1 failed. The sole failure was a missing readFileSync test import. After adding it, the entire affected HTTP test file passed 20/20 (`/tmp/fly2519-schema2-http.log`). Do not describe that initial aggregate as green.
- Full `pnpm -r build`: exit0; initial isolated tsc before dependency rebuild had stale CodexDaemonOwnershipDeps shape, resolved by dependency rebuild. Lint: no errors, 18 existing warnings.
- Fresh package gate is still running at this entry. New exact-head review/CI and QA host Chrome native/headed proof remain required.

## Effective review HIGH corrections (2026-09-15)

Review276c21fb at7a97dc86c returned CHANGES_REQUESTED for two HIGH findings. Leadf2732ed1/db896d95 explicitly required and accepted these fixes; no advisory expansion.

`terminal-input-embedded-cr-bypasses-reserved-guard`: v2 input admitted embedded CR/LF, allowing a single authorized permission response to contain additional submissions including /exit. This was a reserved-action bypass in the parity route. Core validation now rejects CR/LF before observation/guard/send; the typed terminal.input schema rejects them too. No stripping or line splitting. Legacy contract behavior remains separate. Regression:4 expected failures before fix; final terminal24/24 and catalog8/8, including CR-/exit and CR-/quit with zero sends, LF/multiple-command negatives and the normal single-line positive.

`lead-capability-discord-tests-fail-on-head`: all provider data is fixture-owned (temporary home/registry, self-allocated Bridge port/test token, simulated Discord fetch). Original file passed7/7 locally, but reviewer repeatedly observed routing30s timeout then next-case403. Controlled300ms latency injected only before fixture localhost Discord-route fetch reproduced precisely2 failures/5 passes. The unfinished130-probe routing body could overlap the next case's global mocks/cleanup after Vitest timed out.

**Changed the harness's hardcoded scenario budget from30s to120s; production budget15s is unchanged.** All130 sequential probes, request counts, assertions and production paths remain unchanged. This allows the complete scenario and finally cleanup to finish before the next scenario begins. Same controlled latency after fix:7/7, routing55.235s, complete file63.796s. Full lint/build exit0 (18 existing lint warnings).

Evidence attached: `review-high-slow-http.mjs`, `review-high-discord-red.log`, `review-high-discord-green.log`. Replay from repository root:

```sh
NODE_OPTIONS="--import $(pwd)/engineering/doc/FLY-2519-codex-lead-parity/review-high-slow-http.mjs" VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/lead-capability-discord.test.ts
```

Previous7a97dc86c CI34930318367 completed successfully, but its effective review was CHANGES_REQUESTED. These corrections require a new milestone head and new review/CI. Package gate remains pending; no completion claim.

## Reachable legacy terminal closure (2026-09-15)

After9f9c03667 received effective APPROVED, Lead5b8825aa asked whether the legacy terminal contract was production-reachable, then explicitly authorized closing it (confirmed7e4b830d). Source chain: terminal-mcp/src/index.ts terminalCore sets legacyContract:true; registered runner_terminal_input calls terminalCore(enter).input; teamlead/scripts/claude-lead.sh installs this packaged terminal MCP for standard Claude Leads; package-onboard includes terminal-mcp. This is reachable production code, not a test-only legacy branch.

The shared core now rejects CR/LF and reserved /exit,/quit regardless of legacyContract, before observation/guard/send. MCP's input schema also rejects multi-line input. Unrelated legacy observation and optional observedSessionId compatibility remain unchanged; the other16 advisories remain untouched.

TDD: registered MCP test first1 failed/2 passed; shared-core legacy negatives first5 failed/21 passed. After fix: terminal core+observation29/29; complete terminal-mcp suite51/51 across7 files. Actual registered runner_terminal_input handler rejects CR-/exit, CR-/quit, LF and direct /exit,/quit with zero send-keys calls; normal legacy single-line input without expectedSessionId still succeeds. Transport instrumentation counts sends; the suite also includes existing real-tmux registration/lifecycle coverage. Full lint/build exit0 (18 existing warnings). Logs `/tmp/fly2519-legacy-{terminal-red,core-red,core-green,mcp-green}.log` preserve before/after.

This supersedes the earlier decision to retain the legacy input exception. New head review/CI required; former9f9c APPROVED does not certify the changed core. No production activation or live Lead restart.

## Terminal MCP CI registration

Final gate audit found terminal-mcp exposed only `test`, while CI light and package-gate select `test:run`. Added the matching `test:run` entry so the registered-handler regression runs in both gates. `pnpm --filter flywheel-terminal-mcp test:run` passed all 51 tests across 7 files. No runtime change. The already-running aggregate began before this entry and cannot claim terminal-mcp coverage; the standalone invocation and new exact-head CI supply it.

## Main #1203/#1201 integration (2026-09-15)

Before handoff, aaf54f591 received effective APPROVED (160b3568) and exact-head CI34932875241 succeeded, then main moved to af74f03f9 and PR became conflicting. Technical merge preserves both terminal delivery-context and main rotation semantics, both router test groups, atomic thread-id persistence, v2 readiness and partial-start cleanup; rotation timer joins the existing cleanup. Mechanical kill inventory regenerated.

Lead ruling a6e8a11a: v1 rotation and readonly flag path remain; v2 does not open StateStore and explicitly warns with FLY-2576. No new typed Bridge flag reader. This is a real remaining parity gap tracked by FLY-2576, not a completed capability. TDD: simple union caused3 v2 readiness tests to call StateStore; guarded version rejects all such opens and emits the visible reason. Six affected suites299/299; rotation lifecycle plus journal62/62; inventory5/5; CI structure passed; full lint/build passed (18 warnings). Rotation suite's first36 failures preceded rebuilding flywheel-config with main's new flag; identical tests passed62/62 after full build. No rotation test or production flag semantics weakened.

Premerge aggregate completed exit1; complete raw receipt committed as package-gate-pre-rotation.json. Teamlead1225 files/15239 tests passed with one parity-drill15s timeout (reporter failed=2 counts test+file); same unchanged test single-fork1/1 at3.156s; aaf54 exact-head CI all green. These are separate facts: aggregate remains RED and is not an onTaskUpdate-only accepted receipt. Lead52d8e93d directs no aggregate rerun or timeout changes; retain this as concurrency time-budget evidence. Earlier claude-runner RPC-only attempt automatically retried clean. Aggregate started at7664e22 before later fixes and terminal-mcp registration; targeted tests and fresh CI cover those deltas.

New merged milestone head requires fresh review/CI. Unsandboxed native/headed browser canary and full issue acceptance remain QA-owned. No production activation, restart, provider write, QA dispatch or merge to main.

## Attempt 5 — bounded Chrome startup rework, first host probe pending

QA1176 failed at0f5afbddd after3 real canary failures; native --version passed but headed Chrome did not start. Original verdict and ladder/headful/manual reproductions are preserved as qa-attempt4-* in this folder. No production/529-slot mutation was performed by this implementation rework.

Lead ed48f532 /5058a1de authorizes no-sandbox inside unchanged outer Seatbelt as an explicitly accepted renderer-isolation risk (design-correction.md). First configuration trial sourceff4474648 adds crash reporter disable flags and fixed qaRoot crash-dump redirection, including the pinned Chrome-supported breakpad-dump-location switch. No Mach or metadata permission was added. Configuration negatives first2 failed13 passed, redirected-path assertion first1 failed2 passed; fixed focused15/15 then complete browser100/100. Full lint/build passed (18 warnings); root native-process test passed and real Seatbelt integration explicitly skipped inside nested sandbox (1 pass/1 skip). Credential/read/symlink/write/direct-egress assertions unchanged.

Host diagnostic requested via gate be1736d0-07aa-4e33-b989-50ceffdf5bb0 on built ff4474648; build identity and source must be matched by the host. This is not host acceptance and no completion is claimed. Conditional Crashpad-only Mach grants or exact-path metadata remain dependent on returned host evidence. Max2 bounded rounds per Lead; no further broadening if these fail. No aggregate rerun/timeout adjustment per prior Lead52d8e93d.

## Attempt 5 — deny-home and final bounded host trial

First trial b485257bf: CI34939052499 succeeded, but effective review6b0ae131 was CHANGES_REQUESTED on HIGH browser-worker-broad-file-read-allow. Lead's host canary failed chrome-launch/chrome_launch_unproven after59562ms. Neither CI nor the earlier renderer-risk acceptance settles this finding.

Lead4bc8df26 chose home denial, not acceptance of host-secret exposure; be1736d0 and supplement3d3a3c43 authorized the conditional Crashpad exceptions. Source c23ef9986/b464cc197 denies home data and metadata, including resolved home aliases, with only pinned runtime/profile carve-outs. Exact Crashpad metadata and anchored handshake Mach names are the only added compatibility grants. No surrounding worktree or cache directory is admitted. See design-correction.md for the one-round security and two-round Chrome bounds.

TDD: Crashpad policy assertion1 failed/12 passed before, focused16/16 after; home denial assertion1 failed/13 passed before, focused17/17 after. Complete browser suite initially101 passed with one unchanged upstream tools/list5000ms timeout while full build ran concurrently. After build finished, affected policy/upstream15/15, then final complete browser102/102 across13 files. No timeout or assertion was changed. Logs: /tmp/fly2519-round5-{crashpad-red,crashpad-green,home-red,home-green,home-browser,home-focused,home-final-browser}.log.

Full pnpm -r build passed; final changed-package build at b464cc197 passed, dist/build-identity.json matches b464cc197c648d4e63399c65df325ff800c4d88c. Final pnpm lint passed with18 warnings. Real Seatbelt root regressions have two explicit nested-sandbox skips, zero failures; this is not host evidence. New synthetic-home probe covers unlisted repository .env, shell profiles, future secrets, metadata, symlink and Library enumeration denial; it additionally asserts Crashpad directory metadata is allowed while its data remains denied. Host gate1620cb21-c87e-45a1-aa54-50a5d718cc4c requests this test and the authoritative canary against the fixed source. Host result, fresh effective review and new CI remain pending; no completion is claimed. Prior aggregate RED and no-rerun ruling remain in force.

## Crashpad child metadata correction (source39c9f72ea, 2026-09-15)

Predecessor19a7e6725 effective review round9 APPROVED is preserved in review-round9.json. Host gate1620cb21 result is preserved in host-round2.txt: synthetic-home probe passed, native browser test failed browser_lost; canary exit1 at isolation-and-mcp-startup after60038ms. Reporter-disabled diagnostic identifies stat Crashpad/new denied. This is failed host evidence, not acceptance.

Per replacement handoff a8122d4f, source39c9f72ea changes only the metadata exception from literal Crashpad to its subpath and adds /new to the actual process regression; both parent/child enumeration and nested dump data remain denied. TDD policy test1 failed/13 passed before,14/14 after. Complete browser13 files102/102; pnpm -r build exit0 and dist identity39c9f72ea9c9f437eaff72f1af1c618d82b20748; pnpm lint exit0 with18 warnings. Root node/process regression1 passed,2 explicit nested_sandbox_unavailable skips,0 failed: no host proof. Logs /tmp/fly2519-crashpad-child-{red,green,browser,build,lint,root}.log.

Host final retest registered as b0f95b33-7e8a-4fcc-a66d-3b8bf1d31596, requesting both actual node regression and authoritative canary unsandboxed against this built source. Last authorized widening: if Chrome still fails, report exact stage without speculative changes. New final-head code review/CI remain necessary. Prior aggregate RED/no-rerun ruling is preserved; no package aggregate rerun, production activation, provider write, service restart, QA dispatch or completion.

## Final xattr sourceabd09303d (2026-09-15)

Policy TDD1 failed/13 passed ->14/14. Complete browser102/102 across13 files. Full pnpm -r build exit0; dist/build-identity abd09303d28530f277a1d4be7a7a545949884e6f. pnpm lint exit0 with18 warnings. Root real node/process tests1 pass2 explicit nested_sandbox_unavailable skips0 fail; no host proof. Logs /tmp/fly2519-xattr-{red,green,browser,build,lint,root}.log. No aggregate rerun under retained Lead ruling.

Host final retest fe7feec4 pending. New HIGH v2-profile-project-dot-codex-writable unresolved; fresh review/CI will be required after remediation. Predecessor e9eb59e42 CI success does not certify sourceabd09303d or pass the review gate.

## Lead metadata HIGH and final host probes (2026-09-15)

Source876f585e6: metadata assertion1 red/6 pass ->7/7; injected MCP assertion red -> parent1/1. Combined permission/parent/readiness17/17. Broader targeted capability run80 files:539 passed1 failed (default-parent integration fixture omitted CLI-injected MCP definitions). Fixture now composes home TOML plus actual parent MCP argv; affected real default-parent integration1/1 passes. Do not relabel that initial targeted run as all-green. Full build exit0/dist identity876f585e6d9a93a6e3081e606b33d13022f75996; lint passed18 warnings. Final script/fixture changes are test-only; native C helper compiles, JS syntax/format checks pass.

Host metadata canary at876f585e6 with relocated fixture home: exit0, normal write allowed, metadata writes denied, planted server absent. Host native xattr probe atd53736acc: exit0,1 pass0 fail0 skipped; includes original Node data/metadata/symlink/enumeration assertions and direct xattr syscalls. Full receipts committed. Final browser canary remains FAILED settings.dat data open / browser_lost (host-round4.txt), explicitly deferred by Lead to FLY-2587; no further widening. New effective review and exact-head CI remain required before needs_review1191. Prior aggregate RED/no-rerun preserved.

## Exact-head CI fixture correction (2026-09-15)

Head267f9f434 received effective APPROVED in round11 (question d7ad01b8-4dda-48c1-8fff-95dd096168c2, request8ef2253f-4ea0-4924-9d45-f153c4e7b371; review-round11.json). Seven nonblocking advisories were reported to Lead in d888ce35-0d63-46be-afdc-e1bc51555a48; no advisory scope expansion.

CI34946008708 at that exact head FAILED Unit(teamlead4of4): four genuine runtime-test fixture assertions returned capability_effective_mcp_mismatch before their intended skills/thread failures. The fixture supplied home TOML but omitted actual CLI MCP overrides. Test-only097a0f894 composes both, preserving production checks and existing assertions. Before: same six-case table4 failed2 passed. After:6 passed135 unrelated tests filtered, exit0 under unchanged5s timeout. Two full-file runs remained RED139 passed2 failed (initialize5s timeout and following config spy assertion); these are retained, not claimed green or ruled flakes. No timeout adjustment, no production change, no aggregate rerun.

Final lint exit0 (18 warnings). Fresh milestone head needs effective code review and exact-head CI. Earlier APPROVED and earlier CI do not certify the new head. Browser launch remains fail-closed/deferred FLY-2587; prior aggregate RED/no-rerun ruling remains.
