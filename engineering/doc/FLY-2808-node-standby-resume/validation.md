# FLY-2808 全节点退下与原会话拉起 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-23
基于: plan.md

## 当前交付边界

Lead 以 `[lead-instruction 3ee3f5da-9019-4fbe-8b2d-c6270a9b7308]` 授权在本单完成设计中 N2–N5 的默认关闭实现。当前分支交付 process-body 生命周期、Claude/Codex 精确原会话恢复、恢复失败兜底和预算分账、死亡消费者 guards、founder 三态投影及定向测试；`FLYWHEEL_NODE_STANDBY_RESUME` 默认关闭。

以下都是本机源码证据，不是 exact-head full CI、真实服务重启、真实 Claude/Codex 长会话、浏览器 QA、生产启用或部署证据。本节点没有派 QA、merge 或 deploy。

## TDD 与定向验证

| 范围 | 命令/结果 | 结论 |
|---|---|---|
| teamlead 新合同 | StateStore/process-body、resume/fallback、rework coordinator、Heartbeat、pane-loss、reowner、founder display 等精确测试：219 PASS | 新增正负路径绿 |
| adapter | `vitest related` 覆盖 TmuxAdapter、CodexTmuxAdapter、daemon client/runtime：600 PASS，2 个依赖真实环境的既有用例 SKIP | 两 vendor 精确 ID/model/cwd、严格恢复与 manifest 合同绿 |
| edge-worker | `vitest related src/Blueprint.ts --run`：346 PASS | launch context、原工作树复用与 retirement approval 传递绿 |
| core | `vitest related src/adapter-types.ts --run`：23 PASS，2 个既有 terminal 环境用例 SKIP | 共用 adapter 类型合同绿 |
| flywheel-comm | recipient 精确测试及 related：17 PASS | standby 非终态收件语义绿 |
| 本轮发现的 legacy migration | `StateStore.workflow-rework.test.ts` 精确 migration 用例：1 PASS | 重建 runtime 表前移除依赖 trigger，rename 后恢复 |
| 本轮发现的既有故障预算回归 | `StateStore.fly1385-dead-exec.test.ts` 三个精确用例：3 PASS | budget 只数 `fault_replacement`；审计 `launchCount` 仍报告全部物理 launch |
| strict retention registry | `fly-2413-retention-registry.test.ts` 两个 schema 分类用例：2 PASS；两个新增 JSON 的 Biome check PASS | 新表登记为 `protectedCurrentOrReference` |
| 整单终态关闭 | `StateStore.generalized-execution.test.ts` 精确用例：1 PASS | 只有 whole-run terminal 才 close process body |
| R2 评审修正定向集 | adapter 4 文件 435 PASS；StateStore generalized 64 PASS；dead-exec 24 PASS、1 个既有 SKIP；resume coordinator 44 PASS；founder display 48 PASS；dispatcher 122 PASS | 退休批准、失败清理、resume lease、严格 Codex 身份、终态显示、CAS union 与死 body 关闭均有正负路径 |
| R3 评审修正定向集 | teamlead 4 个相关文件 260 PASS，追加 close-runner 用例后 78 PASS；edge-worker 15 PASS；Claude/Codex adapter 308 PASS，追加 Codex 用例后 134 PASS | 精确 generation/demand/owner cleanup fence、execution-wide liveness proof、launch outcome、5 分钟 lease 与 callback 隔离均有正负路径 |
| teamlead exact code-head related | `vitest related` 对当前 code head 自动选择 580 files；8206 PASS、4 个既有 SKIP、0 FAIL | `StateStore`/dispatcher/close-runner 的广泛直接依赖面全绿；这是 related，不是 full package suite 或 CI |
| 其余 owning-package related | core 23 PASS、2 个既有真实 Terminal 环境用例 SKIP；edge-worker 347 PASS；claude-runner 435 PASS、2 个既有环境用例 SKIP | changed TypeScript 的 owning-package related 全绿；仍不称 full suite 或 CI |
| QA full-CI rework 定向集 | config drift/registry/truth 113 PASS；config related 21 files / 380 PASS；teamlead 5 files / 290 PASS、1 个既有 SKIP；真实 tmux 旧红精确用例 1 PASS | `FLYWHEEL_NODE_STANDBY_RESUME` 进入统一 flag store，Claude session 目录按 plumbing 治理；fresh admission 与 rework admission 都热读同一 resolver |
| teamlead rework code-head related | `vitest related` 对 rework code head 自动选择 575 files；8083 PASS、4 个既有 SKIP、0 FAIL | flag runtime、StateStore、dispatcher、rework coordinator 与 plugin 的直接依赖面全绿；仍是 related，不是 full package suite 或 CI |
| Lead 必修 cleanup latch 返工 | 先红：activity `canResume` 仍为 true、reopen route 404、StateStore 无 reopen 方法；后绿：StateStore + route 精确 2 files / 67 PASS | `cleanup_unconfirmed` 对 founder 明确不可拉起；master-token-only 审计重开记录 actor/time/reason 并恢复独立 resume budget |
| cleanup latch code-head related | `vitest related` 自动选择 568 files；567 files / 7983 PASS、4 个既有 SKIP，`chat-thread-routes` 1 条 404 JSON 断言瞬态红；同头精确复跑该文件 68/68 PASS | 唯一红项不触及本轮 route，隔离复跑绿；如实保留 related 非全绿，不称 full suite 或 CI |
| origin/main 技术同步 | feature-flag truth/drift/registry 3 files / 113 PASS；StateStore + reopen route 2 files / 67 PASS；CodexTmuxAdapter 1 file / 134 PASS | 唯一冲突同时保留 FLY-2808 Claude session-dir 与 FLY-2766 native baseline；自动合并的 reopen/canResume/Codex strict-resume 语义未漂移 |
| QA 529 真机返工 | 先红：teamlead 精确 3 files / 5 FAIL、124 PASS；529 shell source guard 2 FAIL；后绿：同 3 files / 129 PASS，shell guard 全绿 | 首节点与 Lead retry 都按调用时 flag 纳入 standby；`process_retirement_pending` 在 QA pass、grace expiry 与终态 closeout 三条路径结算；step 4 等待 enrolled body=`standby` 且物理进程已退出 |
| QA 529 返工后技术同步 | merge 后 teamlead 同 3 files / 129 PASS；Claude/Codex adapter 2 files / 311 PASS；generalized helper shell 串行复跑全绿 | TmuxAdapter 唯一冲突同时保留 standby retirement 与 main workflow-usage import；第一次 shell 与两个 Vitest 进程并行时仅既有 detached-process reaper 时序红，同头串行复跑通过，未改无关 reaper |
| QA 529 返工复审 HIGH | 先红：StateStore generalized 2 FAIL、65 PASS；后绿：同文件 67 PASS；最终相关 6 files / 332 PASS | admission 单点把 registry alias 规范化为 canonical id；Claude `fable` 与 Codex `astra` 的旧快照都让 runtime、initial expectedModel、manifest 与 resume 比较使用同一词汇 |

最初的 teamlead related 运行在上述修正前，最终为 572 files / 8116 tests PASS、4 SKIP、6 FAIL；红项恰为 1 个 legacy migration、3 个故障替换断言和 2 个 retention registry 分类断言。这次红不是最终证据。第一轮修正后的 related 曾有一个无关 chat-thread 404 空 JSON 瞬态红，同头精确用例和 owning file 重跑均绿。R2 评审修正后为 570/570 files、8029 PASS、4 SKIP、0 FAIL；R3 修正后的当前 code head 最终为 580/580 files、8206 PASS、4 SKIP、0 FAIL。

