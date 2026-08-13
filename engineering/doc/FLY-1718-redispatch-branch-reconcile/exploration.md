# FLY-1718 re-dispatch 重生对账 — 探索

Issue: FLY-1718 (https://linear.app/geoforge3d/issue/FLY-1718/re-dispatch-丢已拍板成果-fresh-start-无视-origin-同名分支open-pr从-main-另起分叉1704)
日期: 2026-08-12
基于: 无

## 1. 问题陈述

issue 二次 start(前任 close done=true → 僵尸 run 清除 → 重派)后,新 run 在全新 worktree 从 main 建**同名**本地分支,完全无视 origin 上同名分支已有的 round-1 成果(含 open PR + founder 已拍板方案)。FLY-1704 实证:22 分钟 / 70k token 重建已拍板的东西,靠人肉抓到;若 runner 执行 `push -f`,会**直接覆盖 founder 拍板件**——目前唯一防线是口头禁令。

一句话:**重生(re-dispatch)不对账存量**。同一哲学下有四个并发的失败形态:

| # | 形态 | 实证 | 损失面 |
|---|------|------|--------|
| A | fresh start 无视 origin 同名分支/open PR,从 main 另起分叉 | FLY-1704(HEAD=80d175ee vs origin=ddf2d600,PR #813) | 重复劳动 + force-push 覆盖拍板件风险 |
| B | force-push 无机制护栏(仅口头禁令) | FLY-1704(未发生,险) | founder 拍板件被覆盖=不可恢复 |
| C | 自动指令的路径绑定在 run 改道后变孤儿 | FLY-1704 runner 自报:[FLY-137] 指令锁死分叉轮的废弃 plan.md 路径 | 下一个照做的 runner 会为废路径过 design gate |
| D | 失败紧接 DOA 重生(不对账前任死因) | FLY-1686:22:58:00 failed → 22:58:01 后继出生即死,35 分钟窗口 | 重生体秒死循环,浪费派发窗口 |

## 2. 代码审计(成因已核,file:line 级)

### 2.1 resume 谓词过窄(形态 A 的第一层)

FLY-795 的 resume 链(`packages/teamlead/src/bridge/run-infra.ts:1046` → `progress-resume.ts:83`)从头到尾**只看本地**:

1. **前任 session 查询排除 completed**:`StateStore.getResumableSessionForIssueRole`(`StateStore.ts:6189`)`status NOT IN ('completed','shelved')`。这个排除本意正确(merged/parked 不该被静默 resume),但 `close done=true` 会把**未 merge** 的 session 也标成 completed(memory: close_runner_done_true_triggers_respawn)——于是 FLY-1704 的重派根本走不进 resume 谓词,prior=null → fresh。
2. **branchTip 只查本地分支**:`run-infra.ts:1107` `git rev-parse <branch>`;close/terminate 的清理链(`worktree-cleanup.ts` / `lifecycle-sweep.ts`)删掉 worktree + 本地分支后,即使 session 可 resume,tip=null → fresh。
3. **readBranchFile 只读本地 branch blob**:`run-infra.ts:1106` `git show <branch>:<path>`;同上落空。
4. **必须有已提交 progress.md**:`progress-resume.ts:108-117` blob 缺失或不可解析 → fresh。产物型 run(无 progress.md 习惯,FLY-1704 是 product 侧产物 run)**完全无继承**。

四层里任何一层落空都静默 fresh——**没有任何一层查 origin/<branch> 或 open PR**。

### 2.2 fresh 路径盲区(形态 A 的第二层)

resume miss 后,`run-dispatcher.ts:1599` `startPoint: req.startPoint ?? resume?.startPoint` = undefined → `WorktreeManager.create`(`packages/edge-worker/src/WorktreeManager.ts:216-219`)fallback 到 **`origin/main`**,且用 `-B`(reset-or-create,FLY-99)建同名分支:

```
git worktree add <path> -B <branch> origin/main^{commit}
```

两个叠加危险:
- 无「origin 同名分支 / open PR 已存在」预检 → 直接从 main 分叉;
- `-B` 是 **reset** 语义:若本地还残留着带 round-1 成果的同名分支,会被**无声重置**到 origin/main——比 FLY-1704 实际发生的更坏一档的路径同样敞开着。

对照:phase retry 路径已有三态探针(`probePhaseRetryBranchTip`,`run-infra.ts:117`,found/missing/indeterminate,indeterminate → **fail dispatch**,`run-dispatcher.ts:845`)——但它同样只查 `refs/heads/<branch>`(本地),且只覆盖 phase retry,不覆盖 fresh。

### 2.3 runner 层「先读已有成果」指令不可执行

prompt 指令要求 runner 先读已有成果,但成果不在盘上(worktree 全新、从 main 起)。环境层不给,指令层无从执行——修法必须是结构兜(startPoint 层面),不能靠 prompt。

### 2.4 force-push 无机制护栏(形态 B)

`WorktreeManager.create` 只配 `push.autoSetupRemote`(`WorktreeManager.ts:243-255`),无任何 push 护栏。runner 的 git 权限与人类一致;branch protection 只护 main。「不许 force-push」目前是纯口头禁令。

### 2.5 自动指令路径快照孤儿(形态 C)

[FLY-137] 指令链:`stage set design_review --plan <path>` → event-route 持久化 `plan_path` 到 session(`event-route.ts:328-344`,有 isSafePlanPath 校验但**只校验形状不校验存在性**)→ `buildCodexInstruction("design", planPath, execId)`(`codex-instruction.ts:36`)把路径**快照**进指令文本 → runner 照做 → `await-codex-gate design` 放行 implement。

改道(分叉→回到 PR #813 正轨)后,持久化的 plan_path 指向废弃轮的目录——不在当前分支树上。指令建成/重投(FLY-827 codex-hold re-queue)时**不重新校验路径对当前分支的存在性**;`await-codex-gate design` 也不验 reviewedTarget 在当前 HEAD 上存在。孤儿门:下一个照做的 runner 会为废路径跑 review 并过门。

(已有的 MISSING fallback 文案在 `codex-instruction.ts:43`——路径缺失时指令降级为「re-run stage set design_review --plan <path>」——是现成的降级形态,但只在 plan_path 为空时触发,不覆盖「有值但已成孤儿」。)

### 2.6 DOA 重生不对账前任死因(形态 D)

FLY-1686:failed 落账 1 秒后后继出生即死。重派路径读不读前任终态/死因?目前的重派(zombie 清除 → 重派;workflow engine 的 re-materialize)不含「前任活了多久、怎么死的」对账,秒死循环只能靠人看。FLY-1648 已为特定路径(held pane-loss rework 的必败 materialize)加了 1m/2m/4m/8m durable 退避 + 第 5 次转 needs_lead——**退避的机制形状已有先例,但没有覆盖通用重生路径**。

## 3. 设计轴与方向(brainstorm)

### 轴 1:预检放在哪一层?

| 选项 | 优点 | 缺点 |
|------|------|------|
| a. WorktreeManager.create 内部 | 覆盖所有调用方 | edge-worker 层无 StateStore/PR 上下文;create 是低层原语,塞策略污染分层 |
| b. dispatcher 层(resume miss 后、build ctx 前) | 与 resumeComputer 同层,拿得到 issue/role/branch;三态探针先例(FLY-1257)就在这层 | 需确保覆盖所有 fresh 入口(都走 `start()`,单一 seam,run-dispatcher.ts:1502 注释已证) |
| c. 只加宽 resumeComputer | 改动最小 | resume 语义=「带 progress ledger 的续跑」,与「分支延续性」是两件事;把 origin 延续塞进 resume 会把无 ledger 的产物型 run 继续漏掉 |

**倾向 b**:新增独立的「分支延续性预检」(branch continuity preflight),在 `start()` 的 resume 计算旁挂——resume(富层:ledger + stage 抑制)miss 后,预检(结构地板:origin tip 续接)兜底。同时把 resumeComputer 的 branchTip/readBranchFile 加 origin fallback(修 2.1 的第 2/3 层),两层互补不互撞。

### 轴 2:origin 探针用什么原语?

- `git ls-remote --heads origin <branch>`:网络真值,不动本地 refs;branch-cleanup.ts:218 已有同款先例(lease-CAS delete 前 fresh ls-remote)。
- `git fetch` + 本地 rev-parse:动本地 refs,重;且 fetch 失败与「分支不存在」难区分。

**倾向 ls-remote**,继承 FLY-1257 三态契约:exists(带 sha)/ missing / indeterminate。**indeterminate 必须 fail-closed(拒绝派发,结构错误上抛)**——这是本单哲学的硬底:探不清存量就不许 fresh。先例:`run-dispatcher.ts:845` phase retry 的 indeterminate 已经 fail dispatch。

### 轴 3:open PR 查询是硬门还是增强?

GitHub 的 open PR 必然挂在存活的 origin 分支上 → **origin 分支存在性是充分的硬信号**;PR 查询(gh api)是网络+auth 双依赖,作为 best-effort 增强:给续接派发注入 PR 号(runner prompt 可见)+ 给 force-push 护栏提供「此分支有 open PR」标注。PR 查询失败**不阻塞**(origin 探针已兜住硬底)。

### 轴 4:force-push 护栏的注入点与语义

- 注入点:worktree 建成时写 pre-push hook。git worktree 默认共享主仓 hooks 目录 → 必须 `extensions.worktreeConfig` + `git config --worktree core.hooksPath`,做到 per-worktree 不污染主仓与人类流程。
- 语义:hook 读 stdin 的 `<local-sha> <remote-ref> <remote-sha>`,`git merge-base --is-ancestor <remote-sha> <local-sha>` 判非快进;非快进(含 --force-with-lease)与删除(local=0{40})默认拒绝,打印结构化原因 + 落审计文件;显式 per-invocation 确认逃生口(env 带分支名),把「无声覆盖」变成「具名、留痕、需 Lead 确认协议的显式动作」。
- 诚实边界:runner 自己能设 env——这是防事故不防对抗,与 founder-only-authority 合同同级别的信任模型。

### 轴 5:指令路径快照对账做在哪?

双点:
1. **建成/重投时**:buildCodexInstruction 前对当前分支验 `git show <branch>:<plan_path>`;孤儿 → 走现成 MISSING fallback 文案(降级为 re-run stage set)。
2. **过门时(fail-closed 地板)**:`await-codex-gate design` 验 reviewedTarget 在当前 HEAD 存在,不存在 → 拒绝过门并提示重跑 stage set。对照 FLY-827 code 侧已有 reviewedHeadSha === HEAD 的同款过门校验——design 侧补齐对称。

### 轴 6:DOA 重生对账的边界

有界设计:重派入口读前任终态(status/failure/寿命);前任寿命 < 阈值(DOA)→ durable 退避(复用 FLY-1648 的 1m/2m/4m/8m 形状)+ 连续 N 代 DOA → needs_lead + alert。**不做**死因自动诊断/自动修复——那是另一个单子的体量。

## 4. 不做什么(诚实边界)

- 不改 close done=true 的 completed 语义(FLY-1704 的诱因之一,但动它牵扯整个终态机;本单用「completed 也过延续性预检」绕开——预检不看 session 状态,只看 origin 存量)。
- 不做跨 issue 的分支冲突检测(同名撞车属 worktree key 设计,非本单)。
- 不做 force-push 的服务端强制(GitHub branch protection per-branch 动态规则/推送保护是平台级,本单是 worktree 级护栏)。
- 不做 DOA 死因自动归因;只做「秒死→退避→升级 Lead」的止血循环断路器。
- 采样不能当账(Cass 教训):影响窗口的度量以全量枚举为准,本单不新建度量面。

## 5. 与同族单的关系

- **FLY-1712**(runner resume 出生对账——信箱在途批):同一「重生必须先对账存量」哲学;1712 管信箱,本单管工作区/分支/指令快照/前任终态。互不重叠,机制可各自独立 ship。
- **FLY-795**(progress resume):本单不推翻它,是给它补「本地被清后的 origin fallback」+ 在它 miss 后垫「结构地板」。
- **FLY-1257 M3**(phase retry 三态探针):契约形状直接继承。
- **FLY-1648**(durable 退避 + needs_lead):退避形状直接继承。
