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
- plan 批准后的实现、R2/R3 修正、QA flag rework 和本轮 Lead 必修项都没有冒充原设计批准内容：每个移动后的 code head 均进入 scoped code review；最终 literal-last head 仍需 R6 重新绑定。R6 未返回前，不把 R5 旧头 approval 当作当前头证据。
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
