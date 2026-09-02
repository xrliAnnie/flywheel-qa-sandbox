# 529 generalized-DAG 隔离房装房路书

这份路书用于在 529 slot 里重放 generalized workflow 的真实控制面：Bridge、StateStore、CommDB、Runner pane、git push、sandbox PR、QA verdict、rework wake 与 founder gate 都是真路径；默认只把模型推理替换成确定性的常驻 stub。

## 1. Quickstart

从**准备被测的 Flywheel worktree**执行，fixture 固定使用 `FLY-202`。不要先切回主仓，也不要加内联环境变量：`test-deploy.sh` 会用当前仓字节装房，并用 `--expect-head` 可选地锁定被测 commit。

```bash
scripts/test-deploy.sh 2 --generalized --stub-runner --no-lead
scripts/qa-529-generalized-e2e.mjs 2 --issue FLY-202
```

FLY-2211 的重启杀伤专项必须换成真实 Codex 房型，并且不能同时传
`--stub-runner`：

```bash
scripts/test-deploy.sh 2 --generalized --codex-runner --no-lead
scripts/qa-529-generalized-e2e.mjs 2 --issue FLY-202 --real
```

这个入口让生成的项目配置同时声明 `runners.default: codex`、可用的
`codex` runner、`roles.runner.backend: codex-tmux` 和 DAG 的
`runner: codex`。因此重启波前必须从 slot SQLite / tmux 证明确有
`adapter_type=codex-tmux` 的活工人；只看到 `runnerMode=real` 不算覆盖。
波后按专项验收继续采集 pane、rollout 写入、broker PID/启动时刻和 kill
ledger，至少观察 30 分钟。默认 Quickstart 仍保持原来的双 stub 九步回归。

第一条命令只有在以下 readiness 全部成立后才发布 mode `0600` 的 `/tmp/flywheel-test-slot-2/room-info.json`：

- `/health` 同时报 `ok=true`、`buildMode=built`，且 `buildSha` / `artifactBuildSha` 等于被测 worktree HEAD；
- slot SQLite 中 `pipeline_dag` 与 `pipeline_work_kind` 的项目行均解析为 `true`；
- `workflow_category_binding` 的 5 个 canonical mapping 全部存在且模板为 published、未 retired；
- menu 端点能解析 `code` / `generic`，`code` 含 design、implement、qa；
- slot master token 为 mode `0600`。

FLY-1808 已退役的 5 个 workflow env flag 不属于 readiness：装房脚本不再注入、断言或 attestation；generalized authority 只读 scoped flag store、engine schema 与 category bindings。

第二条命令把每一步证据原子写入 `/tmp/flywheel-test-slot-2/e2e-evidence/<runId>-<timestamp>/step-N.json`。它的退出语义是：

- step 1 认当前 `/api/runs/start` 的 `entry_kind=workflow_v2`，不会把已退役的 legacy `pipeline_dag_v1` 当成新房入口；
- design 固定为 Claude `fable`，implement 固定为 Codex，QA 沿模板默认 Claude；房内 `claude` / `codex` 双 stub 不调用真实模型，但 StateStore 的 producer / reviewer vendor 与生产拓扑一致，QA claim 不会在 `same_vendor_review` 停住。

- `0`：九步全走完；
- `20`：1–7 步已走完，第 8 步证实 F2 的 PR authority 链不完整，QA PASS 未发送；这是一份可直接开产品侧 issue 的诊断包，不是假绿，也不表示装房失败；
- `21`：某个 stub 已把 fatal 写入 `stub-state` 且当前进程死亡；driver 已先落对应 step evidence，再输出明确分类与整改建议，而不是等 15 分钟通用超时；
- 其他非零：装房、所有权、断言或基础设施失败，按错误停手。

测试结束后：

```bash
scripts/test-teardown.sh 2
```

teardown 不负责删 sandbox remote PR / branch；同一房内下一次 driver 启动时会先用上一轮 `owner.json` 证明 exact run。stub 的 design、implement 与 fixture PR 从第一笔 commit 起都使用 `qa529-<issue>-<runId>` run-scoped branch，不复用 WorktreeManager 的稳定 issue branch，因此不会接管或改写历史人工 PR；同一 run 的 implement attempt / replacement 才复用该 branch。dead-exec recovery 若在这个已证明的 run 内换体，driver 会从 `workflow_run_node` / run-scoped binding 动态吸收 replacement execution，同时保留全部历史 execution；已证明 execution 消失仍 fail-closed。active / held 轮先 terminate，已 completed / terminated 轮直接进入收敛，随后等待进程与 durable launch 全部 settled，再关闭 marker-owned、expected-head 未漂移的 PR。GitHub REST 没有 ref delete CAS；driver 不伪装 `If-Match`，而是在 durable drain 后重读 exact head、漂移即停手，再删除该 run-scoped sandbox branch。