## 构建、类型与静态检查

- exact code head 的 `pnpm --filter 'flywheel-teamlead...' build`：13 个受影响包及依赖构建通过。
- `pnpm --filter flywheel-voice-bridge build` 后，`pnpm --filter '...flywheel-core' typecheck`：9 个 core 反向依赖包通过。首轮仅因 sibling `voice-bridge/dist` 尚未生成而失败，补建该 workspace 输出后同一检查通过；不把首轮红藏掉。
- teamlead、edge-worker、claude-runner、flywheel-comm 各自 typecheck 通过。
- `pnpm lint`：退出 0，检查 5130 files；26 个 warning 均在既有 research/config/core/scripts 路径，无 error。对当前 revision 的 changed TypeScript 再跑定向 `biome check`：21 个可处理文件退出 0，仅报告 `plugin.ts` 两处既有 `let` warning；仓库默认 1 MiB 上限跳过 2.8 MiB 的 `StateStore.ts`。不为本单机械重排该巨型旧文件。
- R3 delta 的定向 `biome check` 处理 16 个文件并退出 0；仍仅有上述两处既有 warning，`StateStore.ts` 仍因仓库上限被工具明确跳过。
- QA rework 的 `pnpm --filter 'flywheel-teamlead...' build`：13 个受影响包及依赖构建通过；`pnpm --filter '...flywheel-config' typecheck`：13 个 config 反向依赖包通过。
- QA rework 后再跑 `pnpm lint`：退出 0，仍为 5130 files / 26 个既有 warning / 0 error；改动文件定向 Biome 仅保留 `plugin.ts` 两处既有 warning，`StateStore.ts` 仍因 1 MiB 上限被明确跳过。
- cleanup latch 返工后 `pnpm --filter 'flywheel-teamlead...' build`：13 个受影响包及依赖通过；`pnpm --filter '...flywheel-teamlead' typecheck`：teamlead 与反向依赖 voice-codex 通过；`pnpm lint`：退出 0，检查 5131 files，仍为 26 个既有 warning / 0 error。
- cleanup latch 4 个 changed TypeScript 的定向 Biome 退出 0：两个测试文件与 `plugin.ts` 被检查，仍仅有 `plugin.ts` 两处既有 warning；2.8 MiB 的 `StateStore.ts` 被仓库 1 MiB 上限明确跳过。
- QA 529 返工后 `pnpm --filter 'flywheel-teamlead...' build`：13 个受影响包及依赖通过；`pnpm --filter '...flywheel-teamlead' typecheck`：teamlead 与反向依赖 voice-codex 通过；`pnpm lint` 最终退出 0，检查 5134 files，保留 26 个既有 warning。首次 lint 精确指出本轮两处格式差异，按 formatter 输出收口后复跑为绿。
- merge `origin/main` 后再次执行同一 13-package build、teamlead 反向依赖 typecheck、claude-runner typecheck 与 `pnpm lint`，均退出 0；lint 检查 5155 files，仍只报告 26 个既有 warning。
- 复审 HIGH 修正后再次执行同一 13-package build、teamlead 反向依赖 typecheck 与 5155-file `pnpm lint`，均退出 0；仍只报告相同 26 个既有 warning。
- `git diff --check`：当前通过，final exact head 再复核；没有添加依赖或秘密。

## 消费者发现与取舍

按角色要求，对每个改动源码分别以完整路径、文件名、父目录执行 `git grep -lF`。命中数（完整路径/文件名/父目录）如下：

| 源文件 | 命中数 | 保留的实际消费者 |
|---|---:|---|
| CodexTmuxAdapter | 53/158/210 | runner tests、Blueprint/dispatcher |
| TmuxAdapter | 79/296/210 | runner tests、Blueprint/dispatcher |
| codex-daemon-client | 23/63/210 | Codex adapter/runtime 与直接测试 |
| codex-daemon-goal-runtime | 4/27/210 | Codex adapter 与直接测试 |
| core adapter-types | 44/66/130 | adapters、Blueprint、dispatch context |
| Blueprint | 196/426/294 | edge-worker tests、teamlead launch paths |
| HeartbeatService | 54/167/1383 | Bridge wiring、直接/parked tests |
| StateStore | 289/841/1383 | workflow dispatcher/rework/display/guards 与直接 tests |
| close-runner | 26/100/978 | plugin cleanup wiring、lifecycle 关闭与直接 tests |
| codex-session-reown | 15/35/978 | plugin wiring、直接 tests |
| issue-display-refresher | 16/55/978 | plugin refresh 与 display tests |
| issue-display | 9/36/978 | title/tools/refresher 与直接 tests |
| issue-title-state | 1/2/978 | plugin title refresh 与 tests |
| pane-loss-reconcile | 2/8/978 | plugin lifecycle sweep 与直接 tests |
| plugin | 254/1049/978 | Bridge bootstrap/runtime tests |
| retry-dispatcher | 18/45/978 | run/workflow dispatch paths |
| run-dispatcher | 39/187/978 | plugin、retry、prebound tests |
| tools | 39/137/978 | Bridge API/status tests |
| workflow-engine-dispatcher | 34/169/978 | plugin、engine transition tests |
| workflow-rework-coordinator | 14/63/978 | plugin、rework e2e/直接 tests |
| workflow-worktree-readiness | 1/1/978 | resume coordinator 的 worktree 校验 |
| config feature-flag registry | 105/364/164 | flag truth/store policy、Bridge flag runtime 与 config tests |
| config feature-flag store-policy | 10/41/164 | flag runtime、resolve/authoring policy 与 config tests |
| config feature-flag truth | 34/123/164 | public config surface、drift/registry/truth tests |
| teamlead flag-store-runtime | 18/40/978 | plugin 两个 admission path 与 flag runtime tests |

R3 同时对 7 个改动测试文件执行同样三种搜索，命中数依次为：Codex adapter test 15/37/95、Tmux adapter test 25/82/95、Blueprint worktree test 2/5/87、StateStore generalized test 3/15/317、close-runner test 9/28/317、run-dispatcher test 7/16/317、rework coordinator test 4/15/157。它们本身已全部保留执行；文件名/父目录命中的其它同包测试由 owning-package related 覆盖。

QA rework 对全部 14 个 changed TypeScript 再执行三种搜索。新增源码命中数为 registry 105/364/164、store-policy 10/41/164、truth 34/123/164、flag-store-runtime 18/40/978；既有 StateStore/plugin/dispatcher/coordinator 的新计数见上表。6 个改动测试文件依次为 feature-flags drift 18/57/76、registry test 8/34/76、flag-truth 5/19/76、StateStore dead-exec 1/11/317、StateStore generalized 3/15/317、flag-store-runtime test 8/18/157。所有实际运行时消费者与 owning-package related 均保留；文档、fixture、同名跨包文件继续按下述规则排除。

cleanup latch 返工再次覆盖 StateStore 289/841/1383、plugin 254/1049/978、StateStore generalized test 3/15/317；新建 route test 的内容搜索为 0/0/317，完整路径和文件名没有任何引用，父目录命中按同一排除规则审计。实际运行时消费者与新测试均由精确测试和 owning-package related 保留。

