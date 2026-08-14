# FLY-1768 529 房 implement↔QA 返工环活体演练 — 调研

Issue: FLY-1768 (https://linear.app/geoforge3d/issue/FLY-1768/qafly-1765-529-房活体演练founder-直令装房-真单全环-implementship-parkedqa)
日期: 2026-08-14
基于: exploration.md

## 1. 被测代码的准确定位

PR #837 head = `fbff3c157`,worktree 已存在于 `~/Dev/flywheel-FLY-1765`(已核 `git worktree list`)。
相对 main 的源码改动面(排除文档):

```
packages/teamlead/src/StateStore.ts
packages/teamlead/src/bridge/plugin.ts
packages/teamlead/src/bridge/workflow-rework-coordinator.ts
scripts/restart-services.sh
scripts/test-restart-services.sh
```

⇒ 改动**全在 Bridge 进程内**(StateStore + bridge/*)。
结合 `reference_529_bridge_runs_script_repo_not_from_branch`:slot Bridge 跑的是 `test-deploy.sh`
所在仓库的代码。**所以必须从 `~/Dev/flywheel-FLY-1765` 调脚本**,否则被测的 Bridge 是 main = 假绿。

## 2. Fix 1 的判据链(实测源码,非转述)

`StateStore.ts:26763-26770` `projectGeneralizedCompletionTx`:

```ts
const reworkReachableLandCompletion =
    input.route === "needs_review" &&
    run.engine_owned === 1 &&
    run.gate_carrier_epoch === 1 &&
    gateAuthority?.mode === "land" &&
    node?.type === "implement" &&
    node?.capabilities.creates_pr === true;
```

命中 → `projectedStatus = "ship_parked"`(`:26771-26783`),
并在 `:26818-26834` 落台账:

```ts
if (projectedStatus === "ship_parked") {
  this.appendWorkflowEngineParkEventTx({
    eventId: `engine-park-open:${binding.activation_id}`,
    event: "park_opened",
    reason: reworkReachableLandCompletion ? "rework_reachable_wait" : "runner_ship_gate_wait",
    ...
  });
}
```

**关键旁证**:`projectedStatus === "completed"` 分支才会 `applyTerminalTimestamp`(`:26841-26847`)。
所以 `ship_parked` 路径**不打终态戳**——这正是 wake 闸能放行的物理原因。

## 3. wake 闸(未改动,靠状态放行)

`packages/teamlead/src/bridge/holder-wake-activation.ts:41-51`:

```ts
if (fresh.status === "approved_to_ship") return { ok:false, error:"state_not_revivable:approved_to_ship" };
if (fresh.status !== "running" && fresh.status !== "ship_parked" &&
    fresh.status !== "design_done" && fresh.status !== "awaiting_review")
  return { ok:false, error:`state_not_revivable:${fresh.status}` };
```

⇒ `completed` 被拒(= 事故原形),`ship_parked` 放行。**闸零改动**,证实 plan 的说法。

**库层判据**:`workflow_rework_delivery` 表的 `state` 列,取值域
`pending | turn_granted | wake_delivered | replacement_pending | completed | held | needs_lead`
(`StateStore.ts:2031`)。演练第 4 步断言 = 该表出现 `state='wake_delivered'`,
且**不出现** `holder_activation_failed:state_not_revivable:completed`
(失败会写进 `last_error` / run event,`workflow-rework-coordinator.ts:406`)。

## 4. 5 个 workflow flag(与生产逐字对齐)

从 `packages/config/src/feature-flags/registry.ts` + `workflow-template-dispatch.ts` 取得 env 名,
并从**生产 Bridge 活进程**(`ps -Eww -p 50872`)读到真实取值 —— 两边一致:

```
FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES=1
FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1
FLYWHEEL_WORKFLOW_CLAIMS_READ=1
FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1
FLYWHEEL_WORKFLOW_GATE_CARRIER=1
```

`FLYWHEEL_LAND_NODE` 是 `!== "0"` 语义(默认开),不需要显式 export。

## 5. `workflow_category_binding` 的真实形态(从生产库只读取样)

```sql
CREATE TABLE workflow_category_binding (
  project TEXT NOT NULL,
  task_category TEXT NOT NULL DEFAULT '*',
  template_id TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project, task_category),
  FOREIGN KEY (template_id) REFERENCES workflow_template(template_id)
);
```

生产 5 行(`updated_by = system:fly-1436-cutover`):
`code→tpl_code`、`design→tpl_design`、`generic→tpl_generic_menu`、`prd→tpl_prd`、`prototype→tpl_prototype`。

⇒ 演练只需插 `code→tpl_code` 一行(project = slot 的项目名)。
外键指向 `workflow_template`,所以**必须等 Bridge 首次 boot 把 seed 编译进库之后**再插,
否则外键失败 —— 这也是"停 Bridge → INSERT → 起 Bridge"顺序的真正原因(比记忆里写的更精确)。

注:生产 StateStore 库是 `~/.flywheel/teamlead.db`(1.7GB),不是 `bridge-state.db`(0 字节的死文件)。
只读取样用 `sqlite3 "file:...?immutable=1"`,零写入。

## 6. QA verdict 的真实入口

`packages/flywheel-comm/src/commands/qa-result.ts`,CLI `flywheel-comm qa-result`。
凭据是 per-exec 一次性的(见 `reference_qa_second_verdict_replay_payload_mismatch`:
同一 exec 第二次落 verdict 会 409 `replay_payload_mismatch`)—— 演练里 QA attempt 1(FAIL)
与 attempt 2(PASS)是**两个不同 attempt / 不同凭据**,所以不撞这条。

## 7. 房间参数(实测)

- slot 端口:`19871..19874`(`~/.flywheel/test-slots.json`,不是记忆里写的 `198<slot>`)。
- 4 个 slot 当前**全空**(4 个端口 `/health` 无响应、无 `/tmp/flywheel-test-slot-*.lock`、无 slot 目录)。
- `~/.flywheel/state/complete-failed/` **为空** ⇒ 坑 #8(boot drain 误吞生产 marker)本轮不成立。
- 宿主 load average ≈ 19(12 天未重启,37 users)。属高负载,但演练不跑全量 vitest,
  按 `feedback_short_timeout_probe_is_not_service_state`,所有探针给宽超时。

## 8. 仍未解且必须在真机上量的(不预设答案)

| # | 问题 | 只能真机答的原因 |
|---|---|---|
| R1 | 真实 `tpl_code` 编译后 implement 节点是否 `type=implement` 且 `creates_pr=true` | seed 编译产物,源码里是 YAML |
| R2 | 真实 run 的 `gateAuthority.mode` 是否 `land` | 由 manifest 解析,run 起来才知道 |
| R3 | run-start 是否真的写 `gate_carrier_epoch=1` | 取决于 flag 在 Bridge 进程内的可见性 |
| R4 | codex implement 体完工后是否真进 phase hold(pane 活、goal paused) | FLY-1269 resident controller 的真机行为 |
| R5 | founder gate 在 implement `ship_parked` 期间能否正常投递 | 护栏用例的活体版 |
| R6 | land finalization 后 `park_cleared` 是否真落账、session 是否真 `completed` | 依赖 dispatcher 真实时序 |

**诚实边界**:驱动真 codex implement 体到"完工"没有现成 e2e 驱动(唯一驱动被 FLY-1693 退役)。
本单按任务书授权用**最小真单**(改动面极小)驱动;若真机上某一步无法在合理成本内驱动,
按 `feedback_report_blockers_as_falsifiable_not_verdicts` 报可证伪的障碍,不报成品结论。
