# FLY-2886 语音大脑 — 实现恢复核对
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886)
日期: 2026-09-26
基于: plan.md v10、progress.md

## 范围与当前边界

从救援提交 `94bef260a` 继续，执行身份 `88dd437e-4f73-4b69-947a-35512417723d`，TURN implement epoch 3。设计与 §5.3 已批准，没有重做设计。7/8 是恢复游标，不代表只剩交卷。所有证据只说明本地实现；没有真房、生产、完整 CI 或 shipping 证明。未拆 529 房、未调度 QA、未合并或部署。

## 已提交批次

- `56dee3c79`：救援构建与类型错误、report 常驻授权回归、语音租约续期误判、锁派发 deadline 与已派发 not_dispatched 保护。对应红绿输出及 lint/build/dependent typecheck 已存 evidence/resume-*.txt。
- `b59f06455`：outbound 410 跳过并继续后续消息，409 失租约仍停止，定向 daemon 35/35。
- `2fa3dede8`：disabled/draining policy、过期已派发锁保持 unknown、原 fence 迟到终态结算票据、跨项目与 activation 别名拒绝，4 文件 45/45。
- `fb96254cf`：订阅 capability parent 接容器，ChatGPT account/config/native/tools 断言、隔离无工具 scribe、每 turn delivery context；founder_chrome/isolated/off 三档；0.156.1 实机原生技能树采集；会话动作账本与关闭快照。详见 resume-container-wiring.md / resume-browser-ledger.md。

## 当前组合收尾

- 目标写入别名 canonical 化；可信 provider 终态在超时/撤权后结算原回执，绝不授予新操作权限。Linear/GitHub/Bridge/浏览器适配器分别验证原响应；没有观察到成功响应的远端写保持 unknown。Bridge 内层无目标锁也能更新自身回执。适配器 7 文件 132/132，broker+GitHub 36/36。
- 对账只读原 activation/request/target 的 durable success；同时支持语音 parent 与 Bridge 内层 journal。未知值、当前 provider 值、其他请求均不能清锁。resident force-clear 要明确风险声明并留审计。重复 release 无副作用。相关 3 文件 8/8。
- unknown 目标进入 bootstrap 受阻节和 durable Lead 事件，30 分钟再提醒一次；动作日志写入与锁结算同事务，通知失败可重试、不重复外部写。
- C6/C10：Lead/tell 经隔离改稿、字段校验、单一 SpeechArbiter；20/40 秒等待 cue、插话/迟到结果保留；自然 realtime generation 读取 durable 背景环，tell 每次播前复核。§5.3 live append 仍未准入，保持关闭。
- C5：实际完成工具结果带 itemId，最终回答/文字版不能自证；使用 Bridge roster 与可信快照保护字段；文字版发布成功才播指针，失败材料进入纪要。6 文件 94/94，services24，session追加关闭场景42。

## 尚未完成的边界

1. C9 实际 admitted manifest 工具类别接开场简报，以及 enabled 状态读取失败的如实 unavailable 回退，正在按批准计划补齐。
2. §4.5 founder-only 分类、拒绝日志回执和据实口述，正在补齐；没有新 founder 请求入口。
3. §3 重复义务：0.156.1 先 StartOrSteer 后 handoff 通知，事后附账本不能证明重复写尚未发生。已询问 Lead `cd6d1609-baf9-4792-8f74-3abe0ec1a133`，不把规约或事后 steer 算作结构性防重复。独立的每 turn 回执关联继续实现。
4. 当前最终相关验证、PR、有效代码审查与 needs_review completion 尚无完成证据。

## 验证范围

清册见 evidence/related-test-scope.md：逐个 changed production TS 的全路径/文件名/父目录固定字符串检索，保留直接消费者与变更测试，逐项说明排除；另跑 owning package vitest related。明确排除计划批准的 tmux-viewer.macos。没有本机全包套件，没有请求普通 head full CI。

早期四个授权文件 related 经 import graph 选中 127 文件，120 文件通过、7 文件9测试失败。失败项逐个定位：createLeadRuntime 冷动态 import 超15秒污染下一用例（改为collection阶段静态导入，5/5）；默认parent新增policy探测需fixture响应（1/1）；runner fixture缺当前carrier evidence（36/36）；其余rotation53、runsroute1、epicwiring3、services24复跑通过。该早期 related 不是当前完整通过证据。

