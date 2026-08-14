# FLY-1768 529 房 implement↔QA 返工环活体演练 — 执行计划

Issue: FLY-1768 (https://linear.app/geoforge3d/issue/FLY-1768/qafly-1765-529-房活体演练founder-直令装房-真单全环-implementship-parkedqa)
日期: 2026-08-14
基于: research.md

## 0. 一句话

在从 `~/Dev/flywheel-FLY-1765`(= PR #837 head `fbff3c157`)起的 529 隔离房里,
用一张最小真单跑完 **implement→ship_parked→QA FAIL→自动 wake→attempt 2→QA PASS→land→park_cleared**
九步环路,每步取**库层证据**;结果为 founder 批 #837 的前置。

## 1. 房间参数(已定)

| 项 | 值 | 依据 |
|---|---|---|
| slot | 2 | 4 个 slot 实测全空,slot 2 = `lead` role |
| Bridge port | 19872 | `~/.flywheel/test-slots.json` |
| Bridge 代码 | `~/Dev/flywheel-FLY-1765` @ `fbff3c157` | 脚本所在仓库决定 Bridge 版本 |
| runner 沙箱分支 | `flywheel-FLY-1765` @ `fbff3c157`(已 FF 推到 qa-sandbox) | `--from-branch` 决定 HOST_REPO |
| env 绕坑 | `unset ROUNDTABLE_*` + `TMPDIR=/tmp/` | 坑 B / 坑 C |
| founder 卡 | `TEST_REPLY_BY_ISSUE=1` | 无此则 founder gate 卡片的硬前提缺失 |
| 5 flag | 与生产活进程逐字一致(见 research §4) | |

**开跑前一句话验收(硬门)**:
```
curl -s localhost:19872/health | jq -r .buildSha    # 必须 == fbff3c157...,不等就是起错房
```

## 2. 装房后置步骤(有序,不可颠倒)

1. deploy 完成 → 核 `/health` 的 `buildSha`。
2. 补 slot 项目 config 的 `pipeline.dag: true`(**不需重启 Bridge**,run-start 现读)。
3. 停 slot Bridge → `sqlite3` INSERT `workflow_category_binding`(project=slot 项目名, `code→tpl_code`)
   → 起 slot Bridge。**必须在 Bridge 首次 boot 之后**,因为外键指向 `workflow_template`,
   seed 是 boot 时编译进库的。
4. `/api/runs/start` 显式带 `templateId=tpl_code` + `selectionReason` + `taskCategory=code`,
   带 Bearer(`TEST_REPLY_BY_ISSUE=1` 打开了 API 鉴权 → 坑 F)。

## 3. 九步环路与逐步断言(每步都要库层证据,不许读码代替)

设 `X = <slot-dir>` 的 StateStore 库,`R` = run_id,`E1/E2` = implement attempt 1/2 的 execution_id。

| # | 动作 | 断言(库层判据) | 反例(出现即 FAIL) |
|---|---|---|---|
| 1 | run-start(tpl_code) | `workflow_run` 有行且 `engine_owned=1`、`gate_carrier_epoch=1`;snapshot 解析出的 gate authority `mode=land` | `gate_carrier_epoch=0` → Fix 1 判据链根本进不去 |
| 2 | design 节点走完 | design 节点 `state=done`,session 投 `completed`(design 不停驻) | design 也进 `ship_parked` = 范围收窄失效 |
| 3 | implement 派发 | implement 节点 `state=running`,`node.type=implement` 且 `creates_pr=1`,真 pane 活 | 节点类型/能力不符 → 判据链空转 |
| 4 | **implement 体完工**(`--route needs_review`) | ① `sessions.status(E1) = 'ship_parked'`(**不是 completed**)<br>② `workflow_engine_park_*` 出现 `park_opened` 且 `reason='rework_reachable_wait'`<br>③ E1 **无**终态时间戳(`ship_parked` 分支不打 `applyTerminalTimestamp`)<br>④ pane 仍活、goal 进 phase hold | `status='completed'` = **修没生效**,直接 FAIL |
| 5 | **founder gate 投递(加验)** | implement 处 `ship_parked` 期间,founder gate 仍能正常开/投;且该 `ship_parked` 体**不得**被选为 gate holder(FLY-1731 sentinel) | 停驻体抢到 gate holder 权 = authority 泄漏 |
| 6 | **QA 节点故意 FAIL** | `workflow_rework_delivery.state` 达到 `'wake_delivered'`(**不是** `state_not_revivable:completed`);run 不 held / 不 needs_lead;无人工介入 | 出现 `holder_activation_failed:state_not_revivable:*` = 事故原形复现 |
| 7 | implement attempt 2 | 同一 E1 体续跑(不是换体):同 thread、分支出新 commit;implement 节点 attempt=2 | 起了新 execution = 原体返工没走通(降级到 replacement) |
| 8 | QA attempt 2 PASS → founder gate → land | land 节点走完,ship finalization 触发 | |
| 9 | **park 清算** | ① `park_cleared` 落账(幂等键 `engine-park-settle:<executionId>:<openGeneration>`)<br>② `sessions.status(E1) = 'completed'` 且有终态戳<br>③ 体被回收(pane 没了) | park 残留 open → `getCurrentWorkflowEngineParkEvidence` 会继续供 veto |

**加验(529 真 Discord N-to-N 腿)**:上述过程中 Lead↔Runner↔founder 的 Discord 消息真投递
(不豁免 —— 前任 QA 曾把它并进演练一起延后)。

## 4. 驱动方式(诚实边界)

- 唯一 e2e 驱动被 FLY-1693 退役 ⇒ 用**最小真单**(改动面极小,让体几分钟内可完工)。
- 每个断言取**真实库行 / 真实进程**,不从源码推断。
- 若某步在合理成本内驱动不了:按 `feedback_report_blockers_as_falsifiable_not_verdicts`
  报**可证伪的障碍**(带命令、输出、判据),不报成品结论,也不把"没跑到"写成"通过"。

## 5. 纪律(硬约束)

1. **零 commit 到 `flywheel-FLY-1765` 分支**(head 已绑卡)。演练期间锁死该 worktree。
   已做的唯一写动作 = 把**已存在的** `fbff3c157` FF 推到 qa-sandbox remote(非 commit,非 origin)。
2. **生产零触碰**:不跑 `restart-services.sh`;不动生产 Bridge / Lead / 库。
   只读生产库一律 `sqlite3 "file:...?immutable=1"`。
3. verdict **不进引擎**;报告交 Lead(flywheel-eng-lead);HTML 由 Lead 投递。
4. 撞 FLY-913 护栏 → 停手上报,不硬碰、不用 BYPASS。
5. 结束拆房并回报;teardown 撞 cmux lease 重试一次,两次不过上报。

## 6. 风险

| 风险 | 处置 |
|---|---|
| 宿主 load ≈ 19,slot Bridge 可能被压 | 探针给宽超时;Bridge 猝死先读 slot 的 bridge 日志,不先归因负载 |
| codex 体完工后不进 hold(alive-but-nonconsuming) | 按 plan §6 = 演练 FAIL,停止发布,不自行扩 scope 修 |
| teardown 被生产 cmux lease 挡 | 重试;两次不过上报,不硬拆 |
| 报告正文触发护栏 | 避开 Bridge 启动脚本字面量,用文件行号代替 |