`flywheel-comm progress` 会单独产生 progress-ledger commit。若在 `--expect-head` 锁定或房已启动后更新 ledger，`room-checkout-drift` 要求重建房是正确行为：先取最新 exact HEAD，再用新 SHA 重跑起房命令；不要跳过 drift 闸继续沿旧 checkout 演练。

### 已知代价：换 head 孤儿 sandbox PR

exact-head 闸会在被测 HEAD 变化后要求拆房重建。teardown 为了保持 fail-closed，不会猜测或批量删除 sandbox remote PR / branch；只有下一轮 driver 能凭上一轮 `owner.json`、run marker、完整 execution set 与未漂移 head 做定向收敛。若旧房已被拆掉、其 slot-local evidence 随之消失，旧 run 的 marker-owned PR 就不能再被新房安全认领，必须由操作者核对 marker 后人工清理。QA 实测换 head 留下了 sandbox PR #107、#108、#109；这是隔离房重建的已知代价，不是 `test-teardown.sh` 可以用宽匹配自动回收的对象。频繁改 HEAD 前应预期这项清理成本，正式九步复测尽量先冻结被测 SHA。

## 2. 15 条实测坑位对照

| # | 现象 | 根因 | 现在的闸 | 非 generalized 房 |
|---:|---|---|---|---|
| 1 | 从主仓起房，改动明明在被测分支却没生效 | slot 脚本和 build 字节来自命令所在 worktree | **自动**：从当前 worktree 起房；`--expect-head <40-sha>` 可在任何 mutation 前锁 HEAD；readiness 再核 `/health` 双 SHA | 仍要自己确认 cwd / HEAD |
| 2 | tmux/codex socket 报 `sun_path` 过长 | macOS Unix socket 上限约 104 bytes，长 worktree `TMPDIR` 会把路径推爆 | **自动**：generalized 子进程选短 TMPDIR；Codex stub 协议测试也固定 `/tmp` 并断言 socket bytes `<104`；安全的短 TMPDIR 原样保留 | 仍沿调用者 TMPDIR |
| 3 | slot 偷带 roundtable / cross-dept 行为 | shell 从调用环境继承 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` 与 `FLYWHEEL_ROUNDTABLE_*` 全族变量 | **自动**：单一 scrub 清单同时驱动 Bridge `env -u` 与 Lead launchd-v2 manifest 空值覆盖；生产 `.env` 新增的已知 roundtable 坐标不会只漏进一侧 | 仍按原房语义继承 |
| 4 | `set -a; source .env` 后告警全部 403 / 死信 | ambient `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 把发送链塌缩到错误 token identity | **自动**：generalized Bridge / Lead exec boundary 明确 unset；不会把生产 `.env` 热改写成修复手段 | 仍需操作者避免污染 env |
| 5 | slot 1 bot 可发告警，slot 2 bot 403 | bot 看得到频道不等于有 POST + DELETE 权限；频道邀请矩阵不完整 | **预检**：对每个配置 sender 发唯一 marker，再 DELETE；POST/DELETE 任一非 2xx 都在 readiness 前报 bot identity，且不打印 token | 仍需手工确认每个 bot 的邀请与发送/删除权 |
| 6 | 无 Runner 演练误加 `--from-branch`，以为它决定 Bridge 被测字节 | `--from-branch` 只选择 Runner sandbox clone；没有 Runner 时它没有被测对象，Bridge 始终跑脚本所在 worktree | **路书**：无 Runner 演练必须省略 `--from-branch`；只有明确要指定 Runner sandbox 基线的活体 Runner QA 才传，且仍不能把它当 Bridge source ref | 同样遵守；先按 QA 是否真的生成 Runner 判断，不要例行照抄该参数 |
| 7 | sandbox clone 偶发一直不返回 | `git clone` 可能无进度 stall，单看 wall clock 无法区分慢与死 | **自动**：按目标目录字节增长采样；停滞则杀整个 process group、删 partial clone，只重试一次 | 仍使用旧 clone 路径 |
| 8 | `--lead-label '*'` 仍然 scope 403 | label 是精确传真，不是 glob；字面 `*` 永远匹配不到真实 label | **自动/路书**：generalized 默认关闭 Bridge dept-scope reject；若显式测 scope，`--lead-label` 必须传真实 label，不能传星号 | 必须传真实 label 或按房目的配置 scope |
| 9 | `TEST_REPLY_BY_ISSUE=1` 后 API 变 401 | reply-by-issue 打开 token auth，旧 inject 脚本没带 `TEST_API_TOKEN` | **自动/预检**：generalized room 只允许本 driver，读取 mode `0600` 的 slot master token 并带 Bearer；`inject-linear-issue.sh` 会拒绝 generalized 房并指出 driver | 普通房 inject 兼容无 token / 有 token 两态 |
| 10 | Bridge 启动前报 dist / package 不存在 | 新 worktree 没装依赖，或 package build 不完整 | **预检**：错误直接给出 `pnpm install --frozen-lockfile` 和 build 指令；装房前先执行该安装 | 普通房唯一允许的行为变化也是更可执行的错误提示 |
| 11 | teardown 被 cmux maintenance lease 挡住，或每轮残留 Codex stub daemon | watcher/teardown 短时争抢同一 maintenance lease；app-server stub 不属于 tmux 子树且继承 Bridge cwd；terminal prune 后 `workflow_actor` 可能已无执行行 | **自动**：一次完整 timeout 后，从 acquisition 开始再试恰好一次；第二次仍失败才停手。清房按 exact stub argv + live socket 回收 daemon；所有权优先取 slot `workflow_actor`，并用 filename / schema / executionId 全一致的 bounded `stub-state/*.json` 补回已 prune execution，不碰并发 slot；缺 `shasum` / `lsof` 会显式告警而非静默假装回收成功 | lease retry 惠及普通房；stub reap 只命中 generalized stub |
| 12 | slot 内 launchd-v2 bootstrap Lead 失败 | 九步 engine 演练并不需要常驻 Lead，却先被 Lead bootstrap 卡住 | **路书**：九步用 `--no-lead`；step 5 的 `question` gate delivery 由 driver 以 QA execution attribution 走 CommDB 真路径，step 8 走真实 ship holder | 需要 Lead 的消息类 QA 仍应起 Lead 并修 bootstrap，不得借 `--no-lead` 假装覆盖 |
| 13 | sensor 演练“什么都没发生” | watchdog 默认 interval 不适合作为短时观测窗口 | **路书**：sensor 专项演练必须显式设置 `FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS`；它不是 generalized 九步 Quickstart 的隐式环境要求 | sensor 单同样必须显式设置并在证据中记录值 |
| 14 | QA PASS 后 409 `land_head_unavailable` | QA execution 无可信 worktree / PR identity；producer session、`workflow_node_pr_binding`、remote PR head 任一断链都不能铸 gate authority | **预检 + 诊断**：driver 发 PASS 前检查四段链；缺项则永不写 release，落 `step-8.json`、预测 server reason、退出 20。机制修复属于 FLY-1768 F2 后续，不在本单伪造 binding | 手工 verdict 也不得绕过；必须修产品侧身份传播 |
| 15 | step 2 静默超时、design 永远 `running` | 沙箱 main 已有与旧 stub 逐字节相同的 design fixture，提交塌空；`stub-state` fatal 中 FLY-1404 区间两端是同一 SHA | **自动 + 诊断**：1.1.0 fixture 带 run/execution marker，不再与残留同字节；driver 识别同 SHA 区间，先落 `diagnosed_stub_fatal` evidence，再退出 21。旧房可换 `--issue`；共享残留清理见 FLY-2164 | 先读 fatal；不要把 15 分钟通用超时当成模型慢 |

