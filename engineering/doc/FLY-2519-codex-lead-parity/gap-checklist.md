# FLY-2519 Codex Lead 能力对等 — 实施计划
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-14
基于: plan.md、design-correction.md

## 这次交接只处理剩余差距

依据 `[lead-instruction b1077734-89fe-4664-a170-c7dbe61015f7]`，保留已有约六小时实现，不从零重设计。原 R2 plan 继续作为整体方案；本表只补默认工厂、TUI、parity、review、PR 五项剩余工作的具体接续。以下源码证据来自 Git 对象 `ce0e761a9`，不是当前 design checkout；已有代码不等于生产可用，也不需要为满足本表重复重写。

## 先保全并恢复已有工作（由实现 TURN 执行）

重派基线是 `63a144806`；具名 stash 的父提交 `ce0e761a9` 比它多出 164 个改动文件、约 2.8 万行新增代码/测试/证据。`git merge-base 63a144806 ce0e761a9` 返回 `63a144806`；当前本地/远端 feature branch 尚未包含这些实现祖先。Lead 又按 `[lead-instruction 12ae480b-994e-4d26-a790-dd65862344b9]` 建立独立保护 ref `FLY-2519-impl-backup = ce0e761a9`，本设计已实时核验该 ref。实现历史不再仅依赖 stash 可达性，不能从零重写。

精确 stash 名称：`FLY-2519 WIP report-publish (3 modified + 2 new) stashed by Lead 2026-09-14T07:29Z after body eb9fb39b usageLimited; replacement must git stash pop by this name`。核对对象 `4bd662c013b8253b7eab209deab48b990dc2d382`，父提交 `ce0e761a9`。本设计只读 Git 对象，未 apply/pop/drop stash 或恢复实现文件。

实现体取得自己的 TURN 后：

1. 检查干净 feature branch 和本轮设计提交；`git stash list --format='%gd %H %s'` 按上述完整名称查唯一 ref，重新核对 SHA，不能假设仍是 `stash@{0}`。
2. 核验 `git rev-parse FLY-2519-impl-backup` 与 stash 第一 parent 都指向 `ce0e761a9` 的同一完整 SHA，然后在当前 feature branch 执行 `git merge --no-ff FLY-2519-impl-backup`，保留全部 lineage 和本次设计附录。进度文件冲突保留原实施细节，并用实现体自身 exec-id 的 progress 命令接续；不回退 branch、不 force-push、不 rebase 丢历史。
3. merge 完成后再次按名称查 ref、核对同一 stash SHA，再 pop 该具名 ref；发生冲突时保留 stash，逐文件解决，不 drop 未确认恢复的对象。此时已提交实现历史必须仍是 HEAD 的祖先。
4. 三个 tracked WIP：`src/__tests__/reports-route.test.ts`、`src/bridge/reports-route.ts`、`src/lead-capabilities/deployment.ts`；两个 untracked WIP：`src/lead-capabilities/handlers/report-publish.ts`、`src/lead-capabilities/__tests__/report-publish.test.ts`（均在 `packages/teamlead/` 下）。三处 tracked diff 共 18 行，增加 scoped publish 响应 requestId、对应断言与 deployment entry；两个新文件补 parent 发布 handler 及测试。恢复后先读差异、跑相关测试，不把 stash 视为已审阅或已通过。

## 已有实现基线（保留）

| 已有内容 | 可核对提交/代码 |
|---|---|
| result-only broker、SQLite 回执、取消/unknown 与启动清理 | `5dad89c17`、`6325e92e9`、`248503e63`、`a2c6c7061`；`lead-capabilities/{broker,runtime-parent,receipts}.ts` |
| 当前 canonical/department/carrier 授权与 Bridge 写边界 | `e56e0a036`、`d6648dd16`、`b84366923`；`bridge/lead-capability-{read,discord,report}.ts` |
| Chrome 隔离、MCP schema、受管权限、部署校验 | `c78fe3d28`、`154dc1b46`、`8126047da`、`b4172b1a6`、`63932b6cc`；浏览器模块和 `deployment.ts` |
| 规则字节与凭证来源接线 | `6f4cd44e9`、`3eedcc7bf`、`2b3136278`；`rule-sources.ts`、`manifest-instructions.ts`、`credential-paths.ts` |
| Discord 工具/自动输出去重与 v2 parent 传输 | `97e42c658`、`6c18a7c40`、`07293b66f`、`0201b3a1c`、`141573281`；实际 journal/outbox、typed Bridge 与自动 transport |