本次 QA 529 返工对三种 park reason 做了全仓精确字面值搜索（排除 `.git`、`node_modules` 与生成的 `dist`）。生产消费者完整清单如下；没有其它运行时代码按这些字面值分支：

| 位置 | 消费语义 | 本轮处理 |
|---|---|---|
| `StateStore.ts:1223-1235` | settlement reason 类型、replacement settlement 集、terminal settlement 集 | 两个应结算集合都纳入 `process_retirement_pending` |
| `StateStore.ts:27701-27703` | `settleWorkflowEngineParksForRunTx` 输入 allowlist | 接受 `process_retirement_pending` |
| `StateStore.ts:47382-47383` | verdict-pass 释放 resident hold | 与 `rework_reachable_wait` 同路径释放 |
| `StateStore.ts:47463` | ship-gate hold 特例 | 只消费 `runner_ship_gate_wait`，不应扩大 |
| `StateStore.ts:47696` | resident-expiry 的 ship-gate veto | 只消费 `runner_ship_gate_wait`，不应扩大 |
| `StateStore.ts:47717-47718` | resident-expiry session 已结算判断 | 接受 `process_retirement_pending` |
| `StateStore.ts:47744-47745` | resident-expiry park clear | 接受 `process_retirement_pending` |
| `StateStore.ts:60208-60211` | 三种 park reason 的唯一生产选择 | 生产点，无消费改动 |
| `qa-529-generalized-e2e.mjs:893-895` | 真机 step 4 的 enrolled standby 断言 | 要求 retirement reason、body standby、进程 dead |

其余精确字面命中全为测试/fixture：`fly2478-resident-release.test.ts` 覆盖 pass、timeout、terminal 三种结算；`question-admission.test.ts`、`StateStore.generalized-execution.test.ts`、`StateStore.workflow-engine-transition.test.ts`、`workflow-engine-dispatcher.test.ts` 保留既有 rework/ship fixture；`test-deploy-generalized.test.sh` 固定 529 step 4 源码合同。文档中仅有 FLY-2027 历史风险描述，不是运行时消费者。

本轮每个非文档改动文件也分别执行完整路径/文件名/父目录三种 `git grep -lF`：StateStore 289/842/1394、resident-release test 0/5/317、actions retry test 1/8/157、runs-route test 5/26/157、actions 58/252/984、plugin 255/1055/984、runs-route 52/240/984、529 shell test 30/46/844、529 driver 32/47/3333。三份改动测试和 shell test 全部直接运行；四个 production TypeScript 的实际消费者由点名路由/StateStore 测试与 typecheck/build 保留；529 driver 由其 source-contract shell test 和 `node --check` 保留。其余命中逐项归入前述明确排除类：历史文档/fixture 只引用路径或文件名、其它 package 的同名文件、父目录下不引用该文件的兄弟模块；这些不是调用关系，未据此扩大成本到整包测试。

复审 HIGH 的两个改动文件重新执行三种搜索：StateStore 294/849/1401、StateStore generalized test 3/15/318。前者的真实 runtime 消费者由 dispatch-resolution、engine-dispatcher、首节点/retry 与 StateStore 精确测试覆盖，测试文件本身直接执行；其余仍按同一文档/fixture/同名/兄弟模块规则排除。

排除项逐类说明：所有 `doc/**`、`engineering/doc/**`、`product/doc/**` 命中都是历史设计/调研引用；generated child-process census/inventory 是快照清单；同名 `plugin.ts`/`tools.ts`/`*.test.ts` 但路径不在 owning package 的命中属于其它模块；只复述文件名的 fixture/文档不形成调用关系。比如 `StateStore.ts` 的 289 个完整路径命中中，23 个位于 `packages/**`/`scripts/**`，至少 265 个位于上述文档树，后者全部排除。真正的运行时命中、直接依赖测试、新增测试和 changed TypeScript owning-package related 均保留执行；三种搜索的每个其余命中都由上述路径规则覆盖，没有把历史文本命中误算成需执行测试。

## 设计、HTML 与评审沿革