## 3. 房间解剖

### 3.1 字节与 exec boundary

`scripts/test-deploy.sh` 本身必须从被测 worktree 运行。generalized 模式依赖 slot SQLite 中项目级 `pipeline_dag=true`、`pipeline_work_kind=true`、schema-v2 engine authority 与 category bindings；FLY-1808 已退役的 workflow env flags 不再注入或 attestation。

不要为了临时验收去改生产 `.env`。flag 归属 exec boundary；`.env` 热改既不能证明 slot 用的是同一值，还可能污染生产服务的下一次 restart。

### 3.2 binding 与 menu

Bridge boot 先把 canonical template 编译进 StateStore；随后 `scripts/lib/qa-generalized.mjs seed-bindings` 在单事务内验证模板并幂等写入 5 个 category binding。任何模板缺失、未 published 或 retired 都整体回滚。helper 的第二次执行是 no-op，不重复写 audit。

`scripts/lib/qa-generalized.mjs seed-project-flags` 在同一 slot DB 中原子、幂等地写入 `pipeline_dag` 和 `pipeline_work_kind` 项目行，并写入 `flag_value_changelog`。`.flywheel/config.yaml` 只保留 checkpoint 超时、agents 等非 flag 配置；重新加入 `pipeline:` 会被 ConfigLoader 拒绝。

menu / roster / adoption 一并由装房脚本落盘，readiness 从 HTTP 端点验证实际加载结果，不能只看文件存在。

### 3.3 token 与证据

`room-info.json` 只保存 token **路径**，不保存 token。driver 会再次检查 token 文件 mode 为 `0600`。以下目录也只对当前用户开放：

- `stub-state/`：每个 execution 的持久状态与 heartbeat；
- `stub-control/`：tuple-bound QA FAIL release、QA PASS release、exit fence；
- `e2e-evidence/`：按 run 分层的九步证据与 `owner.json`。

