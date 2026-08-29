# FLY-2118 Lead 巡检可见面收窄 — 调研

Issue: FLY-2118 (https://linear.app/geoforge3d/issue/FLY-2118/巡检制度-lead-巡检只应看见自己名下的-runner-现在是每个-lead-各扫全机)
日期: 2026-08-28
基于: exploration.md

目的:逐项验证 exploration.md 推荐组合(A1+B1+C1+D1+E1+F)的承重假设,把「可以这么设计」
升级为「代码与生产数据都支持这么设计」。

---

## R1. owner index 数据质量 —— lead_id 覆盖率(A1/C1 的承重前提)

**假设**:凡是可能 match 到 tmux pane 的 comm.sessions 行都有 lead_id。

**验证**(2026-08-28 生产直查,13 个项目 comm.db 全量):

- flywheel:`running|blocked` 共 25 行 —— 已绑窗(`tmux_window NOT LIKE '%:pending'`)
  23 行 **全部有 lead_id**;无 lead_id 的 2 行全是 `:pending` 窗口(本就 match 不到 pane)。
- 其余 12 个项目 comm.db:`bound-no-lead = 0`,无一例外。

**写入链**(代码证据):
- dispatch 时:`run-dispatcher.ts:1227` `registerSession(exec, "<session>:pending", project, issue, leadId, vendor)`。
- 绑窗时:`TmuxAdapter.ts:1040` 以 `<session>:<windowId>` + `ctx.leadId` 再次 upsert。
- `registerSession`(flywheel-comm `db.ts`)的 `ON CONFLICT ... DO UPDATE SET lead_id = excluded.lead_id`
  是**无条件覆盖** —— 若某调用点不带 leadId 会把已有值冲成 NULL。生产数据显示这未发生,
  但 plan 应在脚本侧把「绑定窗口且 lead_id 为空」显式当作 `UNAVAILABLE(structural:
  owner_index_incomplete)` 的一种(而不是静默当无主),防御这条写入面。

**结论**:成立。名下集合 = `lead_id = $LEAD_ID AND status IN ('running','blocked')`
的 `tmux_window` 目标,数据面可靠。

## R2. tmux session 命名与 test 环境噪音(B1 告警面边界)

- 生产 session 名:`run-infra.ts:975` `sanitizeTmuxName("runner-" + project.projectName)`
  → `runner-<project>`,窗口名以 Linear identifier 开头 —— 与脚本 canonical 口径一致。
- 现行脚本对「session 项目名不在 projects.json registry」的 pane 判 `foreign-registry`
  并 `foreign_registry_clear`(L376-378)—— 529 房 / 隔离 harness 的 runner(若共享
  socket)落在这一类,不会误报 orphan。**sweeper 必须原样保留 foreign-registry 豁免**。
- orphan 判定 = 项目在 registry 内 + 该项目 comm.db 可读 + 无 index 行 + 连续 2 个
  观测周期(现行 `patrol-continuity` sidecar 的 `unclaimed` 计数,L383-388)。

**结论**:sweeper 的分类逻辑可以从脚本 L363-389 平移,无新推导。

## R3. 兜底告警管道(B1 的落点)

- patrol-tick 已有 `alertFailure` → `plugin.ts:8404` alert sink:
  `unowned_roster`(session 级无主)以 `severity: "severe"`、
  `projectName: FLEET_ALERT_PROJECT`(= `"machine"`,`LeadAlertNotifier.ts:610`)发出
  fleet-scope 告警。**pane 级 orphan 告警可完全复用这条管道**,新增一个
  `kind: "orphan_pane"` 即可,无需新通道。
- #flywheel-alerts 的默认主力 owner = Claw(FLY-2076,已 merge `aec69ea19`)——
  「确定责任人」由既有值班制度承接,本单不新设身份。
- 调度位置:patrol-tick pass 是 GatePoller 的 rider(`gate-poller.ts:676`
  `onLeadPatrolTick`,单飞 guard 在 `createLeadPatrolTickPass`)。sweeper 以同构方式
  挂第二个 rider(或并入同一 pass 的项目循环外段),节奏可比 patrol tick 更稀
  (orphan 不是分钟级问题)。
- Bridge 触 tmux 不是新能力:`patrol-process-liveness.ts` 已做 pane 级 liveness 探针,
  `tmux-lookup.ts` 已有 target 解析。

**结论**:B1 全部构件既存,新增面 = 一个枚举 pass + 一个告警 kind + 一份 Bridge 持有的
连续性状态(替代 per-Lead sidecar 的 orphan 计数半边)。

## R4. STEP 3/4 的 lead 归属可行性(D1)

逐 finding 类型核对现行 SQL(`lead-patrol-snapshot.sh` L475-576):

| finding | 归属路径 | 备注 |
|---|---|---|
| TURN_MISSING / TURN_HOLDER_NOT_LIVE / NO_TURN_STREAK | `active.execution_id → comm.sessions.lead_id` | active CTE 已含 execution_id |
| NODE_SESSION_NOT_LIVE | execution 可能为 NULL 或 session 已消失 | 归属退路:该 issue 下**任意** comm session 的众数 lead;仍无 → 保留在双方报告之外、并入 sweeper/alerts 面 |
| MAILBOX_STALE | `m.to_agent = execution → sessions.lead_id` | 已 join sessions |
| WAKE_UNACKED | `w.execution_id → comm.sessions.lead_id` | comm 侧可 join |
| DEAD_LETTER_PENDING | **自带 `d.lead_id` 列** | 直接过滤 |
| VERDICT_HEAD_MISMATCH | issue → 该 issue 的 comm sessions lead | 同 NODE_SESSION_NOT_LIVE 退路 |

**结论**:全部六类可归属或有确定退路;SQL 改动均为在既有查询上加 join/WHERE,
无 schema 变更。

## R5. class_key 收口(E1)

- 现行步骤 B(规则 L176-263):`ROOT_KEY = sha256(ERROR_CODE|GUARD_KEY|STRUCTURAL_SHAPE)`,
  三段全由 Lead 转写;查重 = Linear MCP 250 条分页 + 逐张 fresh read + marker 精确搜 ——
  约 90 行规则文本,且并发窗口内两个 Lead 都读到 0 匹配 → 双创建(FLY-2113/2114 实锤)。
- Bridge 已有 token-authed Linear 代理路由族(`plugin.ts:960` 注册表 + `:3222`
  `/api/linear/create-issue`,经 `linear-scope.ts` 做 team/label/project 解析)——
  新增 `/api/patrol/class-issue`(find-or-create by class_key)有现成的路由骨架、
  auth 模式与 Linear client。
- 幂等账落 `teamlead.db` 新表(`patrol_class_ledger`):Bridge 单进程内按 key 串行 +
  ledger 唯一约束,同 key 并发第二个请求返回同一张子 issue → 满足「只产生一张单」,
  而非「两张再撤一张」。
- key 语义:`ERROR_CODE|GUARD_KEY` 都是逐字源码 token(`<repo 相对路径>#<symbol>` +
  稳定错误码),同 guard 同错误码 = 同病根类;`STRUCTURAL_SHAPE` 降级为 body 人读字段。
  同一 guard 下两个不同结构形状会合并进一张类 issue —— 这正是 Epic review 想要的
  聚合粒度(标题=类别、×N=热度),形状差异留在实例 comment 里。

## R6. 规则/脚本分发链(F 与发布顺序)

- 脚本:`converge-flywheel-bin.sh` 把 `scripts/lead-patrol-snapshot.sh` symlink 成
  `~/.flywheel/bin/flywheel-patrol-snapshot`(L236/328)—— **symlink 指向主仓工作副本**,
  merge 到 main + 主仓 `git pull` 后即生效,不等重启。
- 规则:`runner-patrol-rules.md` 经 `claude-lead.sh` 内联装配 /
  `lead-rules-bundle.sh`(FLY-350 H-2,parity 由 `lead-rules-bundle.test.ts` 钉住)
  进 Lead system prompt —— **Lead 重启(00:00/12:00 班车)后生效**。
- ⇒ 存在一个窗口:脚本已新、规则还旧(Lead 在飞)。plan 必须让**新脚本对旧规则可容忍**:
  六步骨架、`REPORT_PATH` 合同、FINDING-GATE 结构全部保留,旧规则读新报告时只是
  「跨界 pane 一节为空」,不会撞门。反向(规则新、脚本旧)不出现 —— 同 PR 原子换,
  脚本先行生效。

## R7. 测试基建

- `scripts/__tests__/lead-patrol-snapshot.test.sh`:hermetic harness —— 真
  StateStore/CommDB schema(从 dist 建库)、假 tmux/gh(`$dir/bin` PATH shim)、
  temp-only 报告。改脚本 = 在此扩展用例;验收 1/2/3 的「capture 次数」「报告不出现
  别家 pane」「orphan 阴性对照」都能在这个 harness 里以假 tmux 计数直接断言
  (fake tmux 可记录 capture-pane 调用次数)。
- Bridge 侧:`patrol-tick.test.ts` / `StateStore.patrol-tick.test.ts` 已覆盖 tick pass
  的注入式测试模式(store/deps 全可注入),sweeper 沿用同模式。

## R8. 采纳到设计的修正

相对 exploration.md 的推荐组合,研究后有两点收紧:

1. **R1 防御**:脚本把「绑定窗口 + lead_id 空」判 `UNAVAILABLE(structural:
   owner_index_incomplete)`,不静默归无主(防 registerSession 无条件覆盖的写入面)。
2. **R6 发布顺序**:同 PR 原子改规则+脚本;新脚本必须保持六步骨架与完成门结构不变,
   使旧规则 Lead 在重启前也能正常消费新报告。

其余 A1+B1+C1+D1+E1+F 维持,详见 plan.md。
