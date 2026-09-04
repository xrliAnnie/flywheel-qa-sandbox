# FLY-2148 runner 记忆落地 — 独立 QA 报告(判决:FAIL)

Issue: FLY-2148 (https://linear.app/geoforge3d/issue/FLY-2148/2132b1-runner-记忆落地角色项目目录-短索引送达-写入时机与截断防护)
日期: 2026-09-04
基于: plan.md(§5 / §5.1 验收命令)、FLY-1984 Epic PRD §B

## 0. 被验的头

| 项 | 值 |
|---|---|
| PR | #1074 `feat(runner-memory): persist closeout receipts and attribution (FLY-2148)` |
| PR head(判决时) | `9ca0f9ce44e33ec9e586d3e613d23d1485733238` |
| 该头 CI | **13/13 全绿**(含 `CI OK`、`Unit (heavy)`、`Unit (teamlead 1..3)`、4 组 Script Tests) |
| 529 房 slot Bridge 跑的字节 | `/Users/xiaorongli/Dev/flywheel-FLY-2148`(`room-info.json.flywheelRepo`),即被测 checkout;`FLYWHEEL_COMM_CLI` 也指向该 checkout 的 `dist` |
| 529 房 | slot 1,port 19871,`--generalized --stub-runner`,`TEST_REPLY_BY_ISSUE=1` |

> QA 侧只追加了 `progress.md` 台账 commit(`chore(progress)`),不改产品代码。

## 1. 判决

**FAIL — 一条阻塞缺陷。**

其余全部验收(PRD B 四条 + Lead 硬要求 ②「截断可见」+ `off` 阴性对照)在真机上通过,见 §3。

## 2. 阻塞缺陷:generalized DAG 节点的收口回执被 Bridge 静默丢弃

### 2.1 现象

用 `complete` 收口的 **generalized(DAG)工作流节点**(design / implement / 任何非 QA 节点),
它的 runner-memory 收口回执**不会**被 Bridge 记录:

- Bridge 日志里**没有**任何 `[event-route] runner-memory closeout …` 行;
- `sessions.runner_memory_closeout` / `runner_memory_receipt` 两列**保持 NULL**。

只有走 `qa-result` → `/api/workflow/decision` 的 QA 节点落了列。

### 2.2 真因(代码位置)

`packages/teamlead/src/bridge/event-route.ts`:

- `:719` 起是**第一个** `session_completed` 分支。对 `source === "flywheel-comm"` 且
  **已入册 generalized 工作流节点**的执行体,它在 `:1002` 的
  `if (!(completion.ok === false && completion.reason === "not_enrolled"))` 里处理完,
  并在 `:1027` / `:1040` / `:1061` 每条子路径上 `return`。
- FLY-2148 的解析 / 日志在 `:1445`,两个落列点在 `:1982` 与 `:2148`,
  它们都在**第二个** `session_completed` 分支(`:1437` 的 `} else if …`)里。

⇒ **已入册的 DAG 节点永远到不了 `:1445`**;回执随响应一起被丢掉。
未入册(非 generalized)的会话才走到 FLY-2148 那段。

### 2.3 判别式证据(同一台 Bridge,一次运行内)

| 执行体 | issue / 角色 | 收口命令 | `runner_memory_arm` | `runner_memory_closeout` |
|---|---|---|---|---|
| `8ea20441` | FLY-202 / design | `complete` | role | **(NULL)** |
| `ca70a4ce` | FLY-202 / implement | `complete` | role | **(NULL)** |
| `d72d3f37` | FLY-108 / design | `complete` | role | **(NULL)** |
| `35a94296` | FLY-108 / implement | `complete` | role | **(NULL)** |
| `37111014` | FLY-197 / design | `complete` | role | **(NULL)** |
| `d09c8aa1` | FLY-197 / implement | `complete` | role | **(NULL)** |
| `e52ca003` | FLY-202 / qa | `qa-result` | role | `unchanged`(receipt 411 B)✅ |

同一份 `bridge.log` 里:
`grep -c "event-route.*closeout" = 0`(6 个 `complete` 节点),
`grep -c "workflow-decision.*closeout" = 1`(唯一的 `qa-result` 节点)。

**排除「CLI 没发」**——真机跑被测 `dist` 的 `flywheel-comm complete`,回执行在 POST 之前就打印:

```
[complete] runner-memory closeout state=written dir=…/test-slot-1/eng_design index=4L/194B delta=+1L/+1files budget=160L/20000B hard=200L/25000B
```

**阳性对照(同一台 Bridge、同一个合形回执、只把执行体换成未入册的)**:

```
[event-route] runner-memory closeout state=written dir=…/test-slot-1/eng_design index=4L/194B delta=+1L/+1files budget=160L/20000B hard=200L/25000B exec=22222222-2222-4222-8222-222222222222
```

⇒ 差异只在「入册 / 未入册」,不在 CLI、不在回执形状、不在 Bridge 版本。

### 2.4 为什么算阻塞

- Lead 硬要求 ①「三态入 `sessions` 独立列、可单独 SQL 查询」在生产主力拓扑(DAG)上,
  对 design / implement 节点**不成立**;
- flag `runner_memory_mode` 的退役判据要靠这几列统计「写入率」,
  现在样本只剩 QA 节点,系统性偏斜;
- plan §0.1 与 milestone 都声明「Bridge 两处各落一次」,其中一处对 DAG 节点不可达 ——
  按原样合入会把一句不成立的话交到 founder 面前。

### 2.5 修法方向(不是我的活,仅供实现节点参考)

在 `:1002` 那个 generalized 分支的**每个已接受响应点之前**,调用与
`workflow-decision-routes.ts` 同一个 `persistRunnerMemoryCloseout(...)`(或同形逻辑),
执行 id 取 `event.execution_id`。回归断言至少要覆盖「入册节点 `complete` ⇒ 两列已写」。

## 3. 通过项(真机证据)

### 3.1 迁移与列

真 slot DB `PRAGMA table_info(sessions)`:
`runner_memory_arm / runner_memory_dir / runner_memory_spawn / runner_memory_closeout / runner_memory_receipt` 五列全部就位(TEXT、nullable)。

### 3.2 分流归因(新能力,全节点有效)

```
[Blueprint] runner-memory selection mode=role arm=role issue=FLY-202
[Blueprint] runner-memory mounted backend=claude-tmux project=test-slot-1 role=eng_design dir=… index=3L/124B … first_run=true over_budget=false
[DirectEventSink] runner-memory selection persisted exec=8ea20441-… arm=role
```
`sessions` 行:`arm=role`,`dir=…/test-slot-1/eng_design`,
`spawn={"lines":3,"linesExact":true,"bytes":124,"sha16":"df8450fac1d2ff2d","topicFiles":0}`。
codex-tmux 后端(implement 节点)同样落了 arm/dir/spawn。

### 3.3 spawn 快照真的到了 runner 进程

真 runner pane 的 `ps eww`:
```
FLYWHEEL_RUNNER_MEMORY_DIR=/Users/xiaorongli/.flywheel/runner-memory/test-slot-1/eng_design
FLYWHEEL_RUNNER_MEMORY_SNAPSHOT={"lines":3,"linesExact":true,"bytes":124,"sha16":"df8450fac1d2ff2d","topicFiles":0}
```
与 DB `runner_memory_spawn` 逐字段相同(同一次度量,没有二次读盘)。

### 3.4 写入时机合同进了真 prompt

真 runner 的 `append-system-prompt.md` `## Runner Memory` 段含逐字合同行
`- Write rule (closeout contract, FLY-2148): …`。

### 3.5 PRD B 四条验收

| PRD 判据 | 结果 | 证据 |
|---|---|---|
| ① runner 起来读得到「它这个角色+这个项目」的记忆、不是空的 | ✅ | 第二次 eng_design 起来时 prompt 报 `Index MEMORY.md: 4 lines / 194 bytes — within budget`,`first_run=false` |
| ② 同角色同项目第二次跑读得到第一次写的 | ✅ | 第一次(FLY-202/eng_design)写入 nonce `001e10d1fc45ea02`;第二次(FLY-108/eng_design)spawn 快照 `sha16=c0b3bdcbcbd6a097` == 该文件真实 `shasum` 前 16 位;文件内容含同一 nonce |
| ③ 换 issue 换工作目录读到同一份 | ✅ | 两个执行体 issue 不同(FLY-202 / FLY-108)、worktree 不同(`project-slot-1-FLY-202` / `-FLY-108`),`runner_memory_dir` 相同 |
| ④ 工作目录清掉后写下的还在 | ✅ | `git worktree remove --force project-slot-1-FLY-202` 后目录消失,记忆目录文件与 `sha16=c0b3bdcbcbd6a097` 逐字不变,nonce 仍可读 |

### 3.6 Lead 硬要求 ②:截断可见、不静默(两面都验)

**spawn 面**(灌到 218 行后起 FLY-197):
```
[Blueprint] runner-memory OVER BUDGET … index=218L/15602B budget=160L/20000B hard=200L/25000B first_dropped_line=201
```
prompt:`⚠ Index MEMORY.md OVER BUDGET: 218 lines / 15602 bytes … entries from about line 201 onward were NOT loaded this session.`

**收口面**(真 CLI):
```
[complete] runner-memory closeout state=over_budget dir=… index=218L/15602B delta=+214L/+0files first_dropped_line=201 — MEMORY.md is over budget; consolidate topic files and replace or drop superseded pointers before you finish (the next runner will NOT load entries from about line 201 onward).
```
先证会红:灌之前同一路径打的是 `within budget` / `state=written`。

### 3.7 `off` 阴性对照

flag 改回 `off` 后新铸的执行体 `8d980a63`(FLY-197 / qa):
`runner_memory_arm='off'`,`runner_memory_dir`/`runner_memory_spawn`/`closeout`/`receipt` 全 NULL,
pane 无 `FLYWHEEL_RUNNER_MEMORY_*`。与 §0.6 合同一致。

### 3.8 测试

- 本机聚焦套件:`flywheel-config` 759 ✅ · `flywheel-edge-worker` 1303 ✅(5 skipped) ·
  `flywheel-claude-runner` 1023 ✅(3 skipped)· `flywheel-comm` 133 文件 ✅ ·
  `flywheel-teamlead` FLY-2148 相关用例全绿。
- 本机首轮 `claude-runner` 9 红 / `teamlead` 25 红 **全是环境问题,不是 PR 缺陷**:
  claude-runner 那 9 条是继承来的超长 `TMPDIR` 撞 `AF_UNIX` 104 字节上限
  (`daemon socket path is 119 bytes, exceeds…`);把 `TMPDIR=/tmp/fly2148t` 后同样 4 个文件 **62/62 全绿**。
  teamlead 那 25 条是并发的 slot Bridge / slot tmux / 真机账号状态所致(bridge.test、
  claude-profile-cli.integration、real-tmux、fly247 bash 套件),都不在本 PR 触碰的模块里。
- 权威判据是 **PR head 的 CI:13/13 全绿**。
- 预变更 byte golden:三组 fixture 只有一个 commit `2c1ad7800`,其父 commit 的 `packages/` 树
  与声明的基线 `ee3349456` 的 `packages/` 树 sha 相同(`d6bc0e35…`)⇒ golden 确实是在未改动的源上捕获的。

## 4. 诚实边界(没验到的)

- **没有让真 Claude runner 自己按 prompt 写记忆**:529 房用的是 stub runner。
  「写不写」本来就由 runner 遵守 prompt 决定(plan §6 已声明非阻塞),
  本次由 QA 代写 nonce 来驱动 `written` 判定;`unchanged` 那条是真 runner 自己跑出来的。
- **没有跑 `pnpm test:packages:run` 全仓**:本机有会真开 Terminal.app 的 GUI 用例
  (`packages/core/test/tmux-viewer.macos.test.ts`,FLY-2314/2327 正在处理),
  全仓证据以该头 CI 为准。
- **`--real` 模式没跑**:成本与本缺陷无关(缺陷在 Bridge 侧,与 runner 真假无关)。
- **9 步 driver 只跑到 step 5**:step 6 是已知缺陷 FLY-2208(QA attempt 1 占住跑道),
  与本 PR 无关;步骤 1-5 已覆盖 design/implement/qa 三种节点的收口。
- **`shared` 臂没有目录也没有回执**,本次只验了 `role` 与 `off` 两臂。
- **回执可信度 = runner 自报**,Bridge 只校验形状不复量(plan §6 已声明)。

## 5. 复现命令

```bash
TEST_REPLY_BY_ISSUE=1 BRIDGE_DEPT_SCOPE_REJECT=off TMPDIR=/tmp/fly2148t \
  bash scripts/test-deploy.sh 1 --generalized --stub-runner       # 从被测 checkout 起房
sqlite3 /tmp/flywheel-test-slot-1/teamlead.db \
  "UPDATE flag_values SET has_override=1, raw_value='role', last_effective='role', revision=revision+1 \
   WHERE flag_name='runner_memory_mode' AND scope='*';"
node scripts/qa-529-generalized-e2e.mjs 1 --issue FLY-202          # 跑到 step 5 即可
sqlite3 -header /tmp/flywheel-test-slot-1/teamlead.db \
  "SELECT execution_id,session_role,runner_memory_arm,runner_memory_closeout FROM sessions;"
grep -c "event-route.*closeout"      /tmp/flywheel-test-slot-1/bridge.log   # => 0
grep -c "workflow-decision.*closeout" /tmp/flywheel-test-slot-1/bridge.log  # => 1
scripts/test-teardown.sh 1
```

---

# Round 2 — 修复头复验(判决:PASS)

日期: 2026-09-04
判据: `~/.flywheel/artifacts/fly2148/qa-criteria.md` + Lead round-2 追加项 (A)-(E)
Round 1 的逐条判据核验另见 `~/.flywheel/artifacts/fly2148/qa-criteria-verification.md`

## R2.0 被验的头

| 项 | 值 |
|---|---|
| PR head | `51a58d0058bb202ffa497289497410a0d404f158` |
| 该头 CI | **13/13 全绿**(`CI OK` · `Quick Gate` · `Unit (light/heavy)` · `Unit (teamlead 1..3)` · 4 组 Script Tests · NPM payload · Classify) |
| 相对 round-1 头的产品 delta | 只有 3 个文件:`event-route.ts` +7、`workflow-decision-routes.ts` 1 行类型放宽、`event-route.test.ts` +47(新用例) |
| 529 房 slot Bridge 自报 | `[bridge-boot] running HEAD=51a58d0058bb202ffa497289497410a0d404f158` |
| review | `676eb551` APPROVED(Lead 告知) |

## R2.A 阻塞缺陷已在真机上关闭 ✅

修法(`19d1a16ce`):把 `persistRunnerMemoryCloseout(...)` 提到 `event-route.ts:1002`
那个「已入册 generalized」分支的**最前面**,即在 `:1027/:1040/:1061` 全部 early return **之前**;
`persistRunnerMemoryCloseout` 的 `logPrefix` 类型放宽到也接受 `"[event-route]"`。
两条 Bridge 落列路径现在共用**同一个**函数。

**真机结果**(529 slot 1,三次 generalized run,全部 `--stub-runner` 真 tmux pane + 真 CLI):

| exec | issue / 角色 | 收口命令 | `runner_memory_closeout` | receipt |
|---|---|---|---|---|
| `79e02262` | FLY-202 / design | `complete` | `unchanged` | 419 B |
| `a7776907` | FLY-202 / implement | `complete` | `written` | ✓ |
| `311b5aac` | FLY-108 / design | `complete` | `written` | ✓ |
| `f27b9071` | FLY-108 / implement | `complete` | `unchanged` | ✓ |
| `d8521401` | FLY-197 / design | `complete` | **`over_budget`** | ✓ |
| `a9fc28a2` | FLY-197 / implement | `complete` | `unchanged` | ✓ |
| `29091532` | FLY-202 / qa | `qa-result` | `unchanged` | ✓(`/decision` 路径未回归) |

**6/6 个走 `complete` 的 generalized DAG 节点全部非 NULL**(round 1 是 0/6)。
`grep -c "event-route.*runner-memory closeout" bridge.log` = **8**(round 1 = 0;8 = 6 个真节点
+ 1 个真节点的二次收口 + 1 个未入册阳性对照)。三态在 event-route 面全部出现过:

```
[event-route] runner-memory closeout state=written     … delta=+1L/+1files budget=160L/20000B hard=200L/25000B exec=311b5aac-…
[event-route] runner-memory closeout state=unchanged   … delta=+0L/+0files — nothing new was written this execution; … exec=79e02262-…
[event-route] runner-memory closeout state=over_budget … index=218L/16256B delta=+0L/+0files first_dropped_line=201 — MEMORY.md is over budget; … (the next runner will NOT load entries from about line 201 onward). exec=d8521401-…
```

Lead 硬要求 ① 的那句 SQL 现在真的答得出来:

```sql
SELECT execution_id,issue_id,session_role,runner_memory_dir FROM sessions WHERE runner_memory_closeout='over_budget';
-- d8521401-22f2-46e7-b124-1c0af4e6ceb0|FLY-197|design|…/test-slot-1/eng_design
```

**未入册阳性对照保留且仍绿**:同一台 Bridge,同一份合形回执,执行体换成未入册的
`33333333-…` ⇒ `[event-route] runner-memory closeout state=written … exec=33333333-…`。
⇒ 入册 / 未入册两条路径现在**都**落列,判别式不再有差。

## R2.B 新用例在旧头红、在新头绿 ✅

用例:`event-route.test.ts` 的 `persists runner-memory closeout for an accepted generalized completion`
(先 `bindGeneralizedExecution(store,"exec-1")` 把执行体入册,再发真 `POST /events`,
断言两列都写)。

三段齐:

| 步骤 | 结果 |
|---|---|
| 新头 `51a58d005` 原样 | `87 passed (87)` ✅ |
| 就地撤掉 `19d1a16ce` 那 6 行(= `9ca0f9ce4` 的产品字节) | **恰 1 条红**,正是新用例:`AssertionError: expected {…} to match object { runner_memory_closeout: 'unchanged' }`;其余 86 条仍绿 |
| `git checkout --` 还原 | `event-route.ts` sha16 回到 `ed810c9831f1bf43`,`git status` 干净,复跑 `87 passed (87)` ✅ |

## R2.C round-1 通过项抽检(未全量重跑)

| round-1 通过项 | 抽检结果 |
|---|---|
| 5 列迁移 | 新房 `PRAGMA table_info(sessions)` 五列在(70..74) ✅ |
| arm/dir/spawn 归因(claude-tmux + codex-tmux) | 9 个执行体全部 `arm=role` + dir + spawn 已落 ✅ |
| snapshot env 到真 pane 且与 DB 列一致 | 真 pane `ps eww`:`FLYWHEEL_RUNNER_MEMORY_SNAPSHOT={"lines":5,…,"sha16":"5830eb76c9b53ce1","topicFiles":2}` ✅ |
| PRD B ②③ 跨执行/跨 issue/跨 worktree 读回 | 更强的一次:round-1 写入的记忆**跨整间房的拆建**存活 —— 新房 eng_design 首次挂载即 `index=4L/194B first_run=false`;qa 角色 `4L/196B first_run=false` ✅ |
| PRD B ④ worktree 删除后仍在 | `git worktree remove --force project-slot-1-FLY-202` 后目录消失,记忆目录 4 个文件与 `sha16=5d4d1348f93abe69` 逐字不变,nonce `ebd2d1a2a67b2511` 仍可读 ✅ |
| 截断两面可见 | spawn 面 `OVER BUDGET … first_dropped_line=201`;收口面这次**直接从 Bridge 落列面**拿到 `state=over_budget`(round 1 只有 CLI 面)✅ |
| 写入时机(item 2) | 对**重建后的 dist** 重跑真 fs mtime/sha 轨迹:`ITEM2 PASS (0 failures)` ✅ |
| golden 是活的 | fixture 文件在两头之间**零改动**(delta 里没有任何 fixture);config/edge-worker/comm/teamlead 的记忆相关套件全绿 ✅ |
| `off` 阴性对照 | ⚠️ **本轮没有重新真机跑**:三条 run 的节点在我翻 flag 前已全部起完,没有新 spawn 可抓。依据是 `off` 路径的字节在两头之间**完全没变**(delta 只碰 teamlead 的 event-route/workflow-decision),且 `persistRunnerMemoryCloseout` 第一行就是 `if (raw === undefined) return;`(off ⇒ payload 无回执 ⇒ 静默 no-op)。round 1 的真机证据(`arm='off'`、其余四列 NULL、pane 无记忆 env)仍然成立 |

## R2.D 本轮聚焦套件(全部 single-package,`VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`)

| package / 文件 | 结果 |
|---|---|
| `teamlead` `event-route.test.ts` | 87/87 |
| `teamlead` `StateStore.fly2148` + `DirectEventSink` + `workflow-decision-runner-memory` | 61/61 |
| `comm` `runner-memory-closeout` + `complete` + `qa-result` | 165/165 |
| `config` `runner-memory-index` | 44/44 |
| `edge-worker` `Blueprint.fly2147` + `Blueprint.fly2148` + `runner-memory` | 67/67 |

从未 `pnpm -r test` / `test:packages:run`,从未跑 `packages/core`(`tmux-viewer.macos.test.ts` 不可能被触发)。

## R2.E 诚实边界

- `off` 阴性对照本轮未重跑真机(理由与依据见 R2.C 最后一行);要 100% 消除这条,
  下一次开房时先把 flag 设成 `off` 再注入第一条 run 即可,成本很低。
- 依旧用 stub runner:**「runner 会不会遵守 prompt 去写」不在本 PR 的保证范围**(plan §6 已声明非阻塞)。
  `written` 由 QA 在节点存活窗口内代写驱动;`unchanged` / `over_budget` 是真 runner 自己跑出来的。
- 9 步 driver 仍只到 step 5(step 6 是已知缺陷 FLY-2208,与本 PR 无关)。
- `shared` 臂本轮同样未验(没有目录也没有回执,设计如此)。
- 回执可信度 = runner 自报,Bridge 只校验形状不复量。
- 一条与本 PR 无关、值得进 529 backlog 的观察:slot runner 的 `complete` 面包屑落在**生产**
  `~/.flywheel/runner-state/`,因为 runner pane 的 `FLYWHEEL_STATE_DIR` 没被 slot 覆盖。
- 一条非阻塞 advisory(round 1 提出,Lead 已收):`TmuxAdapter.test.ts` 那条名为
  `worst-case encoded memory path stays inside launch budget` 的用例里没有任何长度断言,
  建议后续改成真量一次总长再断言上限。

## R2.F 判决

**PASS on `51a58d0058bb202ffa497289497410a0d404f158`。**
Round 1 的唯一阻塞缺陷已关闭并有真机与单测双重证据;round-1 的通过项抽检无回归。
