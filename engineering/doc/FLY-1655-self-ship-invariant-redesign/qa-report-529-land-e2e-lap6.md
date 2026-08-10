# FLY-1655 QA 收口报告(lap6)— 修复验证成立;②三样未拿到,原因非修复

日期 2026-08-09 ~23:3x PDT · QA runner exec `b6fcb30b` · Lead 授权链见各节
被验修复 = `6a8446fc` "preserve authoritative terminal gates"
测试 build = **`9b3cf580`**(= `cac1307d` + cherry-pick `6a8446fc`,**不含 #794**;本地临时分支 `qa-lap6-tmp`,未推远端)

---

## ④ 两条独立发现(优先阅读 — 不属于本单正文,但都要有人接)

### 发现 1 —— 删掉 gate-reissue 后,head 漂移无操作员杠杆,只能整段 rework

**现象**:批准绑死 head `0ecabf8f932c…`;开门后 runner 又 push,PR #85 head 变为 `e3cab621cddaac46…`;land 拒绝放行,`land_operation.state=held`、`last_error=pr_head_mismatch`、`run=held@land`。

**拒绝本身是对的**(FLY-191:批准绑死 exact head,漂移即失效,防"批的是 A 合的是 B")。**问题在拒绝之后没有出口**:
- `workflow-decision-routes` 现有杠杆:`/head-authority`、`/decision`、`/re-qa(+stage)`、`/gate-carrier-rebind(+stage)`、`/loop-reentry(+stage)`
  —— 分别管 重跑 QA / **物化前**换 carrier / 重进循环,**没有一个覆盖「为漂移后的新 head 重开门」**
- `/gate-reissue` **正是本单删掉的那条**
- `runs-route` 唯一 run 级杠杆 `POST /:runId/rework` —— 重跑工作、新 attempt、再烧一个执行节点

⇒ **fail-closed 有了,收敛路径没了。** 安全机制在这条路径上退化成死锁:低成本回到可批状态的路不存在。
Lead 判定这是**本单必须回答的设计问题**(「逻辑只减不加」方向认可,但减掉一条出口而无替代 = 减错地方),已交 implement。

### 发现 2 —— 节点 done 了但 runner 还在写

`execute` 节点 state=done、session `e4f2054a` status=completed / `terminal_at=2026-08-10 06:11:54` **之后**,PR #85 的 head 仍从 `0ecabf8f932c` 漂到 `e3cab621cddaac46`。
即:引擎认定节点完成、会话已终态,但真实 runner 进程仍在提交。这是 head 漂移的上游成因。仅记现象,未深查(Lead 指示不查)。

---

## ⑥ 现场清单(下一棒接手用)

| 项 | 位置 / 状态 |
|---|---|
| **修前对照(冻结,勿动)** | slot4,port 19874,build `cac1307d`。run `96d469bf` = `active@founder_gate`;card `1536234793707118692`;question `workflow-gate:3f871cc270bf…` 被 `superseded_session_terminal` @ `04:48:54.402Z` |
| 修前对照只读快照 | `evidence-529-land-e2e/prefix-control-lap5/`(teamlead / comm / bridge.log / config / projects) |
| **修后现场** | slot3,port 19873,build **`9b3cf580`**。run `66420009` = `held@land`;land_op `land:60fe6909…` held / `pr_head_mismatch`;PR **#85** head `e3cab621…`(已静默);card `1536255760588218429`(thread `1536254784863076412`,channel `ops-lead-test` 1493080995862413439) |
| lap2 证据 | `evidence-529-land-e2e/`(slot2 DB、PR84 三件套、sandbox main 前后) |
| 续跑上下文 | `evidence-529-land-e2e/CONTINUATION.md`(六节 + lap6 实时追加若干段) |
| 临时 build | 本地分支 `qa-lap6-tmp` @ `9b3cf580`,**未推远端**;worktree 已还原 `flywheel-FLY-1655 @ 0eb46970`,`git status` 空 |
| 锁定 head | `/tmp/fly1655e2e/lap6-locked-head.txt` = `e3cab621cddaac46deb530718a2b4a7672686531` |
| 生产 | 零触碰:`complete-failed` 全程 0、真 main 未动、未碰 launchd / `models.json` |
| 未做(Lead 另行安排) | #794 双 build 实测(用 `0eb46970` 在同一槽试起 Lead,判 #794 是否无辜) |

---

## ① 修复验证已成立(本轮最大成果 · 观测非推断)

**同一条路、同一张图、同一触发条件,唯一变量 = 那条修复。**

| | 修前 lap5(build `cac1307d`) | 修后 lap6(build `9b3cf580`) |
|---|---|---|
| carrier session | 正常完成终态 | 正常完成终态 `e4f2054a` @ `06:11:54` |
| gate question 结局 | **`resolved_via=superseded_session_terminal`**,卡片发出后 **约 20 秒**被杀 | **`resolved_at=NULL` / `resolved_via=NULL` / `relay_state=open` / `superseded_at=NULL`** |
| 存活时长 | 18–20 秒即死 | 开门 23:12:23 → 23:14:53 复查仍 open,**直到批准都活着** |
| founder 批准能否绑上 | **不能**(门已不存在) | **能** —— holder → `state=approved`,run 推进到 land |

修前 question `workflow-gate:3f871cc270bf…`;修后 question `workflow-gate:5a39d35a8757…`。

## ② 代点标记(强制)

**此 ✅ 由 QA 经 Chrome-as-Annie 代点,Lead 授权(instruction `1e15c354`),非 founder 本人操作。**
card `1536255760588218429` 回读 `reactions=[('✅',1)]`。
⚠️ reactor id 会显示为 Annie —— **那不能用作「founder 本人」的证据**(今晚已因此误报过一次)。

## ③ head 漂移全过程 + step1/2 实证

1. 门开(23:12:23),head = `0ecabf8f932c`,authority_mode=land
2. QA 代点 ✅ → holder `approved` → run 进入 land
3. land 立即 held:`pr_head_mismatch`;PR #85 实际 head 已是 `e3cab621…`
4. **step1 runner 静默三条一致**:pane 停在 prompt 无 spinner;session `completed` / `terminal_at=06:11:54`;PR head **间隔 60 秒两测逐字一致**
5. **step2 锁定 head** = `e3cab621cddaac46deb530718a2b4a7672686531`
6. **step3 无杠杆**(见发现 1),未自行 rework —— 授权是「一道门 + 一个 head」,不外推

## ⑤ ②三样为何本轮未拿到

`finalization_completed_at` 有值 / land 真终态 / 归档真粘住 —— **全部未拿到**。
**原因不是修复不行**(修复那一格已经是观测,见 ①),而是这条 run 被 head 漂移带进了发现 1 那个**无杠杆死角**:land 停在 `held@land + pr_head_mismatch`,除了整段 rework 没有回到可批状态的路。
Lead 裁定:**先修死角,再拿三样**,顺序不反;本轮不 rework。

## 归因口径(引用时逐字用)

supersede-on-terminal 是**既有 bug,1655 未引入未放大**(blame `37bcb8e2` / 2026-07-26;PR@`cac1307d` 未碰 `terminal-receipt-settlement.ts` 与 `gate-poller.ts`),**但它堵死本单唯一的验收路径,故在本单最小修复**。不得写成 regression。

## 过程中另两个值得进 529 路书的坑

1. **`test-deploy.sh:403` preflight 会用当时 HEAD 重建 dist** ⇒「临时分支 build → 切回主分支部署」会被静默覆盖,你以为在测 A 实际在测 B。正解:**留在临时分支上部署**。
2. **全局 `~/.flywheel/bin/agent-team-transport` 曾指向一个 QA runner worktree**;我清理该 worktree 后它变悬空,导致**任何新起的 Lead** FATAL(三次)。已由 Lead 用 `scripts/converge-flywheel-bin.sh` 修复重指主仓。教训:**破坏性动作前不仅要查「它还有没有用」,还要查「有没有别人引用它」**。