`implementation-verification.md` 位于 preserved commit，记录了各批 failing test → minimal code → focused green，以及全量争用/worker 失败。它是已有测试历史，当前恢复后仍需精确 head 检查，不能重写成新一次通过。

## G1. 默认工厂：把已写模块组成可启动的 Lead

默认工厂指生产启动时负责组装身份、工具、规则和资源的函数。`codex-lead-runtime.ts` 的 `buildCodexLeadRuntime` v2 分支要求注入 `dependencies.capabilityParent`，缺失即 `capability_parent_not_assembled`；`main` 默认调用没有此依赖。已有 `startLeadCapabilityParent` 只提供受管生命周期，不能把测试中的手工注入算成默认启动已接通。

`lead-capabilities/runtime-factory.ts` 已增加 provider 组装、manifest/parent/自动回复接线及逆序清理；部署/来源/home 的实际准备和两个 runtime 的默认调用仍未完成。最终入口由两个 runtime 共用。复用现有 deployment/context/directories、rule/skill selectors、manifest、credential aliases、browser provider、Linear/GitHub/git/Bridge handlers、automatic outbound 和 parent；不新增 StateStore 实例、不发明第二份身份/规则目录。使用固定部署产物及可信配置，不能从可写 checkout 加载 provider 或凭证脚本。

工厂须先解析当前 identity/version/deployment 和非秘密来源，再创建本 activation 资源、组装所有适用 handler、核验 manifest 与 handler 双向覆盖、启动隔离检查与 parent，最后交回 runtime。任何阶段失败按逆序关闭本 activation 已创建资源。把未实现 handler 从 advertised manifest 静默删掉不能算完成；六个 native skill 或部署身份缺失仍明确失败；按 Lead 4b1bfb67 裁定，persona skill 缺失/变更记录可见 gap 并手工回退，不阻止启动，也不宣称该技能可用。

规则与技能需要实际消费接线：`rule-sources.ts:76/86/228/329` 已有来源选择、Codex adapter、所需技能选择和实际消费者回执；`runtime-parent.ts:187` 当前只加载 `manifest.ruleSources`，没有把技能物化到模型发现目录的生产路径。工厂把获准公开规则/技能放到不含凭证的受管 staging 目录，核验源及 adapter 字节，安装到本 activation 的 skills 目录后再读回生成实际消费证据；不能只填 manifest 数组。`runtime-factory.test.ts` 验证技能实际可发现、缺失必需项、来源/adapter hash 漂移和额外来源拒绝。

G1 包含下列已有目录尚未接完的日常 provider，原 plan §5 的输入/输出与拒绝语义直接复用：

- P07：`handlers/bridge-read.ts` 目前仅 health/admission/sessions、resident-hold 与 code-review 观察；其余已盘点且允许的 Bridge read/write 子操作仍需逐项 adapter。保留动作继续 reserved。
- P08–P10：catalog 已声明 terminal、inbox、patrol，但 preserved `handlers/` 没有对应实现。提取现有 terminal/inbox 核心、固定部署 patrol helper，分别接精确 execution/等待态、event handle 内存 token、六步只读与 judgment 写。不能因有 schema 就勾选。
- P11：先恢复 report-publish WIP，接 parent artifact handler 与既有 scoped Bridge publish；补 report ownership、deliver、verify。验证 wrong-owner 拒绝、publish-only 零发送、请求/响应 requestId、外部上传后断线 unknown+只读对账、CSP/nonce/评论行为。不可允许模型给任意 URL/path/header。
- P15–P17：`LEAD_PARITY_COVERAGE` 仍为 `pending-upstream-schema-snapshot`。采实际获准服务 schema，按原 plan 固定 endpoint/tool 与 read/write scope，接知识、Xiaohongshu、Context7/其他适用项；缺凭证或配置留 unverified 并补齐，不删行或声称不适用。