## 4. 九步驱动的真实边界

默认 `--stub-runner` 不是 mock Bridge。stub 只替换模型推理，并保留：

- 真 generalized dispatch 与 workflow snapshot；
- 真 design / implement / QA execution、pane 与 phase wake；
- 真 git commit / push、非 draft sandbox PR；
- 真 `complete`、`qa-result`、rework delivery、gate response 与 founder approval / land；
- 真 `ship_parked` / `park_opened` / `wake_delivered` / `park_cleared` 状态链。

stub 会在 QA attempt 1 先发布 ready tuple；driver 完成 step 4 四子断言与 step 5 gate probe 后才放行 FAIL。driver 不缓存 implement execution：每次等待都从 `workflow_run_node` 读取当前 execution，dead-exec recovery 换体后把 replacement 原子写回 `owner.json`，PR 身份只允许在同 repo / branch / PR number 下迁移；清理时接受同一 run 中任一历史 owner execution 写下的 marker。step 7 的 evidence / stdout 会明确写 `original_body_resumed` 或 `replacement_execution_completed`，不能把换体误读成原体 wake。pane liveness 同时核对 tmux window/pane id、`pane_dead=0` 与窗口上的 `@flywheel_exec_id`，tmux server 重启后复用的对象编号不能冒充当前 execution。Codex founder `resume` pane 保持一个真实 event-loop handle；machine client 驱动 goal 时，pane 不会因 Node unsettled top-level await(code 13)假死。收敛时 machine worker 与该 TUI 都只在收到绑定自身 execution 的 durable exit fence（或 teardown signal）后退出；无 fence 时不会靠 timeout 自杀，foreign / malformed fence 也不能把真实 alive actor 伪造成 dead。QA attempt 2 同理：driver 完成 F2 authority preflight 后才写 exact `(runId, executionId, attempt, expectedHead)` release。若 preflight 命中 A3 诊断出口，driver 先持久化 step 8 诊断包，再调用 session terminate action；active exact QA session 必须推进为 `terminated + terminal_at`，若它已在 drain/entry 共识的不可逆终态（`blocked` / `cancelled` / `completed` / `failed` / `terminated`）则按 status 直接接受（包括历史 `terminal_at` 缺失行），禁止重复 terminate。随后 driver 写 exit fence 并证明 worker/TUI dead，成功或失败的 closeout 结果都会追加回 step 8；`awaiting_review` 不再获得 drain 特赦。这样 durable drain、A3 closeout 与下一次 engine entry arbitration 对同一不可逆终态给一致结论。stale / foreign release 会被拒绝；重复拒绝结果不会重放 verdict。所有 driver 发出的 `flywheel-comm` 命令同时钉死 slot CommDB、slot `flywheelProjectsFile`，并从该 registry 解析、覆盖完整 canonical Lead identity projection（含 identity / projects digest），再关闭 resident Lead lease 读取；调用者 ambient identity 不能把命令带回生产注册表或 lease control plane。

`--real` 只用于已有真人/模型 Runner 路书的高成本观测房，房间 runner mode 必须与参数一致。它不会让 driver 假装能替模型决定何时提交 FAIL / PASS；正式一键回归使用默认 stub 模式。

## 5. 可选：reply-by-issue / Discord 腿

默认 Quickstart 故意不设置 `TEST_REPLY_BY_ISSUE`：A1 要证明 generalized master token 可用，同时 reply-by-issue 路由保持关闭。九步 step 5 用 DB 级 `question` gate 验证投递与 holder attribution，不冒充需要 committed HTML + HTTPS URL 的 `founder_review`；step 8 的真实 `approve_to_ship` holder 仍覆盖 founder approval / land 链，不依赖 Discord 卡片。

如果 QA 目标本身包含 Discord founder card 或 reply-by-issue，另开对应消息房并配置 slot bot。该房必须通过第 5 条 sender POST + DELETE 预检，并用 slot-local API token；不要把那条消息腿混写成 generalized DAG 基线已经覆盖。

## 6. Go / No-Go

可以继续：`room-info.json` 已发布；5/5 flag、5/5 binding、strict config、menu、双 SHA 全绿；driver 每个 step 文件都带同一 `runId`。

必须停手：active run 没有上一轮 `owner.json`；已证明 execution 从 run 记录消失；tmux/process liveness 为 unknown；launch owner 仍在 lease / 10 分钟 absolute horizon；PR marker、repo、branch 或 expected head 不符；QA authority preflight 缺项；`room-info.buildSha` 与被测 checkout 当前 HEAD 不同。最后一种要按新 HEAD 用 `--expect-head` 重新装房，不能在旧房继续。遇到这些情况不要手工 INSERT、不要直接删 branch、不要补发 QA PASS。