保留 Node 脚本消费者16文件447测试通过（resume-retained-node.txt）。shell、最后依赖构建/typecheck/lint及最终TS相关验证仍在进行。实际 Chrome 接管、真人语音、订阅真请求、写操作及 founder 门验收归 QA；0.156.1 canonical host 基线部署仍为部署前置，未在本实现阶段操作生产。

## 第二次恢复（执行身份 e4592d00，2026-09-26）

从 Lead 保全提交 `a2182c036` 接续，先 `git merge origin/main`（`0cd00c695`，无冲突；main 同期删除旧 voice-bridge/Gemini 语音，语音核心包仍在）。WIP 编译通过；voice-codex 13 文件 227 项绿，teamlead 仅 WIP 先红的 `voice-turn-receipts` 2 项。

- 审计里的 C9 两处（admitted manifest 能力类别进开场简报、enabled 状态读取失败按「现在读不到」回退）与 §4.5 founder-only 分类/信箱回执，均已在 WIP 接通并有测试（`voice-capability-brief` 5、`voice-founder-denial` 5、`voice-session-services`）。
- §3 重复义务：按 Lead 裁定（问询 `cd6d1609`）实现写入前防重门，plan §3.1 为真源。`voice-repeat-gate.ts` + broker `repeatGate` + 回执可空列 `dedupe_digest`；确认只认拦截所在回合结束后、说话人已归属的 founder 第一句终稿转写。Lead 必测三例先红（`resume2-repeat-red.txt`，11 项红）后绿（29/29）。
- 每 turn 回执关联：`lead_operation_receipt_deliveries` + `listByDelivery`（WIP 先红的 2 项转绿）；Backend 优先用 parent `turnActionLedger(turnId)`，缺失时回退原差集（`codex-repeat-confirmation.test.ts` 先红后绿 4/4）。
- 后台规约追加：带 `data.spokenText` 的拒绝，【口语】即该原文；`duplicate_recent_write` 后本回合不再调用，只在她下一句明确要求再做时用新 requestId 调一次。
- Lead 补充裁定（问询 `dac7093e`）：防重门只跨后台回合生效，同回合 agent 自己的连续相同动作（含浏览器）不拦；回执所属回合取第一条投递关联。已先红（2 项）后绿（36/36）。残余边界：她重复原话时若第一个回合仍在跑、被 steer 进同一回合，则不拦（已在报告中写明）。

### 最终相关验证（合并后 HEAD）

清册在当前 HEAD 重建：94 个变更生产 TS、146 个保留测试路径（teamlead 91、voice-codex 20、config 6、voice-core 1、scripts 28 = 12 shell + 16 Node），34 个排除项逐条写在 `related-test-scope.md`；10MB 机器 JSON 放在 `~/.flywheel/artifacts/FLY-2886/`。旧清册遗留的 agent-team-transport / claude-runner / edge-worker / voice-bridge 分包清单已删除（新清册不含它们）。

| 项 | 结果 |
|---|---|
| `pnpm lint`（biome，max-diagnostics=1000） | 退出 0；分支内 13 个格式/导入 error 已修；余 25 个 warning 均为 main 既有（含 plugin.ts 两处 useConst，不在本分支 diff 行内） |
| `pnpm --filter <teamlead/voice-codex/voice-core>... build` | 全部 Done |
| `pnpm --filter ...<pkg> typecheck`（依赖方） | voice-core / voice-bridge / voice-headphone / teamlead / voice-codex Done |
| voice-codex 保留 20 文件 | 342/342 |
| voice-core 保留 1 文件 | 7/7 |
| config 保留 6 文件 | 135/136；`fly1981-final-ledgers` 在负载均值 206 下 15s 超时，单独复跑 12/12 |
| teamlead 保留 91 文件（隔离 `FLYWHEEL_CODEX_HOMES_ROOT`/`SESSION_DIR`，4 线程） | 1267/1280；13 项失败分诊见下 |
| shell 12 个 | 12/12（`package-onboard-smoke` 首跑因本 worktree 未构建 inbox-mcp 等 6 包 dist 失败，补构建后 26/26） |
| Node 16 个 | 447/447 |
| `vitest related` | voice-codex 27 文件 393/393；voice-core 9 文件 69/69；teamlead 叶子模块（voice-repeat-gate / voice-capability-session / voice-capability-parent）2 文件 33/33 |