- 设计 R2 gate `d0cf1a21-fa94-4d23-9663-63df581f0d15` / request `1f35923f-ea52-4f3b-8e4b-53650e105e75`：当时冻结的设计 plan effective `APPROVED`；3 MEDIUM + 2 LOW 非阻塞建议在 follow-ups.md 有 disposition。Lead 授权实施后追加的状态与落地记录不冒充原设计摘要，随当前 exact-head code review 一并审阅。
- 浅色 design.html 已静默发布到 <https://fw-reports-356a6d.vercel.app/r/26fd140eb5edba1cbc40ad3555a79561/>；publish receipt 证明 hosted source/nonce/无外部资源，但不冒充真实浏览器视觉/CSP QA。
- 本地 Mermaid 四次均因 Chromium MachPort sandbox permission 在启动前失败，保留 `.mmd` 源与明确 pending 标识；未使用远程渲染、未冒领图形完成。
- 旧 docs-only code review 已被后续实现头替代；完成本地验证和 literal-last milestone 后必须对新的 exact head 重新请求有效 code review。
- 实现 code review R2 gate `0afda40e-8a35-4302-bbb2-7e6687293f06` 在旧 head `3f03ea22` 返回 `CHANGES_REQUESTED`。3 个 HIGH 已修：恢复不再重建/重置共享工作树；失败/超时会先清理已启动进程且清理未确认时禁止重试/兜底；`resuming` 增加 180 秒 lease 与过期接管。MEDIUM 也已修：只有 controller 批准的 retiring generation 才按主动退休投影、终态压过 working、Codex strict identity 只作用于 standby resume 且错误不再被吞、StateStore CAS 失败返回 union、Claude manifest git 探测异步化、dead enrolled body 同事务关闭。需以新 exact head 再审。
- 实现 code review R3 在旧 head `09d931b99` 再次返回 `CHANGES_REQUESTED`。当前修正不用终态 `closeRunner` 粗粒度清理恢复失败，而以 process generation/demand/owner 三重 fence 授权物理 cleanup，保留 lifecycle/CommDB 记录，并以 execution-wide liveness 证明后才允许重试；resume 同时观察物理 launch outcome，确定未启动时不误清理。lease 已增至 5 分钟，超过 180 秒身份超时；Claude/Codex 的 `onRetired` observer 异常也不再改写已成功的启动结果。需以新的 literal-last exact head 再审。
- 实现 code review R4 对 exact head `a351d044b` effective `APPROVED`，带 1 个 MEDIUM 与 1 个 LOW advisory；见 follow-ups.md。随后 QA 在同头发起 full exact-head CI run `35862850957`：多数矩阵绿色，但 teamlead shard 1 的真实 tmux 一秒退出码用例、light unit 的 feature-flag drift、script suite E 的 load-probe positive control 三处失败，因此 `CI OK` 为红，不能作为全量通过证据。QA 按 workflow 将 TURN 退回 implement。
- rework 修复其中唯一可归因回归：`FLYWHEEL_NODE_STANDBY_RESUME` 作为 default-off opt-in feature 正式注册、使用统一 codec 与 named flag-store resolver；fresh/rework admission 都通过同一 call-time boolean 接线，`FLYWHEEL_CLAUDE_SESSION_DIR` 则以路径 plumbing 登记。真实 tmux 旧红精确重跑通过；未改动的 load-probe 在本机因宿主进程身份条件出现多处不同失败并超出正常时长，终止该诊断 run，未修改无关脚本。新头必须重新 code review，再由 QA 冻结并运行新的 full exact-head CI。
- 实现 code review R5 gate `14b2c500-dc14-46e4-9207-826823ffa26f` / request `4480df89-00ae-4bab-aac8-aac34fd81bc5` 对 head `b39a2ea75` effective `APPROVED`，但 Lead 指令 `[lead-instruction ec413437-959a-4757-8b3a-d1d6f6e76d4d]` 将其中 `resume-cleanup-unconfirmed-permanent-latch` 明确升级为交卷前必修。当前代码让 latch 投影 `canResume=false`，新增仅 master token 可用、无 actions alias 的重开 route；事务内清 latch 为 `operator_reopened`，向既有 append-only run-event ledger 写 actor/time/reason/原预算边界，并只重置独立 resume budget，不删除旧尝试或改故障替换额度。其余 R5 MEDIUM/LOW 仍按 follow-ups.md 明示为未实施建议。
- plan 批准后的实现、R2/R3 修正、QA flag rework 和本轮 Lead 必修项都没有冒充原设计批准内容：每个移动后的 code head 均进入 scoped code review；当时的 literal-last head 仍需 R6 重新绑定，未复用 R5 旧头 approval。
- 实现 code review R6 gate `fb1e9263-bc4c-42aa-a2ec-94a773b6d6d6` / request `bcc61be3-dff2-47a3-97a6-40dba3df2f70` 对 exact head `ff72e9d8c` effective `APPROVED`，保留 follow-ups.md 已列的 1 MEDIUM + 2 LOW。随后 Lead 指令 `[lead-instruction 2af9174b-4587-4092-b339-1d1fb4fec1d6]` 指出 PR 与 main 冲突，要求技术同步后重绑评审，因此该 R6 不能作为 merge 后 head 的有效证据。
- 按指令 merge `origin/main`（`fef2dd43d`），未 rebase、未 force-push。唯一冲突 `packages/config/src/feature-flags/truth.ts` 同时保留 `FLYWHEEL_CLAUDE_SESSION_DIR` 与 main 的 `FLYWHEEL_NATIVE_SKILL_BASELINE_VERSION`；StateStore、plugin、CodexTmuxAdapter test 自动合并后逐项核对本单语义，并通过上述 314 条点名测试。merge 后 literal-last milestone head 仍需 R7 重新 review；不请求 full CI。
- QA 529 真机在旧头 `2a28fdd26` 暴露三处同因缺口：fresh 首节点与 Lead retry 未传 governed standby flag；新 reason `process_retirement_pending` 没进入既有 replacement/terminal settlement 消费者；step 4 仍以旧 actor 存活为准。本轮只补齐这三处，以精确红绿测试和上述全仓 reason 清单固定边界；新 exact head 需重新 review，并由 QA 冻结后跑 full CI 与 529 真机。
- 推送后 GitHub 将 PR 标为 conflicting；按已有 Lead 交卷规则 merge 当时 `origin/main`（6 commits），未 rebase、未 force-push。唯一冲突在 `TmuxAdapter.ts`：顺序保留本单 `retiringToStandby` 的 kill/onRetired 与 main 新增的 final workflow usage import。其余 StateStore、plugin、Codex adapter/test 自动合并后重核上述语义与点名测试；新的 literal-last head 重新 review，旧头 approval 不复用。
- 本次返工 code review round 1 gate `40109733-b033-48de-b546-71a1c2dc128a` / request `fbec17a0-fd25-4dc3-bf55-ccdb0dc980bc` 对 head `be80b3e2c` 返回 `CHANGES_REQUESTED`。唯一 HIGH `model-alias-vs-canonical-mismatch` 已以 admission 单点 canonicalization 修复并补 Claude/Codex 两个旧快照负例；2 MEDIUM + 1 LOW 按 reviewer policy 为非阻塞 advisory，disposition 见 follow-ups.md，不在本轮三条 QA 修复中扩面。修正后必须以新的 literal-last exact head 开新 review。
- 保留两个 LOW follow-up：同 worktree 串行/跨 worktree 最大 2 的调度 limiter 尚未实现；`queueMs` 仍为占位且 `totalMs` 截止身份确认，不是首个模型消费回执。默认关闭路径不因此扩大本单抽象层，交由后续单独实现/验收。

## 最终需求审计

| 原要求 | 当前源码落点 | 尚未证明 |
|---|---|---|
| 主动退下 vs 意外死亡 | process body generation/state + completion/retirement evidence；六个死亡入口读取同一事实 | 真实进程释放与资源曲线 |
| 六处打断点 | completion、rework、TURN/dispatch、recipient、Heartbeat/pane-loss/reowner/expiry、fault budget 均接线 | 真实 Bridge 重启矩阵 |
| 拉起身份/model/cwd | 两 adapter manifest + exact resume；pre/post identity；HEAD/dirty 重读提示 | 真实 provider 长会话连续性 |
| 拉不起与兜底 | 两次 resume、一次原子 fresh fallback、route/node/delivery rebind、独立 purpose；失败进程按精确 body fence 清理并证明 execution-wide death | 真实 transcript 损坏和 fallback 端到端 QA |
| founder 三态 | working/standby/problem DTO 接 title/refresher/status tool | 真实浏览器和移动端视觉 |
| 默认值与并发 | 无墙钟 TTL 与恢复/故障分账已落地；同目录串行、跨目录最多 2 仍仅是冻结设计默认值，未新增调度 limiter；`queueMs`/首模型消费 `totalMs` 仍待实现 | 后续实现单与压力/饥饿 QA |
| 默认关闭和旧 run | 仅新 admission 在 flag=1 时纳入；旧 run 维持旧语义 | 发布/回滚演练 |

最终 code review、PR checks 和 completion receipt 在 exact head 形成后记录到 PR；本文件不会把 focused/related 本地检查称为全量 CI。

## 2026-09-24 implement 3/4→4/4：退下 watchdog 与失败闩锁收口

Lead gate `d4be5c9b-e205-45e5-9f46-f14e962f0329` 明确以 `c15b085d8` + stash `d954108f` 为本轮续作基线；旧的 `2a28fdd26` complete-only 指令已被 QA 529 打回作废。本轮在 TURN epoch 12 下恢复在途改动，不 reset、不改写历史、不触碰其它 PR。

