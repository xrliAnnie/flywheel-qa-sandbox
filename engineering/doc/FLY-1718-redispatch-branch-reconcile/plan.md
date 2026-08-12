# FLY-1718 re-dispatch 重生对账 — 实施计划

Issue: FLY-1718 (https://linear.app/geoforge3d/issue/FLY-1718/re-dispatch-丢已拍板成果-fresh-start-无视-origin-同名分支open-pr从-main-另起分叉1704)
日期: 2026-08-12
基于: research.md(修订轮:Codex design review R1 全 7 项 + R2 全 5 项 + R3 全 4 项 + R4 全 2 项采纳;R5 **APPROVED**,2 条非阻断备注已折入)
状态: codex-approved(5 轮,xhigh)

> 实施封装裁定(2026-08-12):设计评审批准后的四个工作包仍按 P1→P2→P3→P4 独立 commit 边界实现,但 Lead 要求以一个 PR 交付。`packaging 由 4-PR 改 1-PR, Lead ship 纪律裁定, 工程内容零变更`。本裁定只改交付封装,不改以下技术设计、顺序或验收合同。

## 0. 一句话

重生(re-dispatch)必须先对账存量:fresh 派发前探并**取回**(materialize)origin 同名分支(有则以已验证的本地 SHA 续接、探不清则拒发),worktree 注入自包含的 pre-push 护栏拒 force-push,路径绑定指令以 blob SHA 快照过门,DOA 重生走前任-identity 绑定的退避断路器——四个工作包各自独立 PR,P1 是数据丢失杀手,单独最先 ship。

## 1. 工作包总览与 ship 顺序

| 包 | 内容 | 治哪个形态 | PR 策略 |
|----|------|-----------|---------|
| P1 | 分支延续性预检(probe+fetch 一体)+ resume origin fallback | A(fresh 分叉) | **单独 PR,最先 ship** |
| P2 | 自包含 pre-push force-push 护栏 | B(覆盖拍板件) | 独立 PR |
| P3 | 指令路径 blob-SHA 快照绑定 | C(孤儿门) | 独立 PR |
| P4 | DOA 重生退避断路器(独立状态机) | D(秒死循环) | 独立 PR,最后 |

不合并打包(R1 #7:合包扩大首个止血 PR 的 blast radius)。

## 2. P1 — 分支延续性预检(branch continuity preflight)

### 2.1 probe + fetch 一体化(R1 #1:ls-remote 的 SHA 必须 materialize)

`ls-remote` 只回 ref/SHA 不下载对象;`WorktreeManager.create` 要跑 `worktree add ... <startPoint>^{commit}`,对象不在本地 odb 必炸。预检做成一个一致动作,全程在**同一 repo mutation lock**(`withRepoLock`,WorktreeManager 已有注入)下:

```
1. git ls-remote --exit-code --heads origin <branch>       → exit 2 = missing(真 fresh)
2. git fetch origin refs/heads/<branch>:refs/remotes/origin/<branch>
   (显式 refspec——普通 `fetch origin <branch>` 只更新 FETCH_HEAD,
    不保证 remote-tracking ref 存在)
3. sha = git rev-parse refs/remotes/origin/<branch>^{commit}
4. git cat-file -e <sha>^{commit}                          → 对象已验证在本地 odb
5. 步骤 1 与 3 的 sha 不一致(窗口内 ref 移动)→ 单次重试;再不一致/删除/超时/
   任一步失败 → indeterminate
```

`ContinuityDecision.startPoint` = **已验证的本地 SHA**(步骤 3/4 产物),不是 ls-remote 的裸 sha。

```ts
export type ContinuityProbe =
  | { kind: "exists"; sha: string }            // 已 materialize + 已验证
  | { kind: "missing" }
  | { kind: "indeterminate"; error: string };
```

新模块 `packages/teamlead/src/bridge/continuity-preflight.ts`:纯决策函数 + 注入探针,与 `computeProgressResume` 同款分层。

### 2.2 不碰 shareParentBranch(R1 #2 BLOCKER)

`shareParentBranch` 是三阶段协议字段(改 worktree key、触发 takeover、切三阶段 prompt/keep-alive,且 TURN 授予按 `req.shareParentBranch` 在 resume 之前判定——事后改 ctx 会造出「有三阶段 prompt 没 TURN」的裂缝)。continuity **只设**:

- `ctx.startPoint` = 已验证本地 SHA;
- `ctx.continuityInherit`(新可选字段,纯解释层)= { branch, sha, prUrl?, prNumber? }。

`req.shareParentBranch` 原样透传,零篡改。

**branch key 与 Blueprint 同源(R2 #1 BLOCKER)**:Blueprint 实际用 `resolveWorktreeKey(node.id, …)` 且 `node.id === req.issueId`(`Blueprint.ts:1267-1270`,`run-dispatcher.ts:1684-1685`);workflow engine 会用 predecessor 的 Linear identifier 覆盖 `issueIdentifier`——两者不保证相等,用 identifier 推 branch 会探错分支、得到 missing、然后 Blueprint 照旧在真同名分支上 `-B origin/main`,恰好重演 FLY-1704。修法:抽**一次** `worktreeIssueId` 计算(输入 = `req.issueId` + role + `req.shareParentBranch`),preflight 与 Blueprint **共用同一产物**(经 `resolveWorktreeKey` + `worktreeManager.expectedWorktree()` 权威链);`issueIdentifier` 只用于显示/Linear alias,**不进 branch key**。集成测试:`issueId=<UUID>, issueIdentifier=FLY-XXXX` 及两者反向/缺失 → 断言 probe branch === `expectedWorktree(...).branch`。

### 2.3 接线顺序、零残留与 async lock(R1 #7 + R2 #4)

`start()` 精确序列(从早到晚,写死为验收契约):

```
inflight check
→ P4 退避 reservation(若已 ship;拒绝时零远端调用)
→ awaited origin-aware resume + continuity 预检
   (两者共用一个 async 的 withRepoLock materializer——targeted fetch 必须进
    同一把 repo mutation lock;ResumeComputer 从同步升为 async seam)
→ lifecycle admission / claim
→ inflight reservation → CommDB pre-register → TURN 授予 → launch guard
→ Blueprint.run
```

- **pre-lifecycle 的 P1 拒绝直接抛 typed error(`CONTINUITY_INDETERMINATE`,可重试),不调用 `abortPreLaunch`**——该 helper 会通知 lifecycle spawn failure,而此刻还没有 claim 可清;claim 之后的失败才走既有对称 cleanup(R2 #4)。
- 零残留验收:indeterminate 拒绝后无 lifecycle claim、无 CommDB 行、无 worktree(逐项断言)。
- 并发测试:materializer 与 WorktreeManager.create 抢同一把 repo lock 不死锁、不交错。

豁免面不变:caller 已 pin `req.startPoint` / `req.qaContext` / resume 命中 → 预检不跑。
kill-switch:`FLYWHEEL_CONTINUITY_PREFLIGHT=0` → 整体旁路(byte-compat 逃生口,默认 ON)。

### 2.4 freshStart 显式重做(R1 #7:不能是普通 boolean)

- 只接受**已认证的人工 runs-route** 入口(founder/Lead 显式动作);内部 start caller(engine、reconcile、retry、handoff)一律不接受该参数;
- 落 durable receipt:actor / reason / branch / 被跳过的 origin tip sha,写审计表(复用 fleet_admin_audit 同型 always-on 纪律);
- origin 分支存在但 freshStart=true → 照常真 fresh,receipt 里记「明知存量仍重做」。

### 2.5 resumeComputer origin fallback(R1 #1 连带)

fallback 前先做**同一把 targeted fetch**(§2.1 步骤 2 的显式 refspec),然后 `branchTip` / `readBranchFile` / `discoverDocDir` **三者共用** `refs/remotes/origin/<branch>`(本地 miss 时)。fetch 失败吞掉(resume 落空 → 预检层还有 fail-closed 兜底)。`progress-resume.ts` 纯函数零改动。

### 2.6 open PR 增强(best-effort)

`gh api repos/{owner}/{repo}/pulls?head={owner}:{branch}&base={default}&state=open`——精确限定 repo + head + base。多结果 → 取最近更新的一个进 `continuityInherit`,全部 PR 号进日志。单次、20s 超时、失败静默降级,**不是硬门**。

### 2.7 Blueprint 渲染

`BlueprintContext.continuityInherit` → runner prompt 固定文案:「你的分支续接自 origin/<branch>@<sha7>(open PR #N)。先 `git log --oneline -10` + 读 PR 描述了解已有成果,在其上继续;禁止 force-push。」prompt 是解释层,结构保证在 startPoint。

### 2.8 TDD

- 真 git 沙箱(bare origin + clone):**「仅远端有分支、本地无对象」**→ 预检后 `cat-file -e` 过、`worktree add <sha>` 成功(R1 #1 点名的缺失用例);ref 窗口移动 → 重试一次 → 仍动 → indeterminate;坏 remote/超时 → indeterminate。
- 决策表单测:exists/missing/indeterminate × freshStart × caller-startPoint × qaContext × resume 命中。
- dispatcher 集成:exists → `ctx.startPoint` = 已验证 SHA 且 `ctx.shareParentBranch === req.shareParentBranch`(逐字段断言,R1 #2);此前非 shared 的 design/implement/qa 重派 → worktree key 不变、不进 takeover、无三阶段 prompt、无 TURN 申请;真实三阶段 caller 原行为不变。
- indeterminate 失败清理:无 lifecycle claim / 无 CommDB 行 / 无 worktree 落盘(逐项)。
- missing → ctx 与 main 现状逐字段相等;kill-switch=0 → 探针零调用(byte-compat 哨兵)。
- resume fallback:本地分支删 + origin 在 → resume 命中且三个读函数全走 remote-tracking ref;origin 也无 → null。

## 3. P2 — 自包含 pre-push force-push 护栏

### 3.1 hook 资产与安装所有权(R1 #5:发布闭包 + 低层调用方)

- hook 源文件作为 **edge-worker 的已发布资产**(`packages/edge-worker/assets/push-guard/pre-push`,入 package.json `files`)——不放 repo-root scripts(不在发布闭包);
- **WorktreeManager 自己拥有安装**:`create()` 时幂等安装到 `join(homedir(), ".flywheel/state/push-guard/hooks/pre-push")`(homedir() 解析的绝对路径)——临时文件 + rename 原子写;校验 regular file、非 symlink、owner、可执行位、内容 hash(不符则重装)。自包含 = **不依赖 Bridge boot**,Voice Bridge 等直接 `new WorktreeManager().create()` 的低层调用方(`voice-bridge/src/cli.ts:530-536`)同样得到护栏且不会因「hooksDir 未部署」失败——统一地板,回归测试保证其 create 照常成功;
- config 两行(`extensions.worktreeConfig` + `--worktree core.hooksPath <绝对路径>`)写在 generation marker 同段;**任一步失败 → 回滚刚建的 worktree/branch(removeIfExists)再抛**(R1 #5:不留半成品),镜像 marker 的 fail-closed 纪律。

### 3.2 hook 语义(research §3 实测形状)

```
每 stdin 行 <lref lsha rref rsha>:
  rsha == 0{40}(新分支)               → 放行(不记账)
  lsha == 0{40}(删除远端分支)         → 拒
  merge-base --is-ancestor rsha lsha 真 → 放行(快进,不记账)
  否则(非快进,含 --force-with-lease) → 默认拒;
      FLYWHEEL_FORCE_PUSH_ACK == 被拒分支名(精确、单分支)→ 放行
```

### 3.3 审计契约(R1 #6:每次非快进尝试都记账)

- **每次非快进尝试**(含删除)append 一条,结果 `rejected` 或 `acked`(ts / branch / lsha / rsha / outcome),写 `~/.flywheel/state/push-guard/audit.log`;
- **ACK 放行路径:审计写失败 → fail closed(拒推)**——「事后必可追认」是 ACK 放行的前置条件;rejected 路径审计失败不改变拒推结果(本来就拒)。

### 3.4 诚实边界(R1 #6:写全绕过面)

`git push --no-verify` 整体跳过 pre-push;改 worktree config 也能解除 hook。护栏是**防事故护栏,不是 authority/security boundary**;runner 合同(Blueprint 注入的 git 纪律段)明文禁止 `--no-verify`、禁止改 push-guard config、force-push 须先 `flywheel-comm ask` Lead 拿确认再按 hook 提示设 ACK(单命令 env,单次单分支)。口头禁令退役为「机制拒 + 合同禁绕过 + 审计追认」三层。
kill-switch:`FLYWHEEL_PUSH_GUARD=0` → create 跳过安装与 config(byte-compat)。

### 3.5 TDD

- 真 git 沙箱 bash harness(`scripts/__tests__/test-push-guard.test.sh`):T1 快进过 / T2 `--force-with-lease` 拒 + `rejected` 审计行 / T3 主仓 push 零 hook 触发 / T4 删除远端分支拒 / T5 ACK=分支名放行 + `acked` 审计行 / T6 ACK=别的分支拒 / T7 新分支首推过(零审计)/ T8 audit 目录不可写 + ACK → 拒(fail-closed)。
- WorktreeManager 单测:安装幂等(hash 相同零写;被篡改重装);config 落盘核验;config 失败 → worktree/branch 已回滚;`FLYWHEEL_PUSH_GUARD=0` → 零安装零 config(byte-compat);**package tarball/production layout 测试**(asset 在发布闭包内,dist 安装态可解析);voice-bridge create 回归。

## 4. P3 — 指令路径 blob-SHA 快照绑定

### 4.1 建成点(R1 #4:不复用 MISSING 占位符)

`codex-instruction.ts:43` 的 `<MISSING ...>` 是会被拼进 `/codex-design-review` 命令与 reviewedTarget 的**占位符**,不是安全降级指令。改法:把 `event-route.ts:411-442` 现有的 missing-plan 安全降级指令(要求 runner 重跑 `stage set design_review --plan`)提取为**共享 builder**;`handleCodexAutoTrigger` 在 build 前验 `git cat-file -e <session.branch>:<planPath>`,孤儿/git 失败 → 调该 builder(与「无值」同路),路径在 → 照旧。
**删除 AutoQaCoordinator 接线**(R1 #4:FLY-827 re-queue 只构建 code review,与 design plan path 无关——原计划的这条接线是误设)。

### 4.2 Bridge-owned review request manifest(R2 #3 + R3 #4:权威在 StateStore,校验在服务端)

runner 自报 `reviewedPlanBlobSha` 挡不住「同 execution 先审 plan A、后改投 plan B,旧 result 在 A 还在时照样过门」。信任锚移到 Bridge 侧,且**权威存储与读取通道都定死**(R3 #4:写 worktree 文件 = runner 可改,不是 trust anchor;当前 `await-codex-gate` 只读本地文件,没有读 Bridge 权威的通道):

- **存储**:StateStore 专用表 `design_review_manifest`,key `(execution_id, revision)` + current pointer + 来源 `event_id`(幂等 CAS:同 source event replay 不递增 revision——event-route 已按 event_id 去重,这里对齐)。字段:`expectedPlanPath, expectedBlobSha`(Bridge 当时算的 `git rev-parse <branch>:<path>`)。同 execution 重新 stage → 新 revision 成为 current;
- **校验通道**:新增 Bridge-side validation seam(loopback HTTP endpoint)。**认证面 = ingest-token 面**(R4 #1 BLOCKER:runner pane 实际只持有 `FLYWHEEL_INGEST_TOKEN`——`TEAMLEAD_API_TOKEN`/master token 刻意不进 pane,挂 `/api/runs` 认证面会让正确请求稳定 401,成功路径永远不可达):endpoint 用现有 `FLYWHEEL_INGEST_TOKEN` 认证,**只回 allow/deny,绝不回传 manifest 内容**(最小权限;共享 ingest token 可接受,因为它不能借此读到任何新数据)。runner 的 `await-codex-gate design` 提交 result projection(requestId/target/blob),**Bridge 服务端**读 manifest + session worktree/binding 完成 requestId/path/blob 三方校验 + dirty check,只有服务端 allow 才 exit 0;token 缺失 / manifest 不可读 / Bridge 不可达 → **fail closed**(非零退出,文案指路)。**绝不把 `TEAMLEAD_API_TOKEN` 注入 runner**。**server 侧 ingest token 未配置 → endpoint 本地守卫直接 503/deny**(R5 备注:legacy `tokenAuthMiddleware(undefined)` 是有意 no-op,新 endpoint 不得继承该无认证行为)。production-shaped 测试:pane 仅有 `FLYWHEEL_BRIDGE_URL` + `FLYWHEEL_EXEC_ID` + `FLYWHEEL_INGEST_TOKEN`(无 master/scoped token)→ 成功;凭证错/缺 → 失败;server token 未配置 → deny;
- **投递一致性**:manifest advance 与指令投递之间的 crash window 用既有 reconcile drain 形态兜:Bridge 启动/周期 reconcile 发现「current revision 尚无对应指令投递 receipt」→ 补投(带 requestId 的新指令);保证 crash 后当前 requestId 最终送达,gate 不会因「manifest 已 advance、指令没到」永久拒绝。

### 4.3 dirty-path guard(R2 #3:tracked plan 的未提交改动)

「HEAD 上 blob 没变」不等于「盘上文件没变」:worktree 把 plan A 改成未提交的 A′ 时,`rev-parse HEAD:A` 仍回旧 blob,而 Codex/implementer 读的是 A′。建成点与过门点都对目标路径跑**限定路径的 clean check**(`git status --porcelain -- <path>` 空 = clean):staged/unstaged 任一 dirty → 拒(gate 文案:「先 commit plan 的当前内容再重跑 review」)。这同时覆盖了「plan 必须先 commit 再 stage set design_review」——未提交新文件 = untracked = dirty,同一条路拒。

部署窗口期:改动前出生的 runner 写老 schema(无 requestId/blobSha)→ gate 拒 + 文案指向重跑 review(一次性成本,可接受;kill-switch 兜回滚)。
kill-switch:`FLYWHEEL_INSTRUCTION_PATH_CHECK=0`(manifest 写入 + gate 校验同门,byte-compat)。

### 4.4 TDD

- event-route 单测:孤儿路径 → 输出 == 共享 builder 产物(逐字);路径在 → 指令与现状逐字节等(除新增 requestId 行);git 失败 → builder 产物;manifest 幂等 CAS(同 source event replay 不递增 revision;重 stage → revision 单调)。
- gate 集成(真 git 沙箱 + loopback Bridge):三方一致 → 过;**同 execution 改投 B 后旧 A-result** → 拒(manifest 已换);同路径换内容(HEAD 前进)→ 拒;路径删除 → 拒;**tracked 文件有 staged/unstaged 改动** → 拒 + commit 提示;**manifest 文件级伪造无效(权威在 StateStore)**;**manifest advance 后、指令投递前 crash → reconcile 补投,gate 最终可过**;Bridge 不可达/token 缺失 → fail closed;字段缺失(老 schema)→ 拒 + 文案;git 不可用 → 拒;kill-switch=0 → 现状行为。

## 5. P4 — DOA 重生退避断路器(独立状态机 PR)

### 5.1 存储:StateStore 新表(R1 #3:本轮定死,不留给 implement)

不复用 `workflow_rework_delivery`(request-specific 外键表);复用的是 FLY-1648 的 **CAS、事务、durable alert-outbox 模式**。

**canonical key = lifecycle root UUID(R2 #5)**:`issue_identifier` 可缺失/可漂移,会分账;repo 已有 `resolveLifecycleRootKey()`(canonical root = immutable Linear UUID,`lifecycle-root-key.ts`)。ledger key 用 `(project, lifecycle_root_uuid, role)`,复用同一 alias closure;runs-route 已持有 `issueUuid`,作为 server-trusted alias 传入。无法唯一解析 root → 按 P4 定位 **fail open + loud warn**(不另建 identifier key,不拦)。

**auto-QA lane 豁免(R3 #3 BLOCKER)**:`resolveLifecycleRootKey` 有意把 auto-QA child UUID 折进 parent root,而 auto-QA(`req.qaContext != null`,独立 QA issue 上 role=qa)与三阶段 QA(parent issue 上 role=qa)是两条不同的 retry/lifecycle lane——按 `(root, role)` 主键会互相累计、互占 lease、误触 needs_lead,且 auto-QA 已有自己的 bounded retry/stuck/Lead-alert 协议(AutoQaCoordinator 独占所有权)。修法:**P4 显式豁免 `req.qaContext != null` 的派发**(与 P1 豁免面同款),三阶段 QA 保留 P4。交叉测试:auto-QA child failed 不动 parent 三阶段 QA 的 row/count/lease,反向亦然。

新表 `doa_backoff`:

```
project TEXT, lifecycle_root_uuid TEXT, role TEXT,
last_counted_predecessor_execution_id TEXT,   -- 同一前任只计一次的 identity 锚
last_settled_successor_execution_id TEXT,     -- R3 #2:唯一能推进下一代的 identity
release_owner_execution_id TEXT,              -- 放行 reservation 的持有者
release_lease_expires_at INTEGER,             -- crash 恢复:lease 过期自动收回
release_state TEXT('none'|'reserved'|'settled'),
count INTEGER, state TEXT('active'|'needs_lead'),
next_eligible_at INTEGER, revision INTEGER,   -- CAS
created_at INTEGER, updated_at INTEGER,
PRIMARY KEY (project, lifecycle_root_uuid, role)
```

### 5.2 事务状态机(R1 #3 + R2 #2:放行是 lease,不是布尔)

R2 #2 BLOCKER:「到期即记 released」会被任何 pre-launch 失败(continuity indeterminate / founder park / CommDB / TURN / create 失败 / 进程崩溃)**永久消费**——暂时网络故障变成永久断路。放行改为 **durable launch reservation**:

单事务内(BEGIN IMMEDIATE + revision CAS):

1. 读同 root+role 最近 terminal 前任;非 failed 或寿命 ≥ 阈值 → **原子清零**(健康恢复重置)→ 放行;
2. DOA 前任且 `execution_id == last_counted_predecessor_execution_id`、deadline 前 → **只拒不加代**,错误带剩余秒;
3. DOA 前任且是**新** execution_id → count+1、记 last_counted、算 next_eligible_at(1m/2m/4m/8m)→ 拒;
4. deadline 已过 → **reserve**:release_state='reserved'、release_owner=本次 executionId、lease(如 10min);同 owner 幂等重驱;其他 execution 在有效 lease 内 → 拒;
5. **结算点 = worktree binding 权威 seam,不是 emitStarted**(R3 #1 BLOCKER:`emitStarted` 在 worktree 创建**之前** fire-and-forget,真正的 commit seam 是 `bindWorktreeOnce` 成功后的 `lifecycleActivate`,即 Bridge-local `emitWorktreeReady` 处)。settle 条件:`bindWorktreeOnce` 已成功(或幂等确认同一 binding)**且 lifecycle activation(`starting→active` CAS)已确认**→ 同一 StateStore 事务内 CAS `reserved(owner=executionId) → settled` + 写 `last_settled_successor_execution_id = executionId`;activation 被拒(founder park)→ 释放给 park 流程。**不从 runner 可发的 HTTP `worktree_ready`/`session_started` 路径结算**(runner 不可伪造 settle)。
   **crash repair = 重驱同一权威事务,不是「有 binding 即 settle」**(R4 #2 BLOCKER:binding 落库与 activation 是两笔可分离的 CAS——binding 与 activation 之间可 crash、activation 可被 park 拒、可 throw 后被 sink 吞;binding-only repair 会把前两者误认成 settled):repair 在 canonical issue mutex 下验证 reservation owner 与 exact binding,**原子地(同一事务)确认/完成 lifecycle `starting→active` 与 DOA `reserved→settled`**;claim 已 `cancelled/closed` → **不 settle**,释放给 park teardown;activation/DB 状态 indeterminate → 该 owner 保持 **fenced**(可续 lease + 告警),且 **admission 在存在 matching durable binding 时不得因 lease 过期另放新 owner**(否则双 launch)。startup 与周期 repair 调**同一个方法**;
6. **已知 pre-launch 失败路径显式释放 reservation**(reserved → none,回到可再 reserve);未知崩溃由 lease 过期自动收回;
7. **涨代判据 = settlement identity**(R3 #2 BLOCKER):计数候选必须满足 `failed.execution_id === last_settled_successor_execution_id`。未 settled 的 terminal row(例:emitStarted 落了 session row、随后 create 失败落 failed)**永不涨代**——系统继续针对原 `last_counted_predecessor` 重新 reserve。reservation owner 被后续尝试覆盖也不能把旧尝试追认成 settled(settle 只发生在 binding seam);
8. count 达 5 → state='needs_lead' + **同事务**写幂等 alert receipt(复用 1648 alert-outbox);needs_lead 态一律拒,直到 audited reset。

并发 start:revision CAS 输者重读——同前任不会被计两次、reservation 单持有。

**Reset 权威(R2 #5:不能只写「走既有认证面」)**:`tokenAuthMiddleware` 在未配 master token 时 no-op,且 action router 有无认证的 loopback `/actions` alias——直接加 action 证明不了「只有 founder/Lead 能清」。修法:reset 走**独立 privileged mount**:master token 缺失 → fail closed(404/403,绝不 no-op);**不生成 `/actions` 无认证 alias**;actor 从认证/consent receipt 推导(绝不信 body);reset 与 actor/reason receipt **同一 StateStore 事务**提交。runner/engine 无权清。

### 5.3 接线与豁免

`start()` 最早段(§2.3 顺序:先于 continuity 网络探针)。账本读失败 → **放行 + loud warn**(可用性断路器非安全边界,R1 认可)。
kill-switch:`FLYWHEEL_DOA_BACKOFF=0`。阈值 `FLYWHEEL_DOA_THRESHOLD_MS`(默认 60_000)。

### 5.4 TDD

寿命边界(59/60/61s);status 过滤(仅 failed;terminated/blocked 不算);同前任 deadline 前重复调用 → 拒且 count 不动;到期 → reserve 恰一次,他人 lease 内拒,同 owner 幂等;**reserve 后 P1 indeterminate / lifecycle parked / TURN 失败 / create 失败 → reservation 显式释放,可再 reserve**;**session row 已存在但 create/config 失败 → 仍是 reserved 且可 release(settle 不在 emitStarted)**;**binding durable + activation 确认后才 settled;binding→activation 间 crash → repair 重驱同一事务;park 赢得 CAS(claim cancelled)→ 不 settle、交 park teardown;activation throw/DB busy → owner fenced、无第二 reservation;active + matching binding 最终恰好 settle 一次;重复 emitWorktreeReady 幂等;matching durable binding 存在时 lease 过期不放新 owner**;**未 settled 尝试(B)落 failed row 后,C 重试 count 不变、仍服务原前任;owner 被覆盖不能追认 B 为 settled**;settled successor 再短命死 → 进下一代;健康 successor → 原子清零;并发 CAS;第 5 代 → needs_lead + 恰一条 alert(幂等);重启读回(durable);UUID/identifier 两种入口共用同一行(root alias closure);root 无法解析 → 放行 + warn;**auto-QA(qaContext)豁免:child failed 不动 parent 三阶段 QA 的 row/count/lease,反向亦然**;**reset:master token 缺失 → fail closed;loopback `/actions` alias 打不到;伪造 actor body 无效;成功 reset 与 receipt 同事务**;账本读失败 → 放行 + warn;kill-switch=0 → 现状。

## 6. 全局纪律

- **byte-compat 默认**:四个 kill-switch 全 `=0` 时与 main 逐字节一致(回归哨兵);默认全 ON(修 bug 非实验特性,逃生口只为回滚)。
- **fail-closed 方向盘**:探不清存量 → 拒发(`CONTINUITY_INDETERMINATE`,可重试,零残留);hook 装不上/config 失败 → create 失败 + 回滚;blob 验不上 → 拒过门;账本读不了 →(P4 例外)放行 + warn。
- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 shell harness;真机 QA(独立 QA 节点)见 §7。
- 文档:CLAUDE.md 里程碑行 + 本文件夹随各 PR 合入。

## 7. 验收标准(QA 节点用)

1. 重放 FLY-1704:origin 有同名分支 + open PR,close done=true 后重派 → 新 worktree HEAD == origin tip(非 main),`git cat-file -e` 在派发机通过,runner prompt 含 PR 号。
2. origin 无同名分支 → 派发行为与 main 现状 byte-compat。
3. 断网/坏 remote → 派发被拒(`CONTINUITY_INDETERMINATE`),lifecycle claim / CommDB / worktree 三无残留。
4. worktree 内 rewrite 后 `git push --force-with-lease` → 拒 + `rejected` 审计行;设 ACK 同分支 → 过 + `acked` 行;audit 不可写 + ACK → 拒;主仓 push 不受影响;voice-bridge 路径 create 正常。
5. 改道后孤儿 plan_path → 新指令为共享 builder 降级形态;`await-codex-gate design` 对「requestId/manifest 不匹配(改投 B 后旧 A-result)」「同路径换内容」「路径已删」「tracked plan 有未提交改动」都非零退出。
6. 前任 failed 且寿命 <60s → 重派被拒带 next_eligible_at;同前任反复重试不涨代;到期 reserve 后 pre-launch 失败 → reservation 释放、不永久断路;第 5 代 → needs_lead + 恰一条 severe alert;privileged reset(master token 必需)后恢复,loopback alias 打不到。

## 8. 诚实边界(本设计不做)

- 不改 close done=true → completed 的终态语义(绕开:预检不看 session 状态;Codex R1 Q2 确认)。
- 不做 GitHub 服务端 push 保护(follow-up 单);`--no-verify` 与改 config 可绕过 hook——防事故护栏,非 security boundary,合同层禁止。
- 不做 DOA 死因自动归因/自动修复。
- 不覆盖非 WorktreeManager 建的工作区(Lead 自己的 clone、人类 worktree)。
- FLY-1712(信箱在途批对账)独立推进,互不阻塞。

## 9. Code review R1 修订(2026-08-12)

首轮 code review 识别出 2 个 HIGH 与 8 条 advisory;实现已全部收口并补回归:

1. 新增 durable `doa_backoff_participants`,只有实际取得 DOA reservation 的 execution 才参与 commit/activate fence;Auto-QA 与 fail-open 豁免不再被同 lane 外来 reservation 误杀。
2. `FLYWHEEL_DOA_BACKOFF=0` 贯穿 verify/activate/close,关闭时既有 ledger 不再卡住 lifecycle activation 或 cleanup。
3. pre-launch abort 只删除 executionId 匹配的 inflight entry,不再误删并发新 launch。
4. design plan 快照不再调用 runner-controlled worktree 的 `git status`;改为校验 session branch tip == HEAD,并用 `ls-tree`/`ls-files --stage`/`hash-object --no-filters` 三方比较,避免 fsmonitor/filter 命令执行与错误 ref 对账。
5. push guard 为每个 worktree 生成组合 hooksPath:原有 hooks 动态链回,原有 pre-push 与 guard 共用同一 stdin 快照,不再覆盖项目 hooks。
6. continuity startPoint 明确排除 design-phase takeover;resume 的 tip/doc discovery/progress blob 固定在同一个 local 或 remote ref 上。
7. `needs_lead` 只允许带 receipt 的 privileged reset 清除;健康 predecessor 不能静默删 hold。
8. push-guard prompt contract 与 `FLYWHEEL_PUSH_GUARD=0` 同门关闭。

修订后 targeted 回归 195 项全绿(edge-worker 89 + teamlead 92 + push-guard shell 14);full workspace lint/build 通过。TeamLead 受控全包 9,171 pass/5 skip,唯一 watchdog 负载 timeout 隔离 19/19 通过;edge-worker 1,253/5 skip;core 非 GUI 219/3 skip;voice-bridge 的并发端口冲突用例隔离 17/17;Claude runner 777/2 skip 后仅 Vitest worker RPC timeout。宿主 Terminal.app 不可用的真实 GUI 两例继续按既有环境例外记录,未冒充通过。

## 10. PR 后 main 同步验收(2026-08-12)

PR #824 创建后 main 合入 FLY-1612,GitHub 检出 `CLAUDE.md` 单文件冲突。为遵守本单新增的 open-PR force-push 护栏,未 rebase/force-push,改用普通 merge commit 保留完整 branch ancestry;冲突只合并两条并列 milestone。自动合并同时穿过 `StateStore.ts` 与 feature-flag registry,因此对新 head 重新验证:

- `pnpm lint` 通过(13 条既有 warning),`pnpm -r build` 22 workspace 通过;
- FLY-1718 影响面:edge-worker 89 + flywheel-comm 17 + TeamLead 205 = 311 tests 全绿,push-guard shell 14/14 + package export harness 通过;
- main 新并入且与本单共享文件的 FLY-1612 影响面:config 31 + TeamLead 210 = 241 tests 全绿;
- merge 解决后 `git diff --check` 通过,下一步对合并后的精确 head 重新发起 code review。