teamlead 13 项失败分诊：`runtime-parent` 4 项与 `codex-runner-orphan-reaper` 2 项是 runner 的超长 `TMPDIR` 使 unix socket 路径超过 103 字节（`invalid v2 socket path` / `listen EINVAL`），`TMPDIR=/tmp/f2886t` 复跑全过；`default-parent-integration`、`StateStore.fly2341-terminal-archive` 与 event-route 的 409 一项在同一复跑中通过；event-route 两项 PR 声明用例在负载下 5s 超时，`--testTimeout=30000` 复跑 2.3–3.1s 通过。枢纽文件（StateStore.ts、plugin.ts、catalog.ts 等）不跑 `vitest related`（会退化为整包 1606 文件），由清册的 git grep 消费者覆盖。排除 `**/tmux-viewer.macos.test.ts`（plan §9）。没有本机全包套件，没有请求 full CI；真房语音、订阅真请求、founder 门与 Chrome 接管仍归 QA。

### 补充：按 `.js` 导入说明符的消费者发现与两处常驻回归

字面清册用 `broker.ts` 这类文件名检索，而 ESM 测试 import 的是 `broker.js`，因此漏掉一批直接消费者。补做两轮：

1. `receipts.js` / `broker.js` / `voice-repeat-gate.js` / `SqliteJournalStore.js` 的 teamlead 直接消费者 51 个（首跑 8 文件 18 项红）。分诊出两处相对 main 的真回归并修复（`3a28c9463`）：
   - `resolveLeadCapabilityRuntimeAuthority` 在 handler 构造时就因缺 `FLYWHEEL_LEAD_CARRIER_INSTANCE_ID` 抛错（main 只在派发边界校验），导致只用 `trusted` 的 context7 / xiaohongshu / upstream / patrol handler 无法构造。改为读取 `authority`/`authoritySecret` 时才解析；新增 `runtime-authority.test.ts` 先红后绿。
   - broker 对所有 actor 接受中止后的迟到终态并把 unknown 结算为 succeeded，违背 plan §2「关闭档写路径不变」。收窄为「本请求持有目标锁 fence，或 broker 属于 `voice:` activation（含 Bridge 内层为语音请求建的 broker）」；main 的 `lead-memory` 用例即常驻守卫，`github-terminal-evidence` 参数化覆盖语音结算/常驻不结算两支。
   - report publish/verify 夹具随已批准的 authority 信封更新（`stagePublish` 只挑 4 个字段，不落盘 carrier 机密）。
   复跑 52 文件 790/790。
2. 对全部非枢纽变更生产文件做 `/<basename>.js"` 检索，新增未跑消费者：teamlead 59 文件 677/677、voice-codex 7 文件 51/51；claude-runner 与 voice-headphone 的命中是同名不同模块（各自的 `codex-home.ts` / `bridge-client.ts`），排除。
3. 枢纽中 `catalog.js` 已无未跑消费者；`ProjectConfig.js` 与 `plugin.js` 的 166 个未跑消费者 2368/2368。`StateStore.js` 另有 476 个未跑消费者（约等于整包），按枢纽规则不在本机跑，留给 QA 冻结头的 full CI；语音相关的 StateStore 用例已在保留集中跑过。

## 第三次恢复（执行身份 177564f8，2026-09-26）：plan v12 §14 真宿主起 parent

从设计 v12（§14 APPROVED R7）接续；QA@2 FAIL（claim 1632）的 5 个阻断与 (a)(b) 结构问题按 §14 实现，另有 4 处实现期更正（plan §14.7，证据 `verification.md`）：