- TDD RED：Claude/Codex adapter 三个点名文件先得到 4 FAIL / 315 PASS，分别固定 controller 许可在 drain 后丢失、founder TUI 仍存活、审计 kill 被拒但精确窗口已不存在、ambient 空 grace 把默认值变为 0；StateStore 点名文件先得到 1 FAIL / 67 PASS，固定 `retirement_unconfirmed` 缺审计重开。
- TDD GREEN：adapter 三文件 319/319 PASS；StateStore + master-token-only reopen route 两文件 70/70 PASS。60 秒 grace 只从当次 execution context 读取，adapter restart 以 durable `retirement_requested_at` 续算，不新增环境变量或 truth 登记；Codex 只有最终 controller 许可、daemon drain 与精确 founder TUI 消失均成立才写退休成功。
- Founder 失败态：`retirement_unconfirmed` 与 `cleanup_unconfirmed` 都投影 `canResume=false`。master-token 审计重开保留旧 attempt，写 actor/time/reason/原 latch reason；退休发生在 demand 前时 receipt 的 `demandId=null`、旧 attempt 数为 0，新 demand 从独立 resume budget 的 attempt 1 开始。
- 直接消费者：config truth/drift/final-ledger 69 PASS；teamlead retirement/settle/dead-exec/dispatcher/gate/PR wiring 44 PASS、1 个既有 SKIP；flywheel-comm strength-two 24 PASS；Claude/Codex kill-path inventory 5 PASS；同步 timeout contract 初跑准确抓到新增 tmux probe 缺 10 秒上限，补上后与 Codex adapter 合计 141 PASS。
- Shell：flag truth 3 PASS；generalized helper 全绿；auto-approve contract PASS；QA room 19 PASS；Codex guard 49 PASS。这里没有执行 529 真 Discord N-to-N；该项仍由 QA 在冻结头补跑。
- Owning-package related：claude-runner `vitest related src/process-retirement.ts --run` 自动选择 16 files，445 PASS、2 个既有环境 SKIP；core adapter-types related 23 PASS、2 个 Terminal 环境 SKIP。`StateStore.ts` 是 2.8 MiB hub，related 会近似整包；按“本机只跑相关文件/不跑整包”约束，以本轮列出的 StateStore、route 和六个直接消费者点名文件替代，并保留这一排除理由。
- 静态/构建：core、config、claude-runner、teamlead typecheck 全绿；`pnpm --filter 'flywheel-teamlead...' build` 的 13 个包及依赖全绿；`pnpm lint` 退出 0，检查 5157 files，仅既有 warning；`git diff --check` 通过。

实现提交为 `63af1af6d`。上述均是本机定向证据，不是 exact-head full CI、真实 Discord 529、QA、部署或 ship 证据；新 literal-last 头必须通过 R8 code review 后才能 `complete --route needs_review`。

## R8 blocking findings 修正

R8 gate `1380f6b4-8d58-4af2-91ad-5bde87c126b2` / request `6f197635-0bb4-4155-b14b-d1fed92b88b3` 对 exact head `34c5cf900` 返回 `CHANGES_REQUESTED`。两条 HIGH 均确认并以 TDD 修正：

- `resume-lease-reap-without-liveness-proof`：旧行为在 5 分钟 lease 到期后直接分配下一 generation。测试先红 1 / 68；现在先把旧 attempt 标成 `resume_lease_expired` 并进入 founder `problem / canResume=false` latch，同一调用返回 `resume_lease_expired_unconfirmed`，只有 master-token 审计重开记录 actor/time/reason/旧 attempt 边界后才能起 generation 3。不会仅因 Bridge claim 超时并行拉起第二身体。
- `ledger-purpose-backfill-aborted-by-immutability-trigger`：回归测试真实建立新 trigger、模拟旧 binary 插入 ordinal 2/default purpose、再用新 binary roll-forward，先稳定红于 `workflow_side_effect_ledger identity is immutable`。现在 migration 先 drop trigger、再 backfill、最后重建 trigger，roll-forward 成功且目的回填为 `fault_replacement`。

最终 StateStore generalized + workflow ledger + reopen route 3 files / 100 PASS；rework coordinator 45 PASS；teamlead typecheck、13-package affected build、5157-file lint（既有 warning only）与 `git diff --check` 全绿。实现提交 `3f8565228`。

R8 的 2 MEDIUM + 2 LOW advisory 不阻塞本轮 gate，已逐条记入 follow-ups.md：Claude 退下证据仍以精确 tmux window absence 为界；普通 resume budget exhaustion 的更广义审计重开；completion projection 的存在/active predicate 对齐；删除 dead admission env。下一轮必须绑定新的 literal-last head，R8 旧 verdict 不复用。

## QA@2：Claude 首节点长期停在 retiring

QA@2 在旧 exact head `ffb3136a9` 的真 Discord 529 观察到 `eng_design` 首节点进入 `retiring` 后超过 28 分钟仍保持 PID/window 存活，driver 最终超时。根因不是 adapter 内的正常退休路径本身，而是两个控制面缺口叠加：`/api/runs/start` 的 DAG entry 启动没有传入 `processLifecycle`，且 Bridge 没有脱离 adapter await 生命周期、能根据 durable `retirement_requested_at` 收口超时退休的独立 reconciler。

本轮以 TDD 只修这两个边界：

- entry 路由的 Claude 用例先红于 lifecycle 未注入；现在首节点与后续 workflow-engine 启动一致地读取 process body 并传入 initial lifecycle，测试固定 `active -> retiring -> standby`。
- StateStore 用例先红于缺少到期退休工作查询；现在以参数化查询只返回 `state='retiring'` 且 `retirement_requested_at <= cutoff` 的精确 body。
- close-runner 用例先红于缺少独立 retirement cleanup；现在 reconciler 以 execution/node/process generation/请求时间四重 fence 复读 durable body，超过固定 60 秒后只清理该代精确物理进程。清理与死亡证明成功才 CAS 到 `standby`；controller fence 变化、进程仍活或死亡不可证明都写 `retirement_unconfirmed`，现有 founder projection 因而显示 `canResume=false`。
- reconciler 挂到 Bridge 既有 reconcile patrol tick，不依赖发起退休的 adapter promise 是否仍存活；adapter 先完成时该 tick 跳过，tick 先收口时 adapter callback 也因 generation/state/request fence 幂等退出。

点名最终证据：`runs-route.dag-entry.test.ts` 71 PASS；`close-runner.test.ts` 80 PASS；`StateStore.generalized-execution.test.ts` 与新增 `workflow-process-retirement.test.ts` 合计 71 PASS。changed TypeScript 的 owning-package `vitest related ... --run` 由 `StateStore.ts`/`plugin.ts` 枢纽关系扩展为 584 files、8243 PASS、4 个既有环境 SKIP、0 FAIL。该 related 选择集很宽，但仍是本地相关测试，不是 frozen exact-head full CI。

静态与构建证据：`pnpm --filter 'flywheel-teamlead...' build` 的 13 个受影响包及依赖通过；`pnpm --filter '...flywheel-teamlead' typecheck` 的 teamlead 与 voice-codex 通过；`pnpm lint` 退出 0，检查 5159 files，仅 26 个既有 warning；改动文件定向 Biome 退出 0，仍只有 `plugin.ts` 两处既有 `let` warning，2.8 MiB `StateStore.ts` 被仓库 1 MiB 上限明确跳过；`git show --check eb48567da` 通过。

本轮 9 个改动 TypeScript 逐一执行完整路径、文件名、父目录三种 `git grep -lF`。命中数（含文档 / 排除文档）为：

| 文件 | 完整路径 | 文件名 | 父目录 |
|---|---:|---:|---:|
| `StateStore.ts` | 294 / 74 | 849 / 125 | 1401 / 306 |
| `StateStore.generalized-execution.test.ts` | 3 / 0 | 15 / 1 | 318 / 82 |
| `close-runner.test.ts` | 9 / 2 | 28 / 4 | 318 / 82 |
| `workflow-process-retirement.test.ts` | 0 / 0 | 0 / 0 | 318 / 82 |
| `runs-route.dag-entry.test.ts` | 5 / 2 | 26 / 4 | 159 / 18 |
| `close-runner.ts` | 26 / 6 | 100 / 17 | 989 / 226 |
| `plugin.ts` | 255 / 78 | 1056 / 223 | 989 / 226 |
| `runs-route.ts` | 52 / 20 | 240 / 48 | 989 / 226 |
| `workflow-process-retirement.ts` | 0 / 0 | 0 / 0 | 989 / 226 |

