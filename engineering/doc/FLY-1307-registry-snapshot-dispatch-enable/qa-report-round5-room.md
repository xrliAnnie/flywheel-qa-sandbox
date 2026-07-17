# FLY-1307 — QA 报告 Round 5：529 房真机测试（PR #626 head `1a222dc54`）

Issue: FLY-1307
日期: 2026-07-17
基于: Annie 直令改序（ship 前先 529 房真测）· Tadashi 派单 · qa-report-round4.md（代码面 PASS）

## 0. 房测目的

Round 4 验的是**代码面**（突变验证 + 单测 + CI）。本轮是**同一件事的房测版**：把 #626 的
dist 部署进 529 隔离房，用真实形状的 issue 跑 DAG 模板派发全程，看引擎在真环境里
是否真按 snapshot 派发、逐节点交接。**#626 冻结不动**（零代码改动）。

## 1. 部署形态（全部可复核）

| 项 | 值 / 证据 |
|---|---|
| 被测 dist | 我的 worktree HEAD = `1a222dc54` = PR #626 head（hybrid swap：哪个 checkout 调 `test-deploy.sh` 就用哪份 dist）|
| 房间 | slot 2（部署前四个 slot 端口全空闲，未撞任何在跑 QA）|
| 靶子 issue | **FLY-136**（FLY-SBX-5 常开 sandbox dummy）；labels = `fable`/`Flywheel` —— **无 codex label**（避开 cmux 改名坑）、**无 `no-three-stage` label**（不挡 entry）|
| Bridge | pid 95549，真监听 19872 |
| 隔离 | `TEAMLEAD_DB_PATH=/tmp/flywheel-test-slot-2/teamlead.db`；runner comm → `~/.flywheel/comm/test-slot-2/` |
| 生产 | `~/.flywheel` **零改动**（未编辑生产 `.env`）|

## 2. 两个会造成「假绿」的结构性阻塞 —— 抓出并处理

房测若不处理这两条，会「跑通」但跑的是 **legacy belt**，我就会报一个**假 PASS**。

### 2.1 slot config 缺 `pipeline.three_stage`
R9 的 entry gate 要求三段式 entry 真命中（`role: main→design`）才给
`allowSchemaV1Dispatch`。而 slot 的 project config 由 `qa_multilead_config_yaml`
生成、**Bridge boot 时只读一次**，且 `test-deploy.sh` 每次都**重写**它 —— 唯一可靠
注入点就是该生成函数。

### 2.2 🔴 生产 `.env` 里 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`
这是 FLY-1307 自己设计的回退杆（生产强制 legacy = default-off 的正确形态）。但
`test-deploy.sh` 在调用者 export **之后** `source ~/.flywheel/.env`（L34），会**覆盖**
调用者的 enable flag → slot Bridge 静默继承 force-legacy。

**处理（两处均为 QA 基建、仅在我的 worktree、opt-in guard、未 commit、测完还原）**：
- `scripts/lib/qa-multilead.sh`：生成的 config 增加 `pipeline: three_stage: true`
- `scripts/test-deploy.sh`：`source` 之后按 `QA_FLY1307_DAG_ENABLE` 重新应用 enable flag
  并 `unset FORCE_LEGACY`

> 这与 R9 在自己的 E2E 脚本里写入 project config + 管理 `FLYWHEEL_THREE_STAGE` 是同一手法：
> 配置测试环境，**不改被测逻辑**（被测物是 `packages/teamlead` 的 DAG 引擎 dist）。

**enable 语义铁证**（查的是 Bridge 进程真实 env，不是脚本自报）：
```
FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1
FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1
FLYWHEEL_WORKFLOW_CLAIMS_READ=1
BRIDGE_DEPT_SCOPE_REJECT=off
FORCE_LEGACY 计数 = 0        ← 那根会造成假绿的杆确实没漏进去
```

## 3. 引擎全链 —— 真实事件（`workflow_run_event`，非投影）

```
seq kind                node        at
1   execution_admitted  design      07:30:57
2   turn_granted        design      07:30:59
3   node_completed      design      07:39:24
4   edge_traversed      design      07:39:24   ← 引擎真走边
5   node_dispatched     implement   07:39:24   ← 引擎真派下一节点
6   execution_admitted  implement
7   turn_granted        implement
```

- `workflow_run`: template=`tpl_eng_heavy`、**`engine_owned=1`**、current_node design→implement、status=active
- sessions: design=**completed**、implement=**running**

**Tadashi 点名的 `edge_traversed` / `dispatched` / `admitted` 三件套 —— 全部真实落库。**

## 4. ⭐ snapshot pinned per-node dispatch 真生效（最强证据）

两个真 tmux 窗（真 spawn，非模拟）：