| 提交 | 内容 |
|---|---|
| `c6bba2367` | §14.3：node 运行时闭包（Mach-O 解析、realpath 精确文件 + 软链跳点目录）、pins 目录 `openssl.cnf` 与 `OPENSSL_CONF` 三处同源注入；删 `:tmpdir` deny；真宿主测试（旧 readPaths 先红 exit 134） |
| `0939c19de` | §14.1：`integrationFailurePolicy`（常驻 fail_closed 字节不变，语音 omit_integration）、`requires` 组、四种原因、覆盖不变式、manifest `unavailableIntegrations`、简报「没接上」一行；语音 parent 缺 Linear 不抛、Bridge 显式检查、同步 `revoke()` |
| `29f6ab5e9` | Lead 裁定 B：codex 托管代理链到 Flywheel egress（`allow_upstream_proxy` + `HTTP(S)_PROXY`），隔离探针加上游链证明；常驻回归矩阵 |
| `7aa5c58ef` | §14.2 Bridge：`background_state` 列、`POST background-degraded`、degraded 上下文、scope 撤权、poller 不写 |
| `42a07a7ff` | §14.2 残留回收：spawn 观察器、按精确身份冻结再杀、落盘续做、unprovable/unsettled 上报 |
| `6cfce8fc4` | §14.2 守护进程：准入/降级/前台三段、绝对截止时间、固定顺序、`effectiveBackground()`、thread 降级提示 |
| `5fc0626ad` | 真宿主预演发现 `codex_apps` 注入，语音 capability 进程 `features.apps=false` |

真宿主本地预演（verification §4）：语音 parent 1.75s 起来、不可用集成与原因正确、capability app-server 订阅/配置/技能核过、模型侧 MCP 只剩 `lead_actions`。未覆盖、归 529 房 QA：有 Linear key 的一场、完整语音会话、后台读写与 founder 门、浏览器模式、QA-R2a/R2b。

相关验证见 `evidence/v12-related-test-scope.md`。没有跑本机全包套件的意图（teamlead `vitest related` 因叶子模块被 Bridge 插件引用而展开到 614 个文件，全部通过）；没有请求 full CI。

### 第三次恢复续：独立评审 minor 与 founder 删除 gbrain

- `bc4adc7d5`：独立 Claude 评审（非 Codex 门）提出的 minor：`release()` 两步都失败时上报 `admission_residual_release_failed`；清空后删不掉的残留记录只报一次 `admission_residual_file_undeletable`；`ps -p` 只有 exit 1 且 stdout/stderr 全空才算进程不在（真宿主测：不存在范围的 pid 让 ps 打诊断 → 抛错）；R2#1 两步都失败的分支测试；R2#3 负断言补正向对照（`github.pr.create` / `git.feature.push` 在 github 可用时确实在 manifest 里）。
- founder 直令删除 gbrain（plan §14.8）：先红（`gbrain-removed.test.ts` 4 条全红，`evidence/v12-gbrain-removal.md`）后绿。
- 仓库级守卫补登记（本单 v12 引入、此前相关测试范围没覆盖到的扫描型测试）：`kill-path-inventory.json` 补 voice-codex 残留回收的 4 处 kill 调用（`out-of-scope` / `qa-only`，由分类器按路径给出）；`child-process-census.json` 补 `node-runtime-closure.ts`（otool）与 `admission-residuals.ts`（ps）的同步子进程。这两条守卫在上一个 HEAD 上是红的，没被发现是因为按变更文件路径 grep 找不到全仓扫描型测试；本轮把全仓扫描型测试单独列出来跑（`evidence/v12-gbrain-removal.md`）。

## 第四次恢复（QA@3 FAIL 返工，implement attempt 2，2026-09-26）

QA@3 在 `f8e5d048` 判 FAIL：B1（生产布局 broker socket 111 字节 > 100，后台永远起不来）、H1（isolated 档同步 codesign 阻塞守护进程事件循环 34.5 s → 租约 fenced，整场失败）。plan §14.9。

| 提交 | 内容 |
|---|---|
| `76f1e1163` | B1：容器把 parent activation 根放到 `mkdtemp(realpath(/tmp)/fw-vcap-)`，登记残留目录，降级/取消/关闭都删；生产布局回归测试（先红 221 字节） |
| `1887416ad` | H1：浏览器宿主身份检查全部子进程改异步 `execFile`；事件循环心跳测试（先红）；child-process census 去掉原同步条目 |
| `7943f52a8` | 2519 browser canary 改 `await`（异步后同步调用会变成静默放行） |

| `c319bc3a3` | Lead `86cd5924`：voice parent 入口预检 broker socket 长度（共享常量，100 起 / 101 拒，拒时什么都不启动） |
| `d1400413d` | Lead `86cd5924`：虚拟时间测试——身份检查挂起期间心跳照常；守护进程 2.5 个租约周期的异步准入不被 fenced，阻塞对照被 fenced |
| `af634411d` | Codex R6 MINOR：`cleanup_pending` 两条路径都删 `/tmp` activation 根（变异验证） |