G1 首个红测：不注入 capabilityParent 的正常 v2 `buildCodexLeadRuntime` 应通过真实工厂取得 parent（测试仅隔离 provider/进程边界），原代码会拒绝。补 `__tests__/runtime-factory.test.ts` 覆盖真实目录/manifest/handler 组装、缺必需来源、陈旧授权、逐阶段失败清理；已有 runtime-parent/browser/provider/handler 测试继续复用。不要求在测试中激活生产。

## G2. TUI：把同一 parent 接进可见窗口

TUI 是 founder 能看见和操作的 Codex 终端窗口。`codex-lead-tui-runtime.ts` 仍显式拒绝 v2；`codex-lead.sh` 已为 v2 跳过 legacy home/daemon ensure，不能误写成当前 v2 正在回落旧 home writer。已有 `tui-window.ts` 的 model env/permission 支持是前置工作，不代表 TUI runtime 已完成装配。

复用 G1 同一工厂并沿用 `codex-lead-runtime.ts` 已有 parent、有效权限、manifest instructions、delivery context 与 automatic outbound 接线。TUI daemon 和 `resume --remote` 可见 pane 必须使用同一 activation/home/permission/MCP pins；保留 per-turn façade 和长存 parent/Chrome，不恢复已删除 watcher。thread start/resume 都检查真实 effective config；partial-start 或 pane/daemon 失败关闭自己资源，不影响其他 Lead/个人 Chrome。

具体接线点：`TuiGenerationDeps`（:492）增加同一 parent 依赖；generation 的 persona 读取（:580）改用已核验 manifest instructions，sender（:625）接可信自动 transport/context，`tuiSpec`（:907）与 daemon ensure（:1122）传同一 washed env/pins，legacy-only config gate（:1070）按 v1/v2 使用既有严格 validator。行号对应 `ce0e761a9`；已有 `buildTuiDaemonEnv` 与 `tui-window.ts:99` 的 v2 helper 直接复用。

G2 首个红测：`__tests__/codex-lead-tui-runtime.test.ts` 使用严格 v2 marker 可进入默认工厂并生成可见 pane，现有版本在配置解析时拒绝。再验证缺 marker v1 兼容、畸形/legacy 配置拒绝、start/resume 使用同一 pins、自动/主动消息同上下文去重与重启 unknown、不带 action secret 的 daemon/pane env。复用 `tui-window.test.ts`、shell launcher/home fixtures；不把后台 runtime 通过替代 founder 可见窗口。

## G3. Parity：逐项证据与隔离真机

Parity 指两种 Lead 能完成相同适用业务动作。当前 `scripts/qa-codex-lead-parity.mjs` 只接受 `--mode inventory`，固定 `parityVerified=false`、P01–P17 全 `unverified`；它会拒绝 drill，测试也明确断言这一点。保留这份安全盘点语义，另增加显式隔离 drill/证据校验入口（`scripts/qa-codex-lead-parity-drill.mjs` 及对应 `.test.mjs`），不能把 inventory 改成会自动调生产 provider 的命令。

隔离入口要求指定 registry/home/socket/输出目录，启动真实 parent、UDS、SQLite 与默认 TUI fixture，对已授权的测试服务留可核对 request/response；生产 provider 写入和生产 v2 激活均拒绝。浏览器需在非嵌套宿主的 Seatbelt 下实际启动 Chrome MCP，核验 Node dylib/IPC、canary、只读管理台与截图。记录确切运行命令、版本、head、进程/工具回执和清理结果，按 `design-correction.md` 的 QA cookie 裁定处理，不扩大测试门槛。