四个点名测试文件、Bridge runtime import、StateStore 查询和 patrol wiring 均保留在点名测试、typecheck、affected build 与 related 中。其余命中全部按可执行规则排除：`engineering/doc/**`、`product/doc/**` 与历史 inventory 只复述路径；其它 package 的同名文件不是本文件消费者；父目录下没有 import 关系的兄弟模块不是调用边。新增文件的完整路径/文件名为 0 是因为生产引用使用相对 stem import，不代表未接线；其真实 import 已由 `plugin.ts`、相关测试和 typecheck 覆盖。没有排除任何实际 runtime 或 test consumer。

实现提交为 `eb48567da`。本轮没有重新跑真 Discord 529、没有请求 full CI、没有派 QA、没有 merge 或 deploy；这些仍由 QA 在新 frozen exact head 执行。

### 交卷前同步 origin/main

交卷前 fetch 发现 `origin/main` 前进到 `049fbf194`（FLY-2803 quota page），按 Lead 规则以 merge commit `423e0d7e3` 同步，未 rebase、未 force-push。唯一重叠文件为 `packages/teamlead/src/bridge/plugin.ts`，ort 自动合并；人工复核确认本单 `runWorkflowProcessRetirementTick` import、既有 reconcile patrol 调用、fail-closed `physicalGone === true` 归一化均保留，FLY-2803 的 quota-page wiring 也完整存在。

合并后只跑重叠面点名测试：本单四文件与 FLY-2803 五个 plugin 消费测试合计 9 files / 281 PASS。随后 current-head 的 13-package affected build、teamlead + voice-codex typecheck、`pnpm lint`（5165 files、26 个既有 warning、0 error）均通过。`git diff HEAD^1 HEAD --check` 只报告 main 已合入的 FLY-2803 evidence HTML 尾随空格与一个空 EOF；本单工作区 `git diff --check` 为空，未越界改写无关上游产物。

## QA claim 1475：standby 后迟到终态改写

QA 在旧 exact head `ca2ccc1c2` 的 529 stub lane 证明入口节点已经能在 62.8 秒内从 `retiring` 到 `standby`，物理进程也已消失；但 1.03 秒后的 Claude carrier `session_completed` 又把 session 从非终态 `ship_parked` 改成 `completed` 并写 `terminal_at`，因此 step 2 超时。权威 claim 为 `workflow_claims.id=1475`，终版报告为 <https://fw-reports-356a6d.vercel.app/r/dd5e1dbca5d201c49910fc279b0f06fa/>。

根因由两处共同构成：三个 process lifecycle 构造的 `retirementApproved` 只接受 `retiring`，独立 reconciler 先写 `standby` 后 Claude finally 因而把正常退休误判成普通完成；`recordEnrolledTerminalSignal` 又只保护 no-out-edge 终态，不读取同 execution 的 process body，最终接受了这条迟到完成信号。本轮只收口这两个边界：

- `isWorkflowProcessRetirementApproved` 成为 entry、后续 node 与 resume 三条路径共用的单一判定，同代 `retiring` 与已结算 `standby` 都保持批准；active 或错代继续返回 false。
- `recordEnrolledTerminalSignal` 仅在 session 为 `ship_parked` 且同 execution body 为 `retiring|standby` 时保留现状；event 与 teardown fact 仍照常写入。active body 的负例仍会进入真实 `completed`，避免把任意 ship park 变成免疫态。
- Claude/Codex 参数化用例同时固定首次迟到信号与同 event replay：session 保持 `ship_parked`、`terminal_at` 为空、body 保持 `standby`，返回 `statusPreserved=true/statusChanged=false`。

TDD RED 为 3 个精确失败：entry 在 `standby` 后 approval=false；Claude/Codex 的迟到 completion 都得到 `effectiveStatus=completed/statusChanged=true`。最小修复后四个直接回归文件最终 159/159 PASS（runs-route entry、StateStore generalized、workflow process retirement、FLY-1427 terminal immunity）。changed TypeScript owning-package `vitest related ... --run` 自动选择 571 files，8025 PASS、4 个既有环境 SKIP、0 FAIL，耗时 1432.48 秒；这是本地 related，不是 full package suite 或 frozen-head CI。

静态与构建：`pnpm --filter 'flywheel-teamlead...' build` 的 13 个包及依赖通过；`pnpm --filter '...flywheel-teamlead' typecheck` 的 teamlead 与 voice-codex 通过；`pnpm lint` 退出 0，检查 5165 files，仅 26 个既有 warning。定向 Biome 处理改动文件通过；2.8 MiB `StateStore.ts` 仍被仓库 1 MiB 上限明确跳过，`plugin.ts` 只报告既有两条 `useConst` warning。

本轮 8 个改动 TypeScript 逐一执行完整路径、文件名、父目录三种 `git grep -lF`，命中数依次为：StateStore 294/849/1405、StateStore generalized test 3/15/318、workflow process retirement test 0/1/318、runs-route entry test 5/27/159、plugin 257/1061/992、runs-route 52/241/992、workflow-engine-dispatcher 35/170/992、workflow-process-retirement 0/1/992。共享 helper 的实际 runtime consumer 完整清单为 `runs-route.ts`、`workflow-engine-dispatcher.ts`、`plugin.ts`；直接测试为 `workflow-process-retirement.test.ts`。`recordEnrolledTerminalSignal` 的 packages 内调用面为 `DirectEventSink.ts`、`event-route.ts`、workflow-engine dead-body test 及 4 个 StateStore/event route 测试，全部由点名集或 related 保留。其余每个命中均落入既有明确排除类：历史文档/fixture 只复述路径或文件名、其它 package 同名文件、父目录中无 import 的兄弟模块；没有排除实际 runtime 或 test consumer。

本轮不重跑 529、不开 full CI、不派 QA；QA 应在新的 frozen exact head 重跑 stub lane step 1–9、真实载体证据与 full CI。

## R11 HIGH：Claude resume 身份证据改为真实 SessionStart

R11 gate `e8de2bcc-5343-45aa-ac2d-94cd8ac8437b` / request `f15a301c-8f20-405e-a640-73fa7fce8d5d` 对旧 exact head `be4aa4ee2` 返回 `CHANGES_REQUESTED`。唯一 HIGH 指出 Claude resume 仍把 launch manifest 自报当成恢复后的身份验证，并在真实 Claude 会话发出首个 prompt/tool 前没有 durable gate。本轮只修该阻塞项：

- resume launch 生成 owner-only、逐 generation/launch-token 的 identity manifest，并向 Claude 注入 `SessionStart`、`UserPromptSubmit`、`PreToolUse` hooks；新 hook 从 Claude 的实际 `SessionStart` payload 读取 `source/session_id/model/cwd`，要求 `source=resume` 且四项与 manifest 完全一致，再把实际值回传本地 callback server。
- adapter 在写 launch commit 前注册精确 token/session 的 `SessionStart` observer；launch committed 不再被误判为 identity failure。观察到实际身份后才通知 coordinator，且只有 StateStore 已把同 generation 从 `resuming` 原子提交为 `active` 才写 `.verified` ack。首个 prompt 和首个 tool 在 ack 之前 fail closed；空 observer、超时、错 session/model/cwd/source 或 durable state 被抢占都会清理精确窗口并走既有失败/额度路径。
- callback contract 新增可选的实际 `model/cwd/source`；`SessionStart` 缺任何一项直接 400。新环境变量 `FLYWHEEL_RESUME_IDENTITY_MANIFEST` 仅是每次 launch 的路径 coordinate，已进入 config `NON_FLAG_ALLOWLIST`，不是 feature flag。Bridge 默认 hook 同步清单加入该脚本；本轮没有重启 Bridge。