验证（定向）：voice-codex `vitest related CodexVoiceContainer.ts` 70/70；teamlead `vitest related browser-host-identity/browser-worker` 23 文件 385/385；census 1/1、kill-path 5/5；lint 0 error；teamlead 与 voice-codex 构建、依赖方 typecheck 通过；测试后 `/private/tmp/fw-vcap-*` 零残留（查出并修掉 `cleanup_pending` 用例未清理）。

续（Lead `86cd5924` 与 R6 之后）：voice-codex related（容器 + 守护进程）3 文件 112/112；teamlead `vitest related broker-socket/voice-capability-parent` 23 文件 380/381，唯一红为 `codex-lead-tui-runtime.rotation` 一例 5s 超时（该文件自 `f8e5d048` 未改，负载 108–175 下单独以 30s 超时复跑 53/53 通过，归负载）；wall-clock 守卫、census、kill-path 通过；lint 0 error；构建与依赖方 typecheck 通过；`/private/tmp/fw-vcap-*` 零残留。评审按 Lead 改走 Bridge 评审门（`request-review --type code`）。


## 第五次恢复（QA@4 FAIL 返工，claim 1656，2026-09-26）

QA@4 在 `f86fb1385` 判 FAIL：D1 后台不会用 Lead 能力、D2 结果回来整场断掉、D3 capability home 被 Codex 自装 4 个远端插件。上一具体 f14ad10b 的未交卷改动由 Lead 原样提交为 `c5f25ae33`（D2 续播 / 退役 / 重开不重跑全量自检 + 插件开关与准入校验），本体在其上续做并用真宿主探针定因（`evidence/qa4-rework/`，verification §8）。

| 提交 | 内容 |
|---|---|
| `c5f25ae33` | （接手的 WIP）cue 退役不打断、`not_live` 视为 deferred 续播、换代只核租约、`features.plugins/remote_plugin=false` + 准入校验、后台指南初版 |
| `80c6b4610` | D1：共享 `describeOperationInput` 展开判别联合（`bridge.read` 原为 `{request: any}`）；语音会话参数校验失败回有界字段提示 + 期望结构（常驻回包逐字节不变）；每次后台 `lead_operation` 记 `codex_background_lead_operation` 证据（只含 id 与 status/errorCode） |
| `98a489496` | D3：scribe home 也加 `remote_plugin = false` |

D1 根因（真宿主探针，订阅、零桩）：代理把 `lead_operation` 的 inputSchema 声明为顶层 `oneOf`，Codex 交给模型时结构丢失；无指南时模型传 `{}`，有旧指南时 `bridge.read` 被渲染成 `any`，连猜三次都只拿到裸 `invalid_operation_request`，于是说「没有查询入口」。修后首发即合法调用。读操作按设计不落 `lead_operation_receipts`（只有写才有回执），QA@4 用该表 0 行判「一次都没调用」只对写成立；读的取证改看 `codex_background_lead_operation` 证据或写操作回执。

D2 根因（真宿主对照组）：不加开关时，订阅账号会话中途自装 `openai-curated-remote` 插件，其后 `skills/list` 核验变成 `capability_skills_unverified`；换代时重跑全量自检就把这一漂移变成整场失败。修法三层：插件不许装（开关，实测生效）、换代不重跑全量自检（只核租约 + 漂移记证据）、结果遇 `not_live` 续播不丢。

验证（定向）：voice-codex `vitest related`（7 个改动文件）8 文件 191/191；teamlead `vitest related`（3 个叶子文件）29 文件 491/491 + `voice-handoff` 13/13；`pnpm lint` 退出 0；voice-codex 及依赖构建、teamlead/voice-codex 依赖方 typecheck 通过；已合入 `origin/main`（`a082f110a`）。消费者排除：`codex-home` / `session` 在 claude-runner、edge-worker、flywheel-comm 的命中是同名不同模块。完整语音会话（realtime 需 API key）、换代续播的真房复现、写操作与 founder 门归 529 房 QA。

### 续：Lead 指令 1c8019f8（founder 2026-09-26 12:19 PDT）——要不要说 + 自由口语转述

