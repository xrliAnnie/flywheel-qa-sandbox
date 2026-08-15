# FLY-1775 529 隔离房补 generalized-DAG 能力 + 装房路书固化 — 实施计划

Issue: FLY-1775 (https://linear.app/geoforge3d/issue/FLY-1775/infra-529-隔离房补-generalized-dag-能力-装房路书固化14-条实测坑位收编)
日期: 2026-08-14
基于: research.md(Codex design review R1 反馈已折入,见 §9)

## 0. 一句话

给 `test-deploy.sh` 加 `--generalized`(一条命令产出 generalized-ready 隔离房:5 flag +
binding 5 行 + `pipeline.dag/work_kind` + master token + 部署终点自检),把 14 条实测坑
逐条自动化/预检/固化进路书,并新写面向真 529 房的九步 e2e 驱动(常驻可唤醒 stub 体、
真控制面)替代 FLY-1693 退役件。

## 1. 范围与 PR 切分

**单 PR**,只动:`scripts/test-deploy.sh`、`scripts/test-teardown.sh`、
`scripts/inject-linear-issue.sh`、`scripts/lib/qa-multilead.sh` + 新
`scripts/lib/qa-generalized.sh`、新驱动 `scripts/qa-529-generalized-e2e.mjs`、
新 stub 体脚本(§4.2)、新路书 `doc/qa/framework/529-room-playbook.md`、
`scripts/__tests__/` 新增/扩展。

**`packages/` 生产代码仅有四个有界文件改动:**
`packages/claude-runner/src/CodexTmuxAdapter.ts` 把当前 generalized execution 的
`executionId/stateDbPath` 交给 TUI spec；`codex-runner-tui-window.ts` 在生产 TUI pane
命令前多带无害的 `FLYWHEEL_EXEC_ID` / `FLYWHEEL_STATE_DB_PATH`，使 founder-visible
Codex `resume` 能读取与 worker 相同的 execution-bound exit fence。QA attempt 4 又在
同房第二轮暴露 production dispatcher 的进程内存量:`run-dispatcher.ts` 现在于 launch
失败结果/异常对引擎可见**之前**按 entry identity 清 `inflight`，所有 inflight 入口与
公开 probe 都会用注入的不可逆 session 终态判据剔除存量；late old promise 的
`finally` 同样按 identity 删除，不能误删 replacement。`run-infra.ts` 只负责把既有
`isStateStoreIrreversibleTerminalForZombie(store.getSession(execId)?.status)` 权威判据
注入 dispatcher；判据读失败 fail-closed 保留占位，`awaiting_review` 等可恢复态不放行。
除此四个文件外其余 `packages/` 生产代码不动。两个附带发现(flag-toggle 写生产 `.env` 的隔离泄漏、
`registry.ts:2730` 钉死 E2E 的指针)只进路书 + 报 Lead 作 follow-up 素材,不在本 PR 修。

**Byte-compat 硬约束(R1#1 收紧)**:不带 `--generalized` 时 deploy 全流程逐字不变 ——
**所有**会改变行为的坑位自动化(HEAD banner、`--expect-head`、TMPDIR 回落、ambient env
清理、clone watchdog、dept-scope 注入、token 落盘、room-info 新字段/新文件)一律只在
`--generalized` 下生效。唯一枚举例外:坑 10 的 dist-preflight **错误文案**改进
(纯诊断文本,fail 路径才可见,不改变任何成功路径字节)——在守卫测试里显式列为豁免。
`inject-linear-issue.sh` / `test-teardown.sh` 的改动同理:只在探测到 generalized
room-info(inject)或 lease 超时失败路径(teardown 重试)时才有新行为。
新增 **ordinary-deploy golden 守卫**(§6):逐字比较无 flag 时生成的 config.yaml、
Bridge/Lead env 组装、room-info JSON 字段集,并断言不产生任何 generalized 新文件。

## 2. D1 — `test-deploy.sh --generalized`

### 2.1 CLI 与校验
- 新 flag `--generalized`(布尔)。与 `--mode mirror` / `--mode roundtable` 互斥
  (mode 校验区 :219-247 同一 fail-in-milliseconds 纪律);与 `--no-lead` 兼容。
- 新可选 `--expect-head <sha>`(坑 1,仅 `--generalized` 下接受):任何 mutation 前比对
  脚本仓 `git rev-parse HEAD`,不符即 fail-loud;不带则醒目打印脚本仓 HEAD。
- 新 flag `--stub-runner`(依赖 `--generalized`,§4.2)。

### 2.2 房间能力注入(全部仅在 `--generalized` 下)
1. **5 flag** → `BRIDGE_EXTRA_ENV` + `LEAD_EXTRA_ENV` 各追加
   `FLYWHEEL_WORKFLOW_{GENERALIZED_TEMPLATES,TEMPLATE_DISPATCH,CLAIMS_READ,CLAIMS_WRITE,GATE_CARRIER}=1`
   (注入模式同 :771-772)。
2. **dept-scope**(坑 8)→ 追加 `BRIDGE_DEPT_SCOPE_REJECT=off`;覆盖回 on 用**测试
   专用** env `TEST_BRIDGE_DEPT_SCOPE_REJECT`(R1#1:不复用生产变量名 —— 裸 `source`
   进来的未 export 生产值不构成「操作者显式意图」)。
3. **master token**(坑 9)→ 无条件保证 `TEAMLEAD_API_TOKEN` 注入 slot Bridge:
   `TEST_REPLY_BY_ISSUE=1` 时复用现有 token 块(:65-81);否则同一生成逻辑独立生成
   (不打开 reply-by-issue 路由)。token 落 `${SLOT_DIR}/state/api-token`(0600),
   room-info 增 `apiTokenPath`。
4. **config.yaml** → `qa_multilead_config_yaml` 加可选第 2 参;`--generalized` 时追加
   `pipeline: {dag: true, work_kind: true}`;无参 byte-identical(A1-A3 守卫 + 新断言)。
5. **menu 层文件** → 写入 HOST_REPO:`.flywheel/menus/ic-roster.yaml`
   (`design/implement/qa/generic` → `.flywheel/agents/<role>.md`,最小 role 文件一并写,
   须过 production loader 的全量校验 —— R1#6:partial menu config 会激活 menu domain 后
   fail-closed)+ `.flywheel/menus/adoption.yaml`(`<slot 主 Lead agentId>: [code, generic]`)。
6. **binding 5 行**(R1#6 收紧)→ Bridge `/health` 达标后,由 `qa-generalized` node
   helper(从 **built config 包**的明确文件 URL 读 `WORKFLOW_MENU_BINDINGS`,不在 bash
   硬编码)对 slot StateStore 执行:`PRAGMA foreign_keys=ON` + `BEGIN IMMEDIATE` 单事务
   内,先逐模板 SELECT 前置校验(存在、published、非 retired),再 5 行 upsert
   (`updated_by='system:test-deploy-generalized'`,已一致的行 no-op)+ 与
   `bindWorkflowCategory` 等价的 audit 行,任一失败整体 ROLLBACK。幂等 = 第二次运行
   **DB 零变化**(测试断言 dump diff 空,不只是终态映射相同)。
   **默认不重启 Bridge**(better-sqlite3 WAL + per-request 现读);实现期真机验证一次
   「INSERT 后不重启 run-start 立即可选中」,若有 BUSY/陈旧读回落「seed 后单次重启」
   并在脚本注释 + 路书记录判据。

### 2.3 部署终点自检(verify-at-destination;R1#2 重做)
- **flag 证明**:不用 `ps -Eww`(macOS SIP 读不到他进程 env,且 `$BRIDGE_PID` 是 npx
  wrapper —— `test-teardown.sh:914-919`、`qa-fly-529-alert-smoke.sh:87-93` 已双证)。
  改为 generalized-only **launch wrapper**:在 `exec npx tsx run-bridge.ts` 的同一继承
  边界逐一校验 5 个值并写 **无 secret、0600 的 env attestation 文件**
  (`${SLOT_DIR}/state/generalized-env-attestation.json`,只含 5 个 flag 名与值 + 时间戳
  + wrapper pid);自检读该文件。行为级闭环由驱动的第一步(run 判据链
  `engine_owned=1/gate_carrier_epoch=1`)完成 —— 自检不冒充「活进程 env 已读」。
- **/health**:解析 JSON,要求 `ok == true`、`buildMode == "built"`、`buildSha` **与**
  `artifactBuildSha` **都**等于脚本仓 HEAD(带 `--expect-head` 时 == 该值)——
  逐字继承 FLY-1768 的硬门,不再只看 HTTP 200。
- **binding/menu/config**:binding 经只读 DB 精确 5 行 + template_id 与 canonical 一致;
  menu 经 **现有权威端点** `GET /api/workflow/menus?projectName=…&leadId=…` 验
  code/generic adoption + roles + model resolution(R1#6);config 用 **built strict
  loader**(node helper 调 `loadWorkKindConfigStrict` 等价入口)同时验 `pipeline.dag`
  与 `pipeline.work_kind`,不裸 grep。
- **时序(R1#2)**:seed + 全部自检 + room-info 原子写(`room-info.json` 先写 tmp 再
  rename)全部放在现有 lock finalize / `trap - EXIT`(:1609-1624)**之前** —— 自检
  失败走既有 rollback,不留活房/锁/PID。hermetic 测试专门断言「health 后 readiness
  失败 → 无残留 PID/端口/锁/slot dir」。
- 汇总行:`generalized readiness: flags 5/5 · bindings 5/5 · pipeline+work_kind on · menu on`;
  room-info 增 `"generalized": true`、`"runnerMode": "stub"|"real"`、`"buildSha"`、
  `"apiTokenPath"`、`"envAttestationPath"`。

## 3. D2 — 14 坑逐条落地(自动化 / 预检 / 路书)

处置矩阵沿 research §8;自动化项全部 hermetic 测试;**除坑 10 文案外全部 gated
在 `--generalized`**(R1#1):

| 坑 | 实现 |
|---|---|
| 1 | §2.1 `--expect-head` + §2.3 /health 双 SHA 硬门 + 路书置顶 |
| 2 | preflight 推导本次 deploy 将创建的最长 socket 路径;>100 字节 → 对子进程强制 `TMPDIR=/tmp` 并 log |
| 3 | Bridge/Lead `env` 调用行加 `-u FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`(generalized 房无 roundtable 叠加,见 §2.1 互斥) |
| 4 | 同上**无条件**加 `-u FLYWHEEL_ALERT_SENDER_TOKEN_ENV`,**含 `--alerts`**(R2#1:`qa_room_alert_bridge_env` 并不显式设 sender env,父 shell 已 export 的生产值会穿透,`plugin.ts:8736-8795` 会把它当权威单 sender 压过 repair chain)。测试确需 single-sender override 时走 test 专用 CLI/env,显式解析成 slot-local `BRIDGE_EXTRA_ENV` 再加回。新增 fixture:父环境预置生产 sender 变量 → 断言子 Bridge attestation/argv 不含该变量 |
| 5 | `--alerts` preflight(R1#7 + R2#1):**从 scrub 后最终传给 Bridge 的显式 sender/repair chain** 派生并去重全部 sender-capable bot,对每个 bot 做临时 **marker POST + DELETE** 真写探针(GET 只证可见性,证不了发消息 403);403 → fail-loud 指名「把 slot N 的 <bot> 邀进频道并给 Send Messages」;fixture 覆盖 GET200+POST403 / 第二 bot 403 / DELETE 失败 / token 缺失,永不打印 token |
| 6 | 路书:无 Runner 演练不带 `--from-branch` |
| 7 | `git clone` 换 `qa_clone_with_stall_watchdog`(lib):15s 采样目录增速,60s 零增长 → **终止整个进程组 + 确认退出 + 清 partial clone 目录**后重试 1 次,再挂 fail-loud |
| 8 | §2.2-2;路书写清 `--lead-label` 正路与 off 的关系 |
| 9 | §2.2-3;`inject-linear-issue.sh`(R1#4 修正):读 `${SLOT_DIR}/room-info.json` —— 普通房有 token 时自动带 Bearer 修 401;**generalized 房直接 fail-loud 指向驱动**(menu 激活后 master+main 请求会被 `LEAD_ID_REQUIRED`/`TASK_CATEGORY_REQUIRED` 拒,「仍走 legacy」不成立,不静默改 legacy 语义) |
| 10 | dist preflight 错误文案逐字给 `pnpm install --frozen-lockfile` + `pnpm -r build`(唯一无 gate 例外,见 §1) |
| 11 | `test-teardown.sh`:cmux lease 获取超时自动重试 1 次,二次仍挂 → fail + 指路 |
| 12 | 路书:launchd-v2 bootstrap slot 内失败 → 引擎演练用 `--no-lead` |
| 13 | 路书:sensor 演练必须显式 `FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS` |
| 14 | 驱动第 8 步前置断言 + 精确诊断(§4.5);路书如实写机制链与边界 |

## 4. D3 — 九步 e2e 驱动 `scripts/qa-529-generalized-e2e.mjs`

### 4.1 形态与调用契约
- Node(.mjs):fetch 驱 slot Bridge + `better-sqlite3` 只读取证;读
  `${SLOT_DIR}/room-info.json`,显式拒 mirror/roundtable slot 与
  `runnerMode` 不符的房(stub 流程要求 `runnerMode=stub`;`--real` 要求
  `runnerMode=real` —— 混用 fail-closed,R1#3)。
- **调用**:`qa-529-generalized-e2e.mjs <slot> --issue <FLY-xxx>`。`--issue` **必填**
  (R1#5):Quickstart 提供专用 fixture issue(沿 FLY-1768 用 FLY-202 的先例,路书
  固化「529 演练 fixture 单」;不隐式猜单)。
- **run-start 完整 body(R1#4 钉死)**:`issueId`、`projectName`、
  `leadId=<slot 主 Lead agentId>`、`taskCategory:"code"`、`sessionRole:"main"`、
  `overrides:{design:{model:"fable"},implement:{model:"codex"}}`、Bearer(读
  apiTokenPath);fresh-start 规则:检测到同 issue active run → 按 §4.4 收敛,
  不用 freshStart 硬顶。
- **不出 PASS/FAIL 单字判决进引擎**;exit code 只服务 CI/操作者。

### 4.2 stub 体:常驻、可唤醒的有限状态协议(R1#3 重做)
- deploy `--stub-runner`:Bridge PATH 前插 `${SLOT_DIR}/stub-bin`(`claude` +
  `codex` 双 stub)——Bridge 仍走**真 spawn 机制**(tmux、worktree、
  `bindWorktreeOnce`、凭据注入)。Codex stub 实现 resident adapter 所需的最小
  Unix WebSocket RPC 子集(`initialize`、thread/goal、turn),首次 `turn/start`
  启同一确定性 worker;不调用真实模型。
- vendor 钉死:design override 为 Claude `fable`,implement override 为 Codex
  `codex` alias(`gpt-5.6-sol`),QA 不 override、沿 `tpl_code` 的 Claude 默认。
  StateStore dispatch 因而保持 producer=Codex / reviewer=Claude,满足 claim 层
  cross-vendor review 不变量,避免 `same_vendor_review` 假阻塞。
- **方案演化(2026-08-14 QA B2 + Lead 裁定)**:旧稿把 implement 钉 `fable`,导致
  QA 与 producer 同为 Claude 而永久 hold;返工中曾把 QA 改为 Codex,但这会倒置
  生产模板语义。最终作废旧 fable-pin,改为 implement=Codex + QA=Claude,且用
  双 stub 保住「无真实模型、真 adapter 控制面」边界。
- **stub = 常驻进程 + 显式状态机**(不是一次性命令;旧 FLY-1281 stub 只证过 spawn,
  没证常驻/停驻/唤醒):
  - 角色分派:从 Bridge 注入的 runner env 取(实现期 spike 定字段;兜底按 exec-id
    查 slot 库反解)。
  - **design**:在 worktree 里生成并 **commit 合法最小 HTML**(满足
    `complete.ts:568-634` 的 committed `doc/<ISSUE>-*/…html` attestation,fidelity
    零损失)→ `complete --route phase_design_complete` → 保持进程/pane 存活等回收。
  - **implement attempt 1**:marker commit + push + `gh pr create`(非 draft)→
    `complete --route needs_review --pr <n>`(PR number 显式送服务端)→ **park:
    进程不退出**,阻塞读 stdin/transport 等 wake。
  - **wake → attempt 2(当前 execution)**:正常路径复用同一进程；dead-exec recovery
    换体时，driver 按 `(runId,nodeId,latest attempt)` 动态解析 replacement execution，
    将它追加进 owner 集合后再观察 marker commit + push(head 前进)→ 再次
    `complete --route needs_review --pr <n>` → 再 park。PR 身份只能在同
    repo/branch/number 下迁移，不能把任意 replacement 当所有权。
  - **qa**:attempt 1 `qa-result` FAIL(点名要 attempt-2 marker);attempt 2 走
    **fail-closed release 握手**(R2#3,消除「stub 抢先 PASS、驱动前置门形同虚设」的
    竞态):stub 先落 ready 状态(含 run id + 本 QA execution id + expected PR head)
    并阻塞;驱动等到该 exact execution/binding 出现,完成 §4.5 全部前置检查并原子落证
    后,写**同 tuple 绑定**的 release marker;stub 校验 tuple 一致才调
    `qa-result` PASS **显式 `--pr-head`**(F1 教训)→ park 至回收。前件缺失驱动永不
    release,转 §4.4 安全收敛。单测:early-PASS 不可达 / stale·foreign release 拒绝 /
    duplicate release 幂等。
  - ship/land 后收尾:machine worker 与 Codex founder-visible `resume` TUI 都监听
    execution-bound exit fence；收到该显式指令或 teardown signal 后自然退出。无 fence
    时 TUI 必须持续存活，不能用 timeout 自杀伪造 actor dead。
  - **控制通道**:每个 stub 监听 slot 内 per-execution 控制文件(0600,tuple 绑定)——
    驱动用它下发 release(§4.2 qa 握手)与 exit(§4.4 收敛)指令;stale/foreign tuple
    一律拒绝。**machine worker 与 founder-visible TUI 入口先查、常驻期间持续监听持久化
    exit 指令**(R4#1:迟到 launch 起出来的 stub 在任何 role/git/CLI 副作用前自杀,
    已停驻的 TUI 也在显式 fence 后退出,关掉 same-execution late-launch/liveness 窗口)。
  - 状态机单测:状态转换、重复 wake 幂等、进程死亡、pane 回收、控制指令 tuple 校验。
- founder gate:驱动用 lead-attributed `flywheel-comm respond` 批；每次调用同时
  钉 `FLYWHEEL_COMM_DB` 与 room-info 发布的 `flywheelProjectsFile`，并关闭 resident
  Lead lease 回落读取，禁止隔离房触碰生产 `~/.flywheel/projects.json` / lease
  control plane；slot 已带
  `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0`,test-auto-approve.sh 同路径→ `--no-lead`
  全程可跑。

### 4.3 九步断言
逐字继承 FLY-1768 plan §3 判据表(run 判据链 / design completed 阴性对照 / implement
派发 / **ship_parked 四子断言** / gate 投递 + 停驻体不得当 holder(FLY-1731 sentinel)/
**FAIL→wake_delivered** / 当前 implement execution attempt 2 续跑（证据区分
`original_body_resumed` 与 `replacement_execution_completed`）/ PASS→land /
park_cleared 结算),
每步:动作 → SQL 取证 → 反例扫描(`state_not_revivable`/`needs_lead`/`held` 零命中)。
**证据按 run 分层原子写** `${SLOT_DIR}/e2e-evidence/<runId>-<ts>/step-N.json`
(R1#5:不覆盖上一轮)。

### 4.4 可重复重放的所有权与收敛(R1#5 + R2#2 重做)
- **接受固定派生 branch**(`WorktreeManager.ts:118-145/227-229/542`:DAG shared branch
  = `<repoSlug>-<issueId>`,驱动无入口插 run id,强行改名会与 `bindWorktreeOnce` 记录
  的 branch 身份漂移)。所有权改由三件套确立:exact sandbox repo + 派生 branch 名 +
  **PR body marker** + 本地证据里的 `(runId, executionIds, expectedHead)` tuple。
- **pre-action 收敛状态机**(完整走完才允许新 run,任一步证据缺失/身份不符 →
  fail before mutation 指名人工处置)。**顺序为 terminate-first**(R3#1:
  `StateStore.ts:24625-24636` 的 quiescence gate 已按 founder directive neutralize
  恒 ok,`RUN_HAS_LIVE_EXECUTIONS` 在生产不可达 —— 不能指望它拒活 actor;且先退
  stub 再 terminate 会给 engine dead-exec recovery 留 replacement 窗口):
  1. **ownership proof**:发现同 issue active run → 用本地上一轮证据证明该 run；
     `workflow_run_node` / run-scoped binding 新增的 dead-exec replacement 可追加到
     owner 集合，但任何历史 execution 消失都 fail-closed;
  2. **terminate = fence**:master-auth + 稳定 `clientRequestId` **先**调 operator
     terminate,以 run terminal transition 挡住后续 engine dispatch/replacement;
     验证幂等 replay;
  3. terminate 后及 drain 每轮都**重读** run 归属 execution 全集；新增 replacement
     原子写回 `owner.json` 并立即收到 exit fence，历史 execution 缺失才 fail-closed;
  4. 对 exact executions **持久化** tuple-bound exit 指令(stub 在进程入口、任何
     role/git/CLI 副作用前先查该指令,见 §4.2)+ 有界 fresh liveness census
     (pane/进程):全部 `dead` 且 session/park 已收敛才前进;`alive`/`unknown`
     超时一律停手;
  4b. **durable launch-drain**(R4#1:terminate 只 fence 新 admission,取消不了已
     admitted/acquired、仍在 dispatcher/Blueprint 异步链上的 physical launch ——
     同一 execution 可在两次 dead census 之后才 materialize worktree/pane)。cleanup
     前只读 slot DB 证明:无 `starting` lifecycle claim、无「未 commit 且仍持 live
     owner generation/lease」的 launch(`workflow_launch_owner` /
     `lifecycle_launch_claims`)、无 `repairing` delivery lease;已 committed/
     delivered 的 launch 必须被物理观测到且 process/pane dead + session/park
     terminal。pending/unknown 按源码的 5min soft lease / 10min absolute horizon
     有界等待,超时停手 ——「当前无进程」不当「永远不会出现」。A3 不再有
     `awaiting_review` 特赦:诊断出口先持久化 step 8,再通过现有 session terminate
     action 把 active exact QA session 写成 `terminated + terminal_at`;若 exact session
     已是不可逆终态则按 drain / entry arbitration 的 status 谓词直接接受(包括历史
     `terminal_at` 缺失行),禁止重复 terminate。随后写 execution-bound
     exit fence 并证明 actor dead,并把 closeout 成功/失败追加回 step 8。drain、A3
     closeout 与 engine entry arbitration 因而都只对同一
     不可逆终态给 settled/可入场结论;任何 `awaiting_review`、open park、未 delivered
     launch、alive/unknown actor 仍 fail-closed,不得靠延长 timeout 绕过;
  5. 对 attributed set + launch-owner generation/lease + lifecycle claim + liveness
     做**同一轮稳定重读**,最后才对 **run marker + 历史 owner execution** 证明的
     open PR / remote branch 做 expected-head read-verify close/delete;replacement
     不会要求 PR body 改写 marker，foreign execution 仍拒绝；head 漂移 → 停手上报。
  6. 普通 teardown 先 bootout launchd Lead、停止 Lead supervisor 与 Bridge(含 port
     straggler),彻底断开 actor 监管链;随后才以 exact Codex stub argv 缩小候选，再用 slot
     `workflow_actor.execution_id` 的 SHA-1 socket basename 证明 live Unix socket
     所有权后回收；daemon 继承 Bridge cwd，cwd 不作为所有权证据。
- failure-injection 测试:F2 中止残局 / stub 已死 / 部分退出 / terminate replay /
  **terminate 时 actor 仍活** / **ownership proof 后出现 replacement** /
  **liveness unknown·超时** / **terminal 后仍有 actor** / branch head 漂移 /
  **same-execution 迟到 launch**(已 admitted/acquired 的 launch 卡在 worktree/spawn
  前,terminate 后首次 census 报 dead,再释放 —— 断言 cleanup 被挡到该 launch
  durable-settled 且 actor 退出为止)。A2 的第二轮真机验收**实际走过**这条收敛路径。
- teardown 仍不删 sandbox remote branch/PR(沿 `real-runner-e2e-guide.md:172` 纪律);
  收敛只发生在下一次驱动运行的 pre-action 步骤。

### 4.5 坑 14 的结构化处理(第 8 步前置断言)
发 PASS 前驱动自查 gate-entry 链全部前件(research §7):QA execution 的 worktree
binding 列非空 / producer session `pr_number`+`pr_head_sha` 齐全 / sandbox PR OPEN
非 draft head 在 tip。任何一件缺 → 不发 PASS,输出精确断点(缺哪件、库里现状、预测的
server reason)后以独立 exit code 收尾 —— F2 从「假设」变成可证伪定位的证据包;机制
修复归产品侧 issue,本单不越界。

## 5. D4 — 路书 `doc/qa/framework/529-room-playbook.md`

结构:① Quickstart(两条命令,**零内联 env** —— R2#5:
`scripts/test-deploy.sh <slot> --generalized --stub-runner --no-lead`
→ `scripts/qa-529-generalized-e2e.mjs <slot> --issue <fixture>`,fixture 单固化;
A1 验收显式在 `TEST_REPLY_BY_ISSUE` 未设置的环境跑,断言 master token 可用且
reply-by-issue 路由保持关闭。需要 Discord founder-card 腿的 QA 走可选章节
「+ reply-by-issue 房」,九步驱动的第 5 步断言本身是 DB 级 gate 状态 + holder 纪律,
不依赖 Discord 投递 —— 该 fidelity 边界在路书与驱动输出里如实标注);
② 14 坑对照表(症状 → 根因 → 现在谁堵:自动/预检/仍需人工 —— 非 generalized 房哪些
坑仍需手工绕,如实分列);③ 房间解剖(flag 从哪来、binding 谁种、token/attestation
在哪、readiness 各项怎么读);④ 驱动用法、fixture 单、重放收敛规则与证据形态;
⑤ 诚实边界(F2 机制链与未决问题、flag 热改写生产 `.env` 禁令、`--real` 成本、
sensor/无 Runner 演练注意项)。中文,技术名词/路径英文。

## 6. 测试与门(TDD:先写守卫再改脚本)

1. `scripts/__tests__/test-deploy-generalized.test.sh`(hermetic):
   - **byte-compat/golden 组(R1#1 + R2#4,exact-bytes)**:hermetic fixture 固定全部
     动态输入,ordinary 成功路径的最终 stdout/room-info JSON **字节**、Bridge/Lead
     env argv、config.yaml 字节做逐字 golden 比较 —— 动态 token(PID/port/path)按
     **枚举清单**规范化后再比,并断言无额外 stdout/stderr 行、无新文件;另加
     dist-preflight fail fixture,断言唯一允许的 delta 就是坑 10 的预期错误文本。
   - **能力组**:5 flag 进 env 数组;dept-scope off + `TEST_BRIDGE_DEPT_SCOPE_REJECT`
     覆盖;token 0600;config pipeline 段;menu 文件过 production loader 校验;binding
     helper 幂等(fixture 库跑两遍 **DB dump diff 空**)+ 前置校验失败整体回滚 +
     canonical 来源阳性对照(篡改一对 → 红)。
   - **终点自检组(R1#2)**:/health `ok:false` 或 SHA 不齐 → deploy FAIL;
     「health 后 readiness 失败 → 无残留 PID/端口/锁/slot dir」;attestation 文件
     形态(无 secret、0600)。
   - **坑位组**:TMPDIR 超长回落;clone stall(假 git 停滞)→ 进程组终止确认 + partial
     清理 + 重试;inject 三态(普通房无 token/有 token/generalized 房拒 + 指路);
     teardown lease 重试;alert probe 矩阵(R1#7 的 4 个 fixture)。
2. stub 状态机 + 驱动断言函数抽成可单测模块(状态转换/重复 wake/进程死亡);九步
   全链属真机验收(§7),CI 不假装。
3. 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` +
   `scripts/__tests__/*.test.sh`(host 定向,全量以 CI 为准)。
4. Codex code review(codex:rescue)循环至 APPROVED。

## 7. 验收(分级,不假绿)

| 级 | 判据 |
|---|---|
| A1 | 新 slot 一条命令 deploy 成功,readiness 全项绿(flag attestation + /health 双 SHA + binding 5 行 + menu 端点 + strict config),零手工 SQL、零 env 手调 |
| A2 | 驱动一键跑,九步中 **1-7 全过**,每步库层证据按 run 分层落盘;**连跑两次**,第二次**实际走过 §4.4 收敛状态机**后照常进入新 run 并通过 1-7(R1#5/R2#2 的重放判据) |
| A3 | **8-9 步**:过 → 全绿;被 `land_head_*` 拒 → 驱动输出精确断点诊断包 = F2 产品侧 issue 开单证据(风险出口,不算本单 FAIL,更不假绿) |
| A4 | 既有套件零回归:golden/byte-compat 守卫 + 现有 shell suite 全绿 |

### 7.1 A2 / A3 不得互斥(QA F1 返工验收)

A3 的 exit 20 是第一轮允许的诊断出口,但不能把 QA execution 永久留成下一轮不可收敛
的 `awaiting_review` 活工作。若第一轮走 A3,驱动必须先持久化 step 8 诊断包,再调用既有
`/api/actions/terminate` 把 active exact QA session 推进到不可逆的 `terminated` 并确认
`terminal_at`;若 exact session 已是 `blocked` / `cancelled` / `completed` / `failed` /
`terminated`,则与 drain / entry arbitration 一致地按 status 直接接受(包括历史
`terminal_at` 缺失行),
禁止发出不合法的重复 terminate。随后写 execution-bound exit fence、证明 worker/TUI actor
均 dead,并把 closeout 成功或失败追加回 step 8;成功后才返回 exit 20。第二轮再 operator-terminate 旧 run,由 durable drain 对 terminal session
和 dead actor 给 settled,engine entry arbitration 对同一个 terminal session 给可入场；
两谓词必须一致。任一条件缺失仍拒绝收敛,`awaiting_review` 无条件 fail-closed。
hermetic 断言覆盖该一致性;独立 QA 必须在同房真机连跑两轮,不能用延长 900s timeout 代替证明。

真机验收由独立 QA 节点执行。

## 8. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 坑 14 结构性(共享 worktree QA execution 无 binding)→ 8/9 任何房都过不了 | A3 出口:可证伪定位 + 开产品侧 F2 issue;1-7 + 房能力 + 路书独立成立 |
| R2 | binding 现读不生效 / BUSY | helper 单事务 + `.timeout`;真机验证;回落「seed 后单次重启」并记录判据 |
| R3 | stub 角色识别 / wake 接收通道字段与预期不符 | 实现期 spike 定字段;兜底按 exec-id 查库;wake 通道以 claude transport 真机行为为准 |
| R4 | menu override 被拒(menu 层配置差一件) | readiness menu 端点自检提前暴露;`LEAD_ID_REQUIRED`/`MENU_*` 错误码逐一进路书 |
| R5 | 宿主高负载压探针 | 全部探针宽预算 |
| R6 | `--generalized` 意外改变存量房行为 | golden 守卫组 + 所有注入点条件化(§1) |

## 9. Design review 记录

- R1(Codex,xhigh):7 项(5 HIGH 2 MEDIUM)全部吸收 ——
  ① byte-compat 与坑位自动化冲突 → 全部 gated + golden 守卫 + `TEST_BRIDGE_DEPT_SCOPE_REJECT`;
  ② `ps -Eww` 证明不可用 → launch-wrapper env attestation + /health `ok/buildMode/双 SHA`
  + readiness 移到 lock finalize 前;
  ③ stub 一次性 → 常驻可唤醒状态机 + design HTML attestation + `--pr` 显式 + runnerMode
  fail-closed;
  ④ inject「仍走 legacy」不成立 → generalized 房 fail-loud 指向驱动 + run-start 完整 body 钉死;
  ⑤ 重放生命周期 → `--issue` 必填 + ownership marker + CAS 收敛 + 证据按 run 分层;
  ⑥ binding/menu readiness 走权威校验(单事务 FK + audit + menus 端点 + strict loader);
  ⑦ alert GET → 逐 sender-bot 真写 marker POST+DELETE 探针。
  唯一部分吸收:坑 10 错误文案保持无 gate(纯 fail 路径诊断文本),在 §1 作为枚举豁免
  显式声明并入守卫。
- R2(Codex,xhigh,resume):5 项(3 HIGH 2 MEDIUM)全部吸收 ——
  ① `--alerts` 也无条件 scrub sender env + 探针集从 scrub 后最终 env 派生 + 穿透 fixture;
  ② branch 嵌 run-id 不可实现 → 接受派生 branch,所有权=repo+branch+PR-marker+tuple,
  pre-action 收敛写成完整状态机(stub 退出→census→terminate→CAS)+ failure-injection;
  ③ QA attempt-2 PASS 加 fail-closed release 握手,消除驱动前置门竞态;
  ④ golden 升级为 exact-bytes(枚举动态 token 规范化)+ fail-path fixture;
  ⑤ Quickstart 去 `TEST_REPLY_BY_ISSUE=1`,reply-by-issue 移入可选章节,第 5 步断言
  明确为 DB 级(Discord 腿的 fidelity 边界如实标注)。
- R3(Codex,xhigh,resume):1 项 HIGH 吸收 —— 收敛状态机改 **terminate-first**
  (quiescence gate 已 neutralize,`RUN_HAS_LIVE_EXECUTIONS` 生产不可达):
  ownership proof → terminate=fence(幂等 replay)→ 重读归属集 fail-closed →
  控制通道 exit + 有界 census(alive/unknown 停手)→ 再重读 → CAS cleanup;
  failure-injection 补 4 个新 fixture。
- R4(Codex,xhigh,resume):1 项 HIGH 吸收 —— terminate 只是新 admission 的 DB
  fence,已在途异步 launch 需 **durable launch-drain**(§4.4-4b:launch_owner /
  lifecycle claim / delivery lease 全读 + 已 committed launch 必须物理观测 + 5min/
  10min 有界等待)+ stub 进程入口先查持久化 exit 指令 + same-execution 迟到 launch
  fixture;当时方案全部由驱动只读 slot DB + 既有控制文件完成；attempt 3 为让生产
  Codex TUI 读取同一 exit fence，最终增加了 §1 所列两个有界
  `packages/claude-runner` env-plumbing 改动。
- **R5(Codex,xhigh,resume):APPROVED — ready to implement。**