TDD RED 先得到两个精确失败：Tmux 用例实际顺序为 `identity,commit` 而要求 `commit,identity`；HookCallbackServer 的 SessionStart 事件缺 `model/cwd/source`。GREEN 后点名结果：TmuxAdapter 181 PASS；HookCallbackServer 26 PASS；workflow resume identity helper 2 PASS；sync hooks + workflow rework coordinator 74 PASS；config truth/drift 57 PASS；shell hook success/mismatch/no-ack/ack guards 全绿。随后 changed-file owning-package `vitest related`：core 23 PASS + 2 环境 SKIP、config 328 PASS、edge-worker 26 PASS、claude-runner 446 PASS + 2 环境 SKIP、teamlead 104 files / 1203 PASS。没有新增 `scripts/__tests__/*.test.sh`；新增 hook 自测脚本已直接执行。

最终静态门禁：core 反向依赖 typecheck 选择 9 个 package（含 claude-runner、edge-worker、teamlead、voice consumers）全部通过；受影响五包及依赖 build 选择 13 个 package 全部通过；`pnpm lint` 退出 0，检查 5167 files，仅 26 个既有 warning；改动 TypeScript 定向 Biome 退出 0，仅 `plugin.ts` 两个既有 `useConst` warning；`git diff --check` 通过。

每个改动 TypeScript 均执行完整路径、文件名、父目录三种 `git grep -lF`；语义符号搜索另覆盖 `HookCallbackEvent`、`onIdentityVerificationFailed`、`resumeVerificationStatus`、manifest env、hook 文件名与 resume launch helper。实际 runtime/test consumers 已全部保留在点名、related、typecheck 与 affected build 范围。其余命中按既有可执行规则排除：历史文档/fixture 只复述路径或文件名、其它 package 同名文件、父目录中无 import 的兄弟模块；新增未 tracked helper 在首次搜索中完整路径/文件名为 0，但其 `plugin.ts` import、直接测试和 related 均已覆盖，不是未接线。

teamlead related 的既有 Bridge scaffold 会同步默认 hooks；由于新文件此前不存在，它在本机 `/Users/xiaorongli/.flywheel/hooks/` 暂时安装了 identity hook。测试结束后先核对该副本与源码 SHA-256 完全相同，再精确删除这一新增文件；没有触碰其它 hook 或重启服务。

R11 其余 MEDIUM/LOW 为非阻塞 advisory，逐项 disposition 见 follow-ups.md。本轮本地证据不等于 exact-head full CI、529 真机、QA、部署或 ship；新 literal-last head 必须重新 scoped code review，再交 QA 冻结验证。

## R12 HIGH：真实 Claude resume SessionStart 缺 model

R12 gate `7064b216-55dd-437c-8dc3-49ea7135261d` / request `611cf9db-cbf5-4c22-942e-741932d233eb` 对旧 exact head `5445d6389` 返回 `CHANGES_REQUESTED`。唯一 HIGH 以 Claude Code 2.1.281 真机证明：fresh SessionStart 有 `model`，但真实 `--resume` SessionStart 即使显式传 `--model` 也会省略该字段；旧 hook 因而必然在 callback 前以 `model_mismatch` 退出，adapter 最终只看到 180 秒 timeout。

本轮按已批准 plan §5.3 的既定 fallback 收口，不改变 controller 或额度代数：仍由真实 SessionStart 证明 `source=resume`、精确 session id 与 canonical cwd；当 payload 没有 model 时，要求 `transcript_path` 是可读 regular file、basename 精确为 `<session-id>.jsonl`，再从最后一条 assistant record 的 `.message.model` 取得可验证模型证据，与已确认 launch manifest 的 expected model 精确比较。transcript 缺失、路径/session 不匹配、JSONL 损坏、无模型记录或模型不一致都以闭集原因 exit 2，继续 fail closed；callback 仍只收到已验证的 model，因此 HookCallbackServer 与 adapter 的强校验不降级。

TDD RED：把 shell fixture 改成 reviewer 复现出的真实 resume 形状（含 transcript_path、无 model），旧 hook 立即 `FLYWHEEL_RESUME_IDENTITY_DENIED model_mismatch` / exit 2。GREEN：同 fixture 从 transcript 得到 `claude-fable-5-1` 并完成 callback/ack；错误 transcript model 与缺失 transcript 都 exit 2 且不发送 callback；UserPromptSubmit/PreToolUse 仍分别验证 no-ack fail closed 与 ack 通过。最终 `bash -n`、`shellcheck` 和直接 shell test 全绿；`pnpm lint` 退出 0，检查 5167 files、仅 26 个既有 warning；`git diff --check` 通过。

两个改动 shell 文件分别执行完整路径/文件名/父目录 `git grep -lF`，命中数为 identity hook 1/4/104、自测 0/0/104。四个真实文件名消费者为 TmuxAdapter settings、hook sync runtime、sync test 与直接 shell test，均已在本轮或 R11 exact-head 验证覆盖；其余父目录命中是同目录无引用的兄弟 hook/测试，不是调用边。没有新增 `scripts/__tests__/*.test.sh`，也没有 TypeScript/API 改动需要新的 related 或 dependent typecheck。

R12 其余 MEDIUM/LOW 按 policy 为 advisory，disposition 见 follow-ups.md。旧头自动 CI 仅得到 `CI Scope OK`，不是 full CI；新 literal-last head 仍需 R13 scoped code review，QA 才能冻结后运行 529 与 full exact-head CI。

## QA claim 1479：tmux 3.7c 缺失 target 静默回退

QA 在旧 exact head `682036f0e` 的真机 stub lane 观察到 Claude 入口节点 2/2 从 `retiring` 落到 `retirement_unconfirmed`，而同链 Codex 后续节点能正常进入 `standby`。旧头 frozen full CI run `36012630022` 为 17/17 green，但没有覆盖真实 tmux 3.7c 的 target fallback，不能反证这条运行时失败；权威 QA claim 为 `1479`。

根因是 Claude `cleanupExactWindow` 用 `tmux display-message -t <exact-target> "#{window_id}"` 判断窗口是否还在，并把“命令抛错”当成消失。tmux 3.7c 对已经不存在的 target 会以退出码 0 回退到当前窗口，因此返回另一个 window id；旧实现只看命令是否成功，最终把已消失的目标误记为 `unknown`。测试 mock 又把目标消失建模成抛错，恰好掩盖了真实语义。

Lead 指令 `[lead-instruction FLY-2808 · qa@1 FAIL 1479 返工 R1/R2/R3]` 将修复边界锁为三项：两载体共用 inventory 判据；“确认不了”保持 `retiring`，只有正向存活证据才落失败锁，且 adapter 自身 grace 与 durable 60 秒兜底分别计时；Claude watchdog 四个静默 `false` 分支补 reason code + execution id 日志。