| 提交 | 内容 |
|---|---|
| `67b9ae533` | 关键事实守卫加「是否结论」极性（先认否定词再认肯定词）；`repairSpokenScript` 逐句修复：事实对不上的整句去掉、结尾改说「这条我发到 thread 了，编号以文字为准。」，不截半句；ScriptWriter 输出加 `tell` / `skipReason`（`ack_only` / `receipt_only` / `no_new_information`），事实不符改为修复而非整条拒绝；会话记她最近 10 分钟内 ≤6 句原话，消息在问她或提到她刚说过的关键事实时推翻跳过（`voice_tell_skip_overridden`），其余跳过记 `voice_tell_skipped`（原因 + 原文）；后台结果同样逐句修复，thread 贴保留的句子 + 工具原始结果，不贴被去掉的错句 |
| 本提交 | daemon 把跳过记为终态 `dropped` 回执；`rewriteSpeech` 管线类型改为 `ScriptWriterInput` |

验收用例：跳过留痕（`session.test` tell relevance 三条）、改了关键事实被抓（`spoken-script` 结论翻转 / PR 号 / 时间、`script-writer` 伪造编号整句去掉、`brain-coordinator` 保留正确句）、同事实的自由转述通过（`spoken-script`「passes a free paraphrase…」）。验证：voice-codex `vitest related`（10 个改动文件）13 文件 276/276；teamlead `voice-handoff` 13/13；lint 退出 0；voice-codex 及依赖构建、依赖方 typecheck 通过。

评审 `b5bc5d89`（@`8b3bcd4da` APPROVED，round 2）的 advisory：已修两条——报告「过没过/合没合」结论的消息机械兜底一律说（`reports_result`）；「过了十分钟 / 没过多久」等时间说法不再当结论。未修、列为 PR Follow-ups：结论极性未按主语绑定（「A 过 B 挂」可被说反）；broker 成功后解锁失败回报 unknown；残留清扫遇到坏文件整轮中止；founder-only 拒绝事件无去重；`backgroundPollAfter` 不回收已结束会话。

## 第六次恢复（QA@5 FAIL 返工，implement attempt 2，2026-09-26）

QA@5（`b6dd7e58f`）：B1 真 scribe 对纯回执给 `spoken:""`（6/6），解析器拒收，准入自检「准备好了。」7/9 降级；B2 后台读成功后事件循环同步阻塞 13 s、租约 fenced；M1 thread 贴空串。

- B1：`tell=false` 允许空稿（`tell=true` 仍须非空）；被兜底推翻的空稿走「原文发 thread + 指针句」；提示词写明跳过时 spoken 为空。真模型复测三种输入形状全部可解析（`evidence/qa5-rework/scribe-shape-probe.txt`）。
- B2：根因是守卫的 `hasTokenBoundaries` 每个匹配都 `Array.from` 整段文本，几百 KB 的 `github.pr.view` 结果进 sources 后变平方（436901 字节 >300 s）；改为按下标取边界字符 + 来源 token 每次修复只提取一次，52 ms（`guard-linear-time.txt`）。另把语音 parent 的 `codex --version` 改异步（负载下同步 4.5 s），子进程清册删去过期条目。仍为同步、未改的常驻共用调用：`node-runtime-closure` 的 `otool`、`deployment.ts` 等（parent 启动期）。
- M1：失败的 `lead_operation` 回包也作来源；修复后无可核对内容且无工具文字时，不发空帖、不说「发到 thread 了」，改说「这件我没拿到能核对的结果，你再说一下编号，我重新查。」；发帖处加空串兜底。

验证（定向）：voice-codex `vitest related`（5 个改动文件）8 文件 196/196；teamlead `voice-capability-parent` 6/6、子进程清册守卫 1/1；lint 0；构建与依赖方 typecheck 通过。QA 记录的房缺口（`cosContext.memoryPaths` 未建、取上下文 2 s 超时）为 main 既有代码，不在本单。

评审 `7c9f7dbf`（@`217bd43a2` APPROVED，round 4）新增 MEDIUM「被推翻的空稿跳过在来源无单号时静默丢失」：已修（推翻后空稿一律走原文发 thread + 指针句），用例「构建失败了，看 thread。」先红后绿。LOW「子进程清册守卫首跑失败」：本机复现一次，耗时 5132 ms 正好越过 vitest 默认 5 s 超时，随后 4/4 通过；判为负载下超时（宿主 load 见提交时 `uptime`），守卫本身未改。其余 advisory 同上一轮，仍为 Follow-ups。
