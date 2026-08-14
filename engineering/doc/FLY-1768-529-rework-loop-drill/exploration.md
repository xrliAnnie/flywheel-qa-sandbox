# FLY-1768 529 房 implement↔QA 返工环活体演练 — 探索

Issue: FLY-1768 (https://linear.app/geoforge3d/issue/FLY-1768/qafly-1765-529-房活体演练founder-直令装房-真单全环-implementship-parkedqa)
日期: 2026-08-14
基于: 无(本单为独立 QA 执行节点;上游是 FLY-1765 plan §6)

## 1. 这一单要证明什么

FLY-1765(PR #837 @ `fbff3c157`)修的是**返工环断裂**:FLY-1655 之后 implement 节点体完工即被投影成
`completed` 终态,QA-FAIL 触发的返工 wake 闸(FLY-939 只唤停驻体)100% 拒绝 → `state_not_revivable`。

修法两层:
- **Fix 1**:land-authority run 的 `type=implement` + `creates_pr` 节点完工投 `ship_parked`(不是 `completed`),
  并落 `park_opened / reason=rework_reachable_wait` 台账;wake 闸零改动 —— 因为体还在停驻态,闸自然放行。
- **Fix 2**:终态残局(部署窗遗留 / 体被清)走既有 proven-dead replacement,不伪造死亡账、不首跳 needs_lead。

FLY-1765 的 QA 已经判 PASS,但**活体演练判 C 延后**。founder 在 2026-08-14 08:41 PDT 明确否决:
「你这个qa没有跑529测试房e2e啊!」→ 本单补的就是这段:**真机、真库、真状态机地把九步环路跑一遍**。

## 2. 为什么读码不能代替这次演练

Fix 1 的判据链有五个合取项(`route === "needs_review"` && `engine_owned===1` && `gate_carrier_epoch===1`
&& `gateAuthority.mode === "land"` && `node.type==="implement"` && `creates_pr===true`,
`StateStore.ts:26763-26770`)。单测能钉死每一项,但**钉不死"生产 compiled menu 真的会给出这组值"**:

- `gate_carrier_epoch` 是 run-start 时按 flag 写的,单测里是构造出来的;
- `gateAuthority.mode` 来自真实编译后的 manifest(`resolveWorkflowGateAuthority`),
  单测用的是 fixture snapshot;
- `node.type`/`creates_pr` 来自真 `tpl_code` seed,不是手写的节点定义。

也就是说:**判据全对但真实 run 一个都不命中**,单测会全绿,生产会 100% 走 `completed` 老路。
这正是 founder 坚持要 529 e2e 的结构性理由 —— 它是唯一能同时验证"判据"与"真实取值"的地方。

第二条:park 结算(`park_cleared`)发生在 land finalization 之后,依赖 dispatcher 的真实时序
(`await landExecutor` 先把 `ship_parked` 投成 `completed`,之后才跑 settlement helper)。
plan §2.2 自己承认这是"land 生产顺序的必经腿",而这个顺序**只在真实 dispatcher 里成立**。

## 3. 已知的执行难点(诚实边界,任务书已点名)

**驱动真 codex implement 体到完工没有现成驱动** —— 唯一的 e2e 驱动被 FLY-1693 退役。
这意味着九步里最贵的那步(implement 体真干活并 `complete --route needs_review`)要靠:
- 最小真单(改动面极小,让 codex 体几分钟内能完工),或
- 直接以受控方式向 Bridge 提交 completion(但那样就是"读码代替",不被接受)。

任务书给的口径是:**允许最小真单,但环路每个断言必须真执行**。所以选项是前者。

## 4. 房间侧的已知坑(全部照抄,不重新踩)

来自 `reference_529_room_redeploy_gotchas` / `reference_529_bridge_runs_script_repo_not_from_branch`
/ `reference_529_room_from_runner_pane_env_traps`:

| # | 坑 | 绕法 |
|---|---|---|
| A | slot Bridge 跑的是 **test-deploy.sh 所在仓库**的代码,不是 `--from-branch` | 必须从 `~/Dev/flywheel-FLY-1765` 调脚本;开跑前用 `/health` 的 `buildSha` 对齐 `fbff3c157` |
| B | runner pane 继承半套 roundtable 配置 → slot Bridge fail-closed 自杀 | `unset FLYWHEEL_ROUNDTABLE_CHANNEL_ID FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD` |
| C | runner `TMPDIR` 89 字符 → tsx IPC socket 撞 `sun_path` 104 | `TMPDIR=/tmp/` |
| D | 干净 DB 没有 `workflow_category_binding` → DAG 跑不了;无 HTTP 路由能建 | 停 Bridge → sqlite INSERT → 起 Bridge |
| E | config 重生成抹掉 `pipeline.dag: true` | 补写;**不需重启 Bridge**(run-start 现读) |
| F | `inject-linear-issue.sh` 与 `TEST_REPLY_BY_ISSUE=1` 互斥(401) | 自己带 Bearer POST |
| G | `/api/runs/start` 带 `templateId` 必须同时带 `selectionReason` + `taskCategory` | 三个一起给 |
| H | FLY-913 部署护栏按命令串 pattern-match,会误伤(含报告正文) | 拆单目标命令;正文避开 Bridge 启动脚本字面量 |
| I | teardown 撞生产 cmux mutator lease | 重试一次通常过;两次不过上报 |
| J | 演练期间宿主 worktree 不许新 commit(隔离不隔代码,会漂) | 锁死 `flywheel-FLY-1765` worktree |

## 5. 待定问题(进 research)

1. 5 个 workflow flag 的准确变量名与取值。
2. `workflow_category_binding` 的真实列与 `tpl_code` 的 templateId / taskCategory 取值。
3. wake 投递的库层证据落在哪张表(判 `wake_delivered` vs `state_not_revivable`)。
4. QA 节点如何"故意 FAIL"(verdict 提交的真实入口 + 凭据来源)。
5. founder gate 在 implement 停驻期间仍正常投递 —— 用什么可观测量断言。