机器证据沿用 plan §9 字段，校验同 identity/activation/issue/run/thread/sourceSha，P01–P17 每行有正例、必要负例与可打开引用。完整工具轨迹证明零 Claude 工具；fixture 写入、真实宿主启动和生产业务验收分别标注。缺任何适用行、工具调用轨迹、版本或真机证据，验证器必须失败或明确 unverified。原始 Honey Lemon 完整 issue 留痕仍是最终业务要求，不能由当前禁止生产写的 QA 替代。

G3 红测是“把仅有 inventory 或缺浏览器/任一 P 行的证据当 pass”必须被拒绝；完成后在宿主实际运行可复跑命令，单测绿不足以通过本项。

## G4. Review：绑定最终实现 head

设计评审与代码评审分开。原 R2 批准整体方案；本次五项差距清单另走当前 execution 的明确 gate+request-review。代码完成后由实现体使用它自己的 exec-id 注册 `review_code`，不得复用本设计 gate 或旧审阅 head。只有结构化 effective `reviewVerdict` 为准；HIGH 按 findings 修复并用新 gate/request 重审，非阻断 advisories 按 Lead 要求报告留档。

台账、实施/QA 证据、PR checklist 和应更新的里程碑随最后代码提交一起推送，随后冻结待评审 head。Review 之后不再单独推文档来改变该 head；确需代码修复时一并更新证据并重新跑相应门禁。当前设计 runner 不替实现体请求 code review 或发 successor。

精确头验证使用真实脚本：`pnpm --filter flywheel-teamlead typecheck`、对应 capability/runtime/comm targeted tests、`pnpm test:packages:run`、`pnpm -r build`、`pnpm lint` 和 GitHub 同 head CI。新 drill 用 `node --test`。宿主争用与 onTaskUpdate 按注入裁定处理并留失败+隔离证据，不把未运行包或未知失败涂绿。

## G5. PR：可审阅、完整清单、阶段交接

目前 `gh pr list --state all --search FLY-2519` 和当前 branch 查询均无 PR。实现体恢复祖先、完成上述差距后创建非 draft PR；标题和描述围绕最终实现，P01–P17 逐行列 checkbox、实际入口、证据链接与证据层，包含 original scope 和保留权限。正文使用结构化参数或 `--body-file`，不拼 shell 多行文字。

PR head 必须与有效 code review、CI 和 QA 记录一致；勾选只表示对应证据已成立，缺 live Honey Lemon 业务证据时明确留未完成状态，不能宣称已上线对等。实现/QA 按各自任务完成命令交接；合并和部署继续走 founder/独立 updater 通道。本设计只发布 DESIGN-HTML ready、提交设计阶段 receipt 后 park，不申请 shipping、不合并。

## P09 event ACK ruling and implementation update — 2026-09-14

Lead answer `7dfeeba4-2dfa-45f7-881a-6c299ab41491` supersedes the earlier proposed event-token ingress in the P08–P10 gap note: parity follows Claude's current behavior, not revival of a retired protocol. Batch ACK is the live path. `inbox.event.ack` stays in the catalog as a typed owned-event adapter to the existing coordinator. Per Lead, both vendors' event ACK capability exists but is not enabled in production.

The adapter now identifies existing events as `event_<event_seq>`, checks current recipient and project, and delegates to the existing coordinator instance in Bridge. Disabled/retired/exempt returns `status=rejected, errorCode=inbox_event_ack_disabled`; it does not claim an ACK. Enabled mode reuses the existing recipient/token verification and StateStore ACK effect. Tokens remain in Bridge memory; no new ingress, grant registry, schema, or enable switch. Both modes have actual SQLite and mounted HTTP tests. This closes the event ACK handler gap only; factory, patrol, other providers, actual runtime parity and G1–G5 acceptance remain open.

## P10 patrol ruling — 2026-09-14

