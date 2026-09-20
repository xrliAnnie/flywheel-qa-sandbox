# FLY-2653 Raya 割接工具缺口 — 实施计划
Issue: FLY-2653 (https://linear.app/geoforge3d/issue/FLY-2653/raya割接工具缺口-旧壳-brain-在-p3-之前自己死了-标准-lead-已在线-班车-prestop-永远-validation)
日期: 2026-09-18
基于: exploration.md, research.md, runbook.md

**Status**: codex-approved（2026-09-18 14:29 PT，HIGH 已收口；MEDIUM/LOW 进入 PR Follow-ups）
**实现范围**: 三处最小行为改动；§1–§8 保留为重开前的审计历史，若与 §0 冲突，以 §0 为准

## 0. 实施修订（取代原“零代码”结论）

founder 2026-09-18 14:04–14:05 PT 要求 Raya 换代尽快推进；Lead 指令
`b43dcb88-c876-45fc-bab3-9ee13ea36091` 与
`1ca4a8fb-d3d2-46cb-a26d-814f8c0a9c03` 明确取代本计划原先的“零代码”和
“urgent wake 跳过 Raya”结论。实现仍保持 fail-closed、无生产写入、无
`request-restart`，范围锁为以下三项。

### 0.1 一次性换代：授权 target 只须是当前 main 的祖先

- 修改 `scripts/lib/updater-raya-deploy.sh` 的 `raya_prestop_prepare`。
- bounded fetch 后，要求 `manifest.target_raya_sha` 是 `origin/main` 的祖先；不再要求二者相等。
- scratch build、candidate、persona 校验、manifest `.raya_sha`、生产 checkout ff 仍全部使用授权时的 `manifest.target_raya_sha`。后来合入的 summary commit 不搭车进入一次性换代。
- `origin/main` 被改写到不含授权 target 的历史时仍拒绝，且发生在 build、ff、legacy quiesce 之前。

### 0.2 standard-update：origin/main 是部署目标，账本 target 不再是授权闸

- 删除 `raya_prepare_source` 的 standard-update `origin/main == manifest.target_raya_sha` 检查。
- 保留现有 `RAYA_CHECKOUT_BEFORE` 是 `origin/main` 祖先的 fast-forward 守卫、`merge --ff-only` 和 HEAD 读回。
- 在 checkout ff / install / build / business projection 之前先校验当前 Flywheel SHA 与 canonical manifest digest 仍等于 standard-update 账本冻结的 `target_flywheel_sha / target_manifest_digest`；build 后、projection 前再读回一次，漂移即零 projection 失败。
- 成功后的 P2→P5 transform 把实际 `RAYA_TARGET`（刚 fetch 的 `origin/main`）同时写入 `.target_raya_sha` 与 `.raya_sha`；两者在 standard-update 中都是本次实际部署 SHA 的回执，不是授权。
- legacy-stop canonical 授权行完全不改，只服务一次性换代；不新增任何日常 Raya 部署授权机制。

### 0.3 成功的 urgent deploy：复用同一个幂等 Raya pass

- 修改 `scripts/update-flywheel.sh` 的 wake 分支：`scheduled` 保持现状；`urgent` **仅当** `UPDATER_CYCLE_RESULT == urgent_deployed` 时，经过同一个 `raya_host_capable` 守卫后调用 `updater_raya_pass`；`unknown` 继续 fail closed。
- invalid token、claim 失败、fetch / ancestry 不确定、bounded runner 缺失、urgent deploy 失败都保持 Raya 零调用；这些轮次的 `RAYA_DEPLOY_STATE` 仍是 `not_run`，`updater_observation_record_raya` 将其记为 `skipped / wake-out-of-scope`。
- 不改变 Flywheel 主部署顺序：`updater_run_launchd_then_cycle` 先执行 Flywheel fetch/deploy/restart，返回后才进入 Raya 分支。但 updater 在进程启动时已 source 函数，**部署本 PR 的那一轮仍执行旧函数体**；必须在部署完成后再触发一次 updater，第二轮才会执行新逻辑。
- 不给 urgent 添加特殊的账本写路径；无 migration ledger / 非待办态仍由现有 `updater_raya_pass` 返回幂等 no-op / current 状态。

### 0.4 TDD 与验证

1. `scripts/__tests__/raya-prestop.test.sh`
   - RED：授权 target 后又多一个 summary commit 时，一次性 prestop 应成功且最终 checkout / business candidate 仍绑定授权 target。
   - 把现有 `target-mismatch` 改成真正的分叉历史；断言 remote main 与授权 target 分叉时在 build / stop / ff 前失败，避免因 build stub 路径不匹配而假绿。
2. `scripts/__tests__/updater-raya-deploy.test.sh`
   - RED：standard-update 的 ledger target 落后 remote main 一个 summary commit 时，应部署 remote main，并把实际 SHA同时写入 `.target_raya_sha` 与 `.raya_sha`。
   - RED：standard-update P2 的 Flywheel / manifest pin 已过期且 Raya main 同时前进时，必须在 checkout ff、install/build、business projection 与 Lead lifecycle 之前失败，账本与指针不变。
   - RED：当前 checkout 不是 remote main 祖先时仍失败，且不执行 install / materialize / Lead lifecycle。
3. `scripts/__tests__/update-flywheel-sources.test.sh`
   - RED：有效 urgent ticket 得到 `urgent_deployed` 后恰好调用一次 Raya pass；用真实 production `updater_raya_pass` 定义证明无 ledger 时是 `not_configured / migration-ledger-absent` 且零 lock / receipt 副作用。
   - 保留 urgent deploy 失败、invalid、claim 失败、fetch 不确定、bounded runner 缺失、ancestry 不确定六条零调用断言；只有现有 `urgent batch claims before one deploy` 的 Raya 预期从 0 改成 1。
   - RED：unknown wake 仍零调用；host capability 缺席仍零调用；被跳过 urgent 的观测 reason 是 `wake-out-of-scope`。
4. GREEN：只改上述两个 shell 实现文件；依次跑三个 focused shell suites，再跑 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与 CI 注册的 shell suites。

### 0.5 明确不做

- 不写 `~/.flywheel/raya/`、生产 manifest、Raya workspace 或 `identity.md`。
- 不发 `request-restart`，不手动 kickstart updater，不 dispatch QA，不 merge / deploy。
- 不改授权消息格式、不放宽 legacy owner / persona / quiet-window / canonical manifest / fast-forward 守卫。
- 不把一次性换代的授权 target 自动提升为最新 main；该删除由 FLY-2747 另行处理。

## 1. 目标

FLY-2653 记的两道守卫（旧壳自死 ⇒ prestop 失败；cursor 已存在 ⇒ init 拒）已由 FLY-2657（PR #1241，`9e6282830`）修复并随 `bd2fc7dfe` 部署到生产。本单不重复设计。本单交付：

1. 审计与覆盖映射（exploration §2、research §2–§3）——证明两条期望逐条有代码、有测试、有生产 dist。
2. 生产恢复 runbook（`runbook.md`）——给 Lead 逐字可执行的三件运维动作与前置读数。
3. 本次审计新发现的第三道闸（persona 占位过期）与 target 易碎性——写进 runbook，不改代码。
4. 验收项（§4）与建议后续（§5）。

## 2. 为什么不在本单改代码

> 历史结论，已被 §0 的 founder / Lead 新指令取代；本节不再作为执行指令。

- founder 2026-09-16 17:30Z「不开新活」；本单本身是记账单。
- 今晚 00:00 PT 的 scheduled 班车就是首趟割接。此刻改 `scripts/lib/updater-raya-deploy.sh` 等于在割接当晚动割接代码，任何回归的代价是再等 12 小时并可能重新要授权行。
- 残留缺口（§5）都是可观测性 / 早失败，不是割接能否完成的必要条件；runbook 已用人工核对替代它们。

## 3. 下游节点须知

> **已作废：**原结论是 implement 节点无代码可写、按 docs-only 结束。§0 已把当前执行范围改为三处最小行为改动及其回归测试；QA 应按 §0.4 的当前范围验收。生产验收仍按 §4 由 Lead 在割接后读回。

## 4. 验收项

文档验收（本节点）：

| # | 判据 | 证据 |
|---|---|---|
| D1 | 覆盖映射里每条 FLY-2653 期望都指到 main 上的 file:line | exploration §2 |
| D2 | runbook 每条前置都附只读生产读数与采集时间 | runbook §1 |
| D3 | 「谁跑 P2→P7」给出 file:line，且与 FLY-913 护栏不冲突 | runbook §4、research §1 |
| D4 | runner 未对生产做任何写操作 | runbook §6 |

生产验收（割接后由 Lead 读回，不属于本节点）：

| # | 时点 | 判据 |
|---|---|---|
| P-a | init 后 | 账本 `target_raya_sha=90e433e87a68…`、授权行 `cutover=90e433e8`、`evidence_message_id=1549915003895947318`、`cursor.status="preexisting"`、brain `{loaded:false,pid:null}`、voice `{loaded:true,pid:null}` |
| P-b | 首趟班车后 | `checkpoint=P5`；两个 owner 的 `stop_started_at_ms / disabled_at_ms / stopped_at_ms` 齐；`launchctl print-disabled` 两个旧 label 均 disabled；warning alert `raya-legacy-owner-already-exited` 各一条；生产 checkout HEAD=`90e433e8…`；`verify --stage live` PASS 且 Lead pid 已换；`business/current` 指向 `…/versions/90e433e8…` |
| P-c | proof + 再下一班后 | `deploy-receipt.json`：`schemaVersion:2`、`carrier:"standard-lead"`、`outcome:"deployed"`、`deployed_sha=90e433e8…`；`~/.flywheel/raya/deployed-sha` 前移 |
| P-d | 反证 | 任一班若仍 `prestop-validation-failed`：先读生产 checkout HEAD 判断自己在 ff 之前还是之后（runbook §5），再按 research §3 的子检查顺序逐项只读排查——ff 前先看 `origin/main` 是否漂移、persona 摘要；ff 后先看频道是否安静、candidate 摘要 |

## 5. 建议后续（不开单、不进本单；Lead 已记账，割接跑完后再定）

> 历史 follow-up 表，写于 §0 修订之前；其中与 §0.1–§0.3 冲突的句子已被当前实现取代，不再约束本次执行。

| 编号 | 内容 | 不变量 |
|---|---|---|
| (a) | `raya_prestop_prepare` 失败时带子原因：`RAYA_DEPLOY_DETAIL=prestop-<reason>`（如 `prestop-target-drift`、`prestop-persona-stale`、`prestop-legacy-owner`、`prestop-channel-active`），同步 FLY-2669 的 per-unit 观测 | 纯可观测性；不放宽、不重排任何闸；`prestop-failed` state 与「旧壳零变更」语义不变；detail 取值用封闭枚举，不拼接外部输入 |
| (b) | `init --resume-from-failed`（及普通 init）预检：工作区 persona 占位摘要 == `git show <target>:.lead/raya/identity.md` 摘要，不等则以具名错误 `persona-placeholder-stale` 早失败；另加一条**仅诊断用**的本地快照比对（本地 tracking ref `origin/main` ≠ target ⇒ `target-not-local-origin-main`），init 不 fetch | 只读预检，零写；失败时账本字节不变；不替操作者自动重投影 persona（那是授权范围内的人工动作）；本地快照既可能落后也不证明远端未前进。旧文所称 prestop “严格相等不得放宽”已被 §0.1 的祖先守卫取代；bounded fetch 后的祖先检查仍是远端权威。persona projector 已 opt-in 时该预检须改为核 projector 的授权 pin |

两条都应单独走一轮 Codex 设计评审，因为它们触及割接关键路径。

## 6. 风险与边界

| 风险 | 处置 |
|---|---|
| Raya `origin/main` 在首趟班车 ff 前漂移（10+ open summary PR） | 旧处置“重新要授权行”已被 §0.1 取代：只要授权 target 仍是当前 main 的祖先且不早于生产 checkout，就继续部署授权 target；分叉或回退仍 fail closed |
| persona 提前重投影后标准 Lead 意外重启，读到新 persona 而 cos 包未到 | 贴着班车做；新 persona 依赖的 Bridge 工具已随 #1254 上线，非崩溃级；留 `.bak` 可撤 |
| 已部署的 persona projector（FLY-2696）在 P4b 受控重启时运行 | 生产只读核实为休眠（无 contract、无 enrollment/activation marker ⇒ `skipped/not_enrolled`，不写文件）；runbook §1 #15 明示 P5 之前不得加 `personaProjection`、不得创建 marker，否则手工 persona 步骤作废 |
| `prestop-failed` 在 ff 前后长得一样 | runbook §5 拆成两行，用生产 checkout HEAD 区分；ff 后禁止 reset，只能等下一班 |
| 班车取快照时 urgent token 目录非空 ⇒ 该轮算 urgent、不跑 raya 段 | runbook §1 #14 改为时点条件；不盲删 token；班车后先读日志 `wake=` 再判断 |
| quiet15m：founder 在班车前后于 #raya 说话 | 提醒 founder。第一次 quiet-check（ff 前）失败：旧 owner 与生产 checkout 均零变更；第二次（ff 后）失败：旧 owner 零变更，但 checkout 已在 target，禁止 reset（runbook §5）。两种都等下一班 |
| quiesce 之后再跑 init | 会被 `migration-already-initialized` 拒；runbook §5 明示只能向前 |
| 本设计的诚实边界 | 不保证今晚割接成功；只保证 Lead 手里的命令与前置清单与 main 上的代码逐行对得上，且每个已知失败点都有只读判据 |

## 7. 评审轨迹与 Lead 裁定

| 轮 | Codex 结论 | 条数 | 要点 | 处置 |
|---|---|---|---|---|
| R1 | CHANGES REQUESTED | 6（1 BLOCKER） | 漏掉已部署的 persona projector（FLY-2696）；persona 备份命令会覆盖回退点；缺 ff 后 / quiesce 前的回退行；dry-run nudge 实为两次；argv[0] 只比 basename；follow-up (b) 的 target 检查只是本地快照 | 全部接受，文档修正；projector 经只读核实为休眠 |
| R2 | CHANGES REQUESTED | 3 | ff 后语义未传播到 research/plan；runbook 入口仍要求重做已执行的 init/persona；projector stop line 条件写错 | 全部接受 |
| R3 | CHANGES REQUESTED | 2 | 班车取快照时 urgent token 目录必须为空（时点条件）；target 漂移行「零副作用」过绝对 | 全部接受 |
| R4 | **APPROVED** | 0 | Lead 批准的窄确认轮，只核 R3 两条 | — |

以下是 §0 修订前的历史评审结论：三轮里 Codex 都认可当时的「零代码」范围与 FLY-2657 覆盖结论；所有意见都是 runbook / 文档的事实精度。Lead 当时裁定：(1) 选 A，本单零代码，先交 runbook 再写设计文档；(2) follow-up (a)(b) 只登记、不开单、不进本单，割接跑完后再定；(3) R3 后批一轮窄确认轮，过了即 leadAcceptance。该裁定随后被 §0 记录的 founder / Lead 新指令取代。

## 8. 文档清单

`exploration.md`、`research.md`、`plan.md`、`runbook.md`、`founder-design.html`（+ `diagrams/*.mmd`）、`progress.md`。