- R1：`process-retirement.ts` 新增共用 `tmuxWindowPresence`，统一执行 `tmux list-windows -t =<session> -F "#{window_id}|#{window_name}"` 并逐行比较。window id 存在时只认 exact id，缺 id 才按 name；格式损坏或命令失败返回 `unknown`。Claude 从 exact target 提取并校验 `@<number>` 后调用 helper；Codex 删除原私有 boolean helper，改用同一个三态判据。mock 明确固定 tmux 3.7c 的真实行为：缺 target 的 `display-message` 仍 exit 0；kill 后 inventory 才移除窗口。
- R2：Claude/Codex 对 `absent` 才确认 `onRetired`，对 `present` 才调用 `onRetirementFailed`，`unknown` 两者都不调且不把 CommDB session 改成终态。兜底 reconciler 的 `physicalGone=false` 默认也保持 `retiring` 并留诊断日志；只有显式 `failureConfirmed=true` 才写 `retirement_unconfirmed`。两 adapter 的 grace 从该 adapter 首次观察批准开始计时，不再复用 durable `retirement_requested_at`；Bridge 兜底仍独立按 durable 请求时间达到 60 秒后开始巡检，之后无正向证据就继续确认而不是锁死。
- R3：`retirementGraceExpired()` 的 lifecycle/observer 缺失、controller 未批准、approval read 抛错、grace 未到四条 `false` 分支分别记录 `retirement_lifecycle_missing`、`retirement_not_approved`、`retirement_approval_unreadable`、`retirement_grace_pending`；每条带 execution id，并在单次 wait 内按 reason 去重。

TDD RED 证据：共享 helper 两用例因函数不存在 2 FAIL；Claude 三项分别红于旧 durable 时间戳只轮询 2 次即过期、inventory 不可读仍调用失败 callback、四类日志为空；Codex 红于旧时间戳在 adapter 自己的 0ms tick 即结算且 inventory 不可读仍调用失败 callback；teamlead 兜底红于 unconfirmed 仍返回 `failed=1` 并落锁。全部失败都与 R1–R3 一一对应。

GREEN 后按 Lead 点名只跑四个文件：Claude `TmuxAdapter.test.ts`、`CodexTmuxAdapter.test.ts`、`process-retirement.test.ts` 共 326 PASS；teamlead `workflow-process-retirement.test.ts` 6 PASS，总计 332 PASS。第一次完整 Claude 点名运行唯一额外红项是旧 prune mock 在 kill 后仍静态返回被删窗口；把 mock 改为真实 inventory 消失后，同一三个文件 326/326 PASS。没有运行本地全包 suite 或新的 `vitest related`。

真实 tmux 隔离探针在独立临时 socket/session 上证明：tmux `3.7c` 对已删除的 `@1` 执行旧 `display-message` 得到 `rc=0` 且输出当前 `@0`；同一时刻 `list-windows` inventory 只有 `@0`，`target_in_inventory=no`。探针结束时关闭临时 server 并删除临时目录。

静态与构建：8 个改动 TypeScript 的定向 Biome 写回 3 个格式文件后复核无诊断；Claude typecheck 首次准确抓到 precommit failure 旧 union 不接受 `present`，把该非退休错误面保守映射回 `unknown` 后 Claude 与 teamlead typecheck 均通过；`pnpm --filter 'flywheel-teamlead...' build` 的 13 个受影响包及依赖通过；`pnpm lint` 退出 0，检查 5167 files，仅 26 个既有 warning、0 error；`git diff --check` 通过。

八个改动 TypeScript 按完整路径/文件名/父目录执行 `git grep -lF`，命中数依次为：process-retirement source 0/1/215、TmuxAdapter 82/304/215、CodexTmuxAdapter 55/164/215、workflow process retirement source 0/1/992、process-retirement test 0/1/97、TmuxAdapter test 25/87/97、CodexTmuxAdapter test 15/41/97、workflow process retirement test 0/1/318。语义搜索确认 `tmuxWindowPresence` 的 runtime consumer 只有 Claude/Codex adapter，`runWorkflowProcessRetirementTick` 的 runtime consumer只有 Bridge `plugin.ts`；对应直接测试均在上述 332 条点名结果内。其余命中按执行边排除：文档/fixture/路径 registry 只复述名称；其它 package 同名文件和无 import 的目录兄弟不是消费者；父目录聚合命中不代表调用；广域 QA shell 会重跑已完整执行的 adapter 文件并附带无关 cmux/scaffold，按“只跑点名文件”约束排除。没有排除实际 runtime consumer或直接依赖测试。

本轮没有请求或运行新 exact-head full CI，没有重跑真 Discord 529，也没有派 QA、merge 或 deploy。新 literal-last exact head 必须通过 scoped code review 后才交 `needs_review`；冻结头 full CI 与真机复验仍由 QA 节点负责。

## QA claim 1479 code review HIGH：resume 启动早于 TURN

QA claim 1479 的 R1–R3 实现头 `caa176421` 在 code review gate `930926b7-8e36-45a8-afa6-a3f58157ea30` / request `1479f158-f7f1-420b-bd5b-6e4d2e4e92f9` 返回 `CHANGES_REQUESTED`。唯一 blocking HIGH `resume-spawn-before-turn-and-activation` 指出 standby resume 会先调用 `resumeStandbyActor -> startDispatcher.start` 启动物理进程，之后才 admission、签发 activation credential 与授予 TURN；而带 `processLifecycle` 的 dispatcher 路径有意跳过自身 pre-launch TURN，因此恢复体可能在仍由 QA 持 TURN 时收到完整工作 prompt。

本轮只修该 HIGH：`beginWorkflowExecutionResume` 仍是启动前的 durable reservation，但物理 `resumeStandbyActor` 延后到 `admitGeneralizedWorkflowExecution`、credential mint/rotation、`grantTurn` 与 `recordWorkflowActivationTurn` 全部成功之后；恢复身份验证成功后才激活 holder，最后才发送 wake。恢复失败会记录/清理并释放 delivery，不激活 holder、不发 wake；已按同一 source 持久化的 TURN 由下一次 reconcile 幂等复用。

TDD RED 先将既有顺序用例改为新约束，稳定得到 admission call order `16` 晚于 resume `12` 的 1 FAIL。最小重排后 `workflow-rework-coordinator.test.ts` 45/45 PASS；成功路径断言 `begin -> admission -> grant -> TURN projection -> physical resume -> resume verification -> holder activation -> wake`，失败路径断言 TURN 已先授予但 holder/wake 均未发生。teamlead typecheck、13-package affected build 与 `pnpm lint` 通过；lint 检查 5167 files、保留 26 个既有 warning、0 error；`git diff --check` 通过。

两个改动 TypeScript 按完整路径/文件名/父目录执行 `git grep -lF`：coordinator source 为 15/64/992，coordinator test 为 4/16/159。实际 runtime/type consumer 为 `plugin.ts` 与 `workflow-engine-dispatcher.ts`，由 teamlead typecheck、affected build 和 coordinator 测试覆盖；直接测试 consumer `workflow-rework.e2e.test.ts` 与 `workflow-dispatch-seams.structure.test.ts` 另跑 2 files / 15 PASS。其余命中全部是文档/成本 registry/fixture 的路径复述、同名文件或 bridge/test 目录中无 import 的兄弟模块，按执行边排除；没有排除实际 runtime consumer 或直接依赖测试。

该轮 review 的 4 个 MEDIUM 与 4 个 LOW 均为 non-blocking advisory，逐项 disposition 见 follow-ups.md；其中未知退休证据保持 `retiring` 以及四个 watchdog false 分支日志是 Lead R2/R3 的显式锁定语义，本轮没有反向扩改。新的 literal-last exact head 必须重新申请 scoped code review；本地证据不是 full CI，也没有执行 529、QA、merge、deploy 或 ship。