Lead answer `b2c5733d-f82e-427c-9542-1c9acd2c7ab1`: the current judgment sink is the same report file under patrol-reports/<lead>, not a table. healthy maps to the selected STEP n: OK; unhealthy requires STEP n: FINDING and complete canonical FINDING metadata; unknown requires STEP n: UNAVAILABLE(transient|structural: stable_token). Keep machine PANE_EVIDENCE fields intact, changing only action/result. executionId is evidence, not a status field. Run the same three completion checks in runner-patrol-rules.md after writing. DWELL receipts remain on their existing separate command. This requires the typed judgment input to carry the step and necessary finding/pane details; current minimal catalog input alone is insufficient.

Lead approved parent-prefetched bounded GitHub DTOs for the fixed snapshot helper. The helper now accepts explicit --github-facts input with strict scope/file/schema/size checks and no gh fallback. A parent-only prefetch function uses the two existing fixed bounded GitHub reads, strips extra SDK fields and rechecks canonical context. The actual patrol.snapshot handler, report ownership/artifact binding, judgment adapter and runtime factory are still pending.

## P15–P17 upstream baseline ruling and capture (2026-09-14)

Lead answer `edcfa38d-a793-4f56-b679-7154d337b780` specifies the current configured gbrain, Xiaohongshu and Context7 tools/list as the baseline; no separate approved version exists. Preserve all applicable rows, retain guarded writes, fail closed on unclassified writes and baseline drift. Xiaohongshu publishing/commenting remains founder-gated. This ruling does not authorize a production write.

Captured actual MCP initialize/tools-list schemas: gbrain 0.9.0 / 30 tools, Xiaohongshu 2.0.0 / 16 tools, Context7 4.1.0 / 2 tools. Files `upstream-gbrain-schema.json`, `upstream-xiaohongshu-mcp-schema.json`, `upstream-context7-schema.json` preserve all 48 definitions and exact digests. At initial capture, migration concerns were unresolved, so the same installed command/server/version was enumerated using a temporary HOME/PGlite database with no credentials. The verified host lifecycle below supersedes that initial limitation. Its tools/list uses the same static operations map. The HTTP services were only initialized/listed; no tools/call or upstream writes occurred.

`assertUpstreamToolsPinned` validates all tool schemas and exact server version/digest without dropping unsupported tools. It produces manifest-compatible integration coordinates only; it is not a permission grant or proof that adapters/default factory have been wired. Concrete read/write handlers, scope guards, founder-gated publishing/comments, canonical provider configuration and runtime drift enforcement remain required.

## P15–P16 write authority ruling (2026-09-14, supersedes inferred future gate work)

Lead answer `3a78eb55-d633-42d6-a5f3-a6b2b70bc2d0` confirms no existing machine-verifiable founder approval receipt for Xiaohongshu publish/comment/like/favorite. In this issue those operations MUST fail closed with `founder_write_gate_absent` (meaning 无既有门); Lead owns a separate gate-design follow-up. Do not invent approval from prose or reuse ship approval. xsec tokens stay in parent handles, media inputs use controlled artifacts.

For gbrain, no existing project-scope rule exists. Keep all read tools without inventing a slug prefix; write/destructive operations remain present but fail closed as `unclassified_write` until founder approves a scope rule. This is the current supervised capability boundary, not a reason to remove rows. Cookie deletion is also an unclassified write and is not enabled.

All 46 gbrain/Xiaohongshu tools now have fixed catalog inputs. Nineteen write rows have explicit denying handlers; their rejection is durable through the existing broker receipt state machine. The remaining 27 read handlers and provider lifecycles are still pending. P15/P16 are not yet complete.

## P12 host proof ownership (2026-09-14)

Current browser canary: **blocked by nested sandbox in implement body; host proof owned by QA via script**. Lead ruling `be489e78-7771-404d-b704-848c88cf35f9` identifies `sandbox-exec: sandbox_apply: Operation not permitted` as nested Seatbelt, not a policy failure. Stop retrying inside Implement. QA runs the committed, argument-free `node scripts/qa-fly-2519-browser-canary.mjs` on the host outside any sandbox, after building this exact head. It exits 0 only after host identity, Node launch, full Seatbelt file/network canaries, pinned MCP, native Chrome list_pages, forced-egress refusal and session invalidation succeed. Each JSON record carries its private temporary evidenceLog path; this remains after disposable profile/artifact cleanup. The exact nested-sandbox stderr maps to `nested_sandbox_unavailable`, never a passing result. Production v2 activation/restart/provider-write permissions remain unchanged.