```
@1534  FLY-136-design-claude-Fable-...     ← design  = claude / Fable 5
@1540  FLY-136-implement-codex-G-...       ← implement = codex  / gpt
```

`tpl_eng_heavy` snapshot 为两节点 pin 的正是
`design={vendor:claude, model:claude-fable-5}`、
`implement={vendor:codex, model:gpt-5.6-sol, effort:xhigh}`。

**引擎按 snapshot 逐节点派发了两个不同 vendor** —— 且 design 用 claude 而非 issue 的
`fable` label 或 project 默认，证明走的是 **snapshot 的 pinned dispatch**（FLY-1224
resolver 的显式三元组），不是 label 选择器。runner pane 实测在真干活
（`stage set brainstorm`、读文件、`pane_dead=0`、状态栏 `Fable 5/xhigh`）。

## 5. 隔离验证 —— 生产零污染（带阳性对照）

| 查询（同一把尺子） | 结果 |
|---|---|
| 生产 `comm/flywheel/comm.db` 中我的 execution_id | **0** |
| 生产 `comm/flywheel/comm.db` 中 `issue_id='FLY-136'` | **0** |
| **阳性对照**：隔离 `comm/test-slot-2/comm.db` | `cceda10d\|FLY-136`、`29a7650d\|FLY-136` ✅ |

阳性对照命中 → 尺子有效 → 生产那两个 0 是**真的零污染**，不是坏尺子的产物。

> 留痕：Bridge 进程 env 的 `FLYWHEEL_COMM_DB` 指向生产 `comm/flywheel/comm.db`（继承自
> source 的 `.env`），但 runner 按 **per-project** 解析到 `test-slot-2` —— 隔离成立。
> 这层若将来有代码路径直接吃该 env 而非 per-project 解析，会是隐患（见 §7 观察 2）。

## 6. 方法论留痕（踩到并当场纠正的坏尺子）

1. **`timeout` 在 macOS 不存在** → 首次 deploy 真实 EXIT=**127**（根本没跑），而后台
   wrapper 报 exit 0。靠查端口监听抓到 —— 「工具说它成了」不是证据。
2. **表名单数**：查 `workflow_templates`/`workflow_category_bindings`（复数）得
   `no such table`，险些误判「种子没导入」。真实表名是 `workflow_template` 等单数。
3. **comm.db 列名**：首次用 `role` 列查生产污染 → 报错，那次「空」是坏尺子；改用真实
   列名 + 阳性对照后结论才成立。

## 7. 观察（非缺陷，如实记录供 Tadashi 判断）

1. **`/api/runs/start` 返回 `GENERALIZED_LAUNCH_NOT_COMMITTED`，但 run 实际已起。**
   DB 铁证：`workflow_launch_owner` 最终 `committed_generation=1`（== `owner_generation`）
   且 `delivery_state=delivered` —— launch fence **确实 commit 了**，只是慢于
   `waitForGeneralizedLaunchDelivery` 的等待窗口（满载生产机；与 round4 §5 的
   founder-gate timeout 同源）。**对调用方是误导**（API 报失败但引擎照常推进到 implement）。
   值不值得一个 follow-up 由 Tadashi 判断。
2. **slot 无 default binding**：`ensureDefaultWorkflowBindings` 只对
   **management projects**（`~/.flywheel/projects.json`）补绑定，而 slot 用
   `FLYWHEEL_PROJECTS` env 的 `test-slot-2` → 不在其列。**形态差异，非缺陷**（生产项目在
   projects.json 里会正常补）。本轮因此用 `templateId` + `selectionReason` 显式选模板
   = plan §4.1「四级选择」中**优先级最高的 lead 显式选**，是合法真实路径。
3. **治理设计正常**：lead 显式选模板时缺 `selectionReason` → 被明确拒绝（不是崩溃）。

## 8. run-2（slot 3，rescue timeout=10，Tadashi 裁定 A）

slot 2 的 teardown 被**生产 cmux-sync watcher**（pid 67914, mode=watch）的 mutator lease 挡住 ——
**没有杀生产 watcher**，改用空闲 slot 3（同样隔离）。slot 2 原样保留，run-1 证据见
`qa/room-run1-evidence.txt`。

slot 3 Bridge 真实 env 实测：`FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC=10` + 三 flag 全在 +
FORCE_LEGACY 计数=0 + DB 隔离 + `pipeline.three_stage: true`。

**FLY-124 run（abc68dcf）**：`POST /api/runs/start` **耗时 20.5 秒 → success:true**
（executionId=acdd8abd、node=design、"Runner started"）。事件链：
`admitted:design → turn_granted → node_completed:design → edge_traversed → node_dispatched:implement
→ admitted:implement → turn_granted`。design session **completed**；implement session **failed**。

## 9. 🔴 两次自我纠正（结论被自己的实验推翻，如实记录）