## P15 host lifecycle evidence (2026-09-14)

- [x] Parent gbrain provider uses pinned host 0.9.0 serve/config, fixed washed environment and bounded stdio lifecycle. Code/config drift rejects; no DB URL override, .env/preload or auto-install is admitted.
- [x] Real host canary initializes, verifies all 30 tools, calls only get_stats and closes with zero migrations observed. Reproduce after build with `node scripts/qa-fly-2519-gbrain-canary.mjs`; final receipt `fly2519-gbrain-evidence-UfmZbt/canary.jsonl` is detailed in implementation-verification.md.
- [ ] Default factory/TUI must actually select this provider; the complete isolated Lead issue drill is still pending. Existing read adapters and explicit write denials do not alone establish full parity.

## Remaining default-assembly prerequisites found in source (2026-09-14)

- [x] C-tier unconditional broker denials remain visible without requiring forbidden provider handlers/credentials; real parent UDS refusal is tested.
- [x] P04 attachment get/send now have callable parent/Bridge handlers, with message ownership, controlled artifacts, byte/file limits, redirect/secret guards and composed HTTP/SQLite tests. Default factory selection and full acceptance remain below.
- [x] P01 all six existing names are exposed through the v2 MCP/catalog and parent/Bridge handlers; composed MCP/HTTP/SQLite tests prove replay without redispatch. Default factory selection remains below.
- [x] Explicit native-skill pins for observed Codex 0.153.2 and all six native skills; read-only host canary verifies the current Implement home. Honey Lemon activation/discovery remains unproved.
- [ ] Complete actual rule/skill source selection and default parent/TUI assembly. Missing functionality must not be converted into an omitted manifest row.

## P04 attachment path update (2026-09-14)

- [x] Attachment get has a concrete Bridge download and parent artifact handler, with exact message/CDN identity, credential separation, byte/redirect/secret guards and controlled HTTP tests.
- [x] Attachment send now has parent upload, typed Bridge dispatch and durable file-digest/UUID receipts. Both attachment handlers still require selection by the pending default factory; no live Discord or full Lead acceptance is claimed.

## Tool adapter boundaries (Lead ruling 371d5706, 2026-09-14)

- [x] Authored text now has a typed parent ingress for four text MIME types, limited to 512 KiB with secret scan before storing. Existing report publication authorization remains unchanged.
- [x] ProofShot native adapter is pinned and installed in an isolated home. Its required receipt names unsupported video recording, server start/kill and process takeover; screenshots/console/network follow the approved 21 native browser tools. This is adapter installation, not full ProofShot parity or host browser acceptance.
- [x] Founder HTML delivery adapter maps authored HTML to artifact.text.create, report.publish/verify/deliver and canonical destination receipts. Isolated installation is verified; live delivery remains unproved.
- [ ] Four remaining tool-dependent adapters and default activation wiring remain incomplete.

## XHS workflow scope clarification (2026-09-14)

- [ ] xiaohongshu-learning and xiaohongshu-deep-learning: runner_workflow_not_lead_capability, visible startup receipt; fallback is dispatching the authorized Runner. Their state/checkpoint/video/scheduler workflows are not implemented in the Lead (ruling 31ce91bb).
- [x] Lead-side XHS-MEMORY-WRITE has own-project typed memory.add/search, bounded provenance projection, Bridge UUID receipts and a Codex rule using existing scoped respond_runner for ACK. Isolated Bridge/parent tests pass; live delegation and complete issue acceptance remain unproved.

## Default browser policy boundary (Lead 67ca977b, 2026-09-14)

- Default native browser: public web, disposable activation profile/generation, no app QA identity minted. Management-console reads use typed Bridge operations; public QA-report pages use the native browser.
- [ ] Local QA targets and externally issued QA identity/revoker are unsupported pending future trusted configuration; they are outside this issue's default browser scope.

## Default headless assembly update (2026-09-14)

- [x] Headless v2 selects the actual default parent factory, with deployed identity, actual source/menu discovery, pinned native-home preparation and provider/manifest/parent composition. Isolated composition and runtime tests pass.
- [ ] TUI v2 path and real complete issue/host acceptance remain unproved. Default code selection is not production activation or a passing host isolation receipt.

### G1/G2 actual entry update (2026-09-14)

The G1/G2 source descriptions above record the ce0e761a9 handoff baseline. They are superseded by the following implementation evidence, without reducing the remaining acceptance scope:

- [x] Headless and TUI normal v2 entries select startDefaultLeadCapabilityParent. TUI no longer fails merely because no test dependency was injected.
- [x] TUI uses only the parent-owned app-server Unix socket permitted by a2a08b4c; no legacy daemon adoption/stop. The founder command uses the same binary/pins/socket, with effective config/skills/MCP gates and shared parent/journal lifecycle.
- [x] Isolated real Codex Unix handshake, actual named permissions, skills/list response and cleanup verified by scripts/fly2519-tui-socket-canary.mjs. This check copies no auth and starts no model turn; parent authority is a fixture.
- [ ] Full default-provider issue drill and actual founder-visible TUI acceptance remain unproved. Transport-only evidence is not whole Lead parity.
- [ ] Research skill adapters, native browser Seatbelt host proof, full repository/review/exact-head CI/non-draft PR remain pending.

### Research admission resolved (2026-09-14)

Question 69b1e642 supersedes the earlier remaining-adapter item: no new research adapter/provider/credential ingress is required for this round. deep-research remains authenticated_research_not_available and last30days remains research_provider_not_admitted in the hashed inventory/startup receipt. Both are explicitly unimplemented, with authorized Runner/interactive fallback. This closes the admission decision, not either research capability. Remaining work is the isolated complete issue evidence/drill, QA-owned browser host proof and repository/review/CI/PR gates.

### G3 collector implementation update (2026-09-14)

- [x] A fixed-command isolated collector executes the real parent/UDS/SQLite issue fixture and the separate real default-factory/TUI fixture, saves hashed logs/results, and refuses to overwrite existing evidence directories.
- [x] coverage.json records all P01-P17 representative positive/negative references, including attachment/patrol/report lifecycles and same-activation fixture rule/adapter checks. This is representative fixture coverage, not all-operation parity.
- [ ] Native browser host/Seatbelt evidence and the complete Honey Lemon business issue remain unverified and QA-owned under existing authorization. Browser fixture is explicitly provider_fixture_only; full model/native tool trace and production acceptance are not inferred from broker trace.
- [ ] Effective exact-head code review, non-draft PR and exact-head CI remain pending. Host aggregate r4 remains red with focused reproduction green; do not run a host r5.


## 2026-09-14 R1 bounded fix round followups

Lead instruction f7cd32c1-bb5b-4a1f-a4d9-93c0bfa1b8da permits an explicit gap when an individual remaining advisory exceeds about 30 minutes. Six priority A items are fixed; overall 17/19 fixed. Full per-finding evidence is in code-review-r1.md.

- [ ] discord-capability-inflight-map-wedge: retain fail-closed 64-entry behavior for uncertain writes. Safe eviction needs durable Bridge admission/replay for edit/react/create plus cancellation/crash coverage; parent journal and reply/attachment receipts alone cannot safely replace that barrier. Estimated beyond the bounded item budget; do not introduce TTL that can duplicate writes.
- [ ] model-isolation-canary-gaps: the existing probe runs before the actual app-server socket exists and uses tmpdir files. Add a post-app-server pre-admission canary for the exact socket and distinct root/credential-deny host fixtures in followup. A substitute socket/config-only assertion is insufficient. Host execution remains unverified and nested sandbox retry is prohibited by the existing Lead ruling.

These are disclosed followups, not evidence of full parity or host acceptance. Native browser Seatbelt canary and Honey Lemon full business drill remain unaccepted until QA supplies actual evidence.