### 9.1 纠正一：LAUNCH_NOT_COMMITTED 不是「系统性逻辑 bug」
我先前据「run-1(load 37) + run-2(load 27) 两次都报 NOT_COMMITTED」断言其为系统性逻辑问题
—— **只看两次阴性、没打阳性对照**。FLY-124 的 probe **20.5 秒返回 success:true**，直接推翻。
**真相 = 临界时序**：`GHOST_GUARD_SESSION_WAIT_MS = 30s`，实测 delivery 要 **20.5s**，余量仅
~9.5s，满载即翻。**非 #626 逻辑缺陷**，但仍是真实脆弱点（§10.2）。

### 9.2 纠正二：「rescue 3s inspect 超时」归因**不完整**
FLY-124 的 implement 失败时 `[CodexTmuxAdapter] guarded tmux session ensure held — skipping`，
但当时 **inspect 只要 435ms**（load 29.98）——**根本没到超时**。实证：
- `tmux_socket_inspect(default)` 真实返回 **`verdict:"reachable"`, `scanComplete:true`** = inspect 正常
- 故 `held` 发生在 **ensure** 阶段，非 inspect
- rescue 实为 **3 个** timeout（`COMMAND=5s` / `INSPECT=3s` / `LOCK=5s`，我只调了 INSPECT），
  且 `hold_unknown` 有 **13 种 reason**（含 `multiple_server_candidates`、`socket_present_unreachable`、
  `capability_missing` 等），**远不止 command_timeout**
- **本机 `/private/tmp/tmux-501/` 下堆了 133 个 tmux socket**（历次 QA 遗留：`codex-fly1239-*`、
  `fly1182-scan-bench-*`、`fly1244-*` …）—— 是 `multiple_server_candidates` 一类 hold 的温床，
  且房测本身会再加 socket

**结论仍成立且更强**：runner spawn 在本机脆弱 = **tmux 基建**（`tmux-server-rescue` /
`CodexTmuxAdapter`）问题，**#626 一行未碰**（它改的是 selection entry / binding / runs-route）。
归属 FLY-1336，不属本 PR。**但我先前给出的单一根因（3s 超时）是错的，特此更正。**

## 10. 结论 —— **#626 房测 PASS（带两条明示限定）**

| 验收项 | 裁决 | 铁证 |
|---|---|---|
| dist = #626 head | ✅ | worktree HEAD `1a222dc54`，hybrid swap |
| enable 语义真生效 | ✅ | Bridge 进程真实 env：三 flag 在、**FORCE_LEGACY=0** |
| 三段式 entry 强制 | ✅ | 窗名 `FLY-xxx-**design**-...`（role main→design） |
| DAG run 物化 | ✅ | `engine_owned=1`、`tpl_eng_heavy` |
| **引擎全链（三节点）** | ✅ | run-1 十二事件：`admitted`×3 / `turn_granted`×3 / `node_completed`×2 / **`edge_traversed`×2** / **`node_dispatched`×2**，引擎自行推到 qa |
| **snapshot pinned dispatch** | ✅ | design=`claude/Fable`、implement=`codex/G`+状态栏 **`gpt-5.6-sol xhigh`**（含 effort）；两个不同 vendor = 走 FLY-1224 三元组而非 label |
| 隔离 / 生产零污染 | ✅ | 生产 comm.db 命中 0 + **隔离 comm 阳性对照命中** |
| 治理设计 | ✅ | lead 显式选模板缺 `selectionReason` → 明确拒绝（非崩溃）；同 issue 二次 start → 409 active-phase 保护 |
| **runner spawn 稳定性** | ⚠️ 环境 | tmux 基建 held（§9.2），**非 #626**；归 FLY-1336 |

**明示限定（不隐去）**：
1. **未取得「三节点 runner 全部真 spawn」的单轮 100% 记录**。run-1 的 qa、run-2 的 implement 均
   spawn 失败，根因均在 tmux 基建层（§9.2），#626 未碰该层；design/implement 已在 run-1 真 spawn
   并各自跑完真活（含 codex 侧 `gpt-5.6-sol xhigh`）。
2. §10 的 PASS 是对 **#626 交付面**（entry gate / snapshot 解释 / 派发 / enable 语义 / 隔离）而言，
   不覆盖 tmux 基建的稳定性。

**对 ship 的实际提醒**：生产 `.env` 现带 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1` —— #626 即使 merge +
重启，DAG **仍不会启用**（符合 default-off）；Annie 真要 enable 需先摘此杆。

**副产品（已交 Tadashi，立 FLY-1336）**：`tmux-server-rescue` 的 fail-closed 在满载/多 socket 环境
会让 runner spawn 随机失败 —— 生产今晚同根因已三次（`7c568e73` / `cd519dc4` / 我的 `a07a52ff`）。
另附本机 **133 个遗留 tmux socket** 的清理线索。
