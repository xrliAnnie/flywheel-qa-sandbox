# FLY-1718 re-dispatch 重生对账 — 调研

Issue: FLY-1718 (https://linear.app/geoforge3d/issue/FLY-1718/re-dispatch-丢已拍板成果-fresh-start-无视-origin-同名分支open-pr从-main-另起分叉1704)
日期: 2026-08-12
基于: exploration.md

## 1. 调研问题

exploration 定了四个形态(A fresh 分叉 / B force-push / C 指令孤儿 / D DOA 重生)与方向倾向。本文验证关键机制的**真实可行性**(全部在本机 git 2.39.5 沙箱实测,非文档推断),并核对代码接线点。

## 2. 实测 1:origin 探针 — `ls-remote --exit-code` 天然三态

沙箱(bare origin + clone):

| 场景 | 命令 | 实测结果 |
|------|------|----------|
| 分支存在 | `git ls-remote --exit-code --heads origin feat-x` | exit 0 + `<sha>\trefs/heads/feat-x` |
| 分支不存在 | 同上,branch=no-such-branch | **exit 2**,空输出 |
| remote 不可达 | 同上,remote 指向不存在路径 | **exit 128** + fatal |

映射到 FLY-1257 三态契约零折损:`0+sha → exists` / `2 → missing` / **其他一切 → indeterminate**。ls-remote 是网络真值、不动本地 refs,与 `branch-cleanup.ts:218`(lease-CAS delete 前 fresh ls-remote)同一原语,同仓已有生产先例。

超时:`execFileSync` 带 `timeout`(`probePhaseRetryBranchTip` 用 20s,`run-infra.ts:135`)——超时落 indeterminate。

## 3. 实测 2:per-worktree pre-push hook

git worktree 默认共享主仓 hooks(`--git-path hooks` 解析到 commondir)→ per-worktree hook 必须走 `extensions.worktreeConfig`:

```
git -C <wt> config extensions.worktreeConfig true      # 写共享 repo config,一次性、幂等
git -C <wt> config --worktree core.hooksPath <hooksDir> # 写 worktree 私有 config.worktree
```

沙箱实测(git 2.39.5):

| 用例 | 结果 |
|------|------|
| T1 快进 push(worktree 内) | hook 收到 stdin `<lref> <lsha> <rref> <rsha>`,ancestor 判定通过,push 成功 |
| T2 rewrite 后 `--force-with-lease` | **hook 仍触发且 rsha 是真实 remote tip**;`git merge-base --is-ancestor rsha lsha` 判非快进 → exit 1 → `error: failed to push some refs`,push 被拒 |
| T3 主仓 push | hook 零触发——per-worktree 隔离成立,人类流程不受影响 |

关键确认:
- **`--force-with-lease` 逃不过 pre-push hook**(hook 在引用协商后、传输前跑,rsha 已是 remote 真值)——issue 要求的「--force-with-lease 也需确认语义」机制上可达。
- 分支删除 push(`push origin :branch`)lsha=全零 → ancestor 判定失败 → 同样默认拒(护 open-PR 分支不被远端删除)。
- `extensions.worktreeConfig` 是 repo 级开关,写一次共享 config;对未配 config.worktree 的其他 worktree/主仓是空操作(T3 已证)。git ≥2.20 支持;本机 2.39.5。
- hook 脚本自身无网络、无状态依赖,纯 git 原语;审计行写本地文件即可(`~/.flywheel/state/push-guard/` 之类,append-only)。

逃生口语义:环境变量 `FLYWHEEL_FORCE_PUSH_ACK=<branch>`(hook 内比对当前被拒分支名,精确匹配才放行)。它把「无声覆盖」变成「具名、单分支、留痕的显式动作」;runner 协议层要求先拿 Lead 确认再设。**诚实边界:防事故不防对抗**(runner 技术上可自设 env)——与 founder-only-authority 的信任模型一致,机制护栏 + 合同约束双层。

## 4. 代码接线点核对

### 4.1 fresh 预检的单一 seam

`run-dispatcher.ts:1502` 注释已声明:所有 spawn 路径(fresh Design entry / handoff spawn-fallback / QA-FAIL spawn-fallback / reconcile spawn)**全部路过 `start()`**。resume 计算在 `:1548-1550`,startPoint 组装在 `:1599`(`req.startPoint ?? resume?.startPoint`)。预检插在这一层 = 覆盖全部 fresh 入口,与轴 1 选项 b 一致。

例外面(必须显式豁免,不误伤):
- `req.startPoint` 已由调用方 pin 的派发(QA pin 到 pr_head_sha、phase handoff pin branch B tip)——调用方已带明确存量语义,预检**跳过**;
- `req.qaContext`(Auto-QA)——本就 pin 头、clean-worktree 语义(`:1544-1547` 注释),跳过;
- resume 命中(`resume != null`)——已在续接,跳过。

即:**预检只跑在「resume miss 且无 caller startPoint」的真 fresh 派发上**——正是 FLY-1704 的路径。

### 4.2 resumeComputer 的 origin fallback

`run-infra.ts:1106-1107` 的 `readBranchFile`/`branchTip` 是纯注入函数,签名不动,实现内加一层:本地 `refs/heads/<branch>` miss → 读 `refs/remotes/origin/<branch>`(前置一次 targeted `git fetch origin <branch>`,失败不致命——预检层还有 ls-remote 兜底)。`progress-resume.ts` 核心零改动(纯函数,deps 注入)。

注意 `getResumableSessionForIssueRole` 排除 completed(`StateStore.ts:6197`)**保持不动**——close done=true 的语义争议绕开:延续性预检不看 session 状态,只看 origin 存量,completed 后的重派照样被预检接住。

### 4.3 WorktreeManager 的注入点

- `create()`(`WorktreeManager.ts:199`)已有 fail-closed 先例:FLY-1185 generation marker 写失败 → create 失败(`:257-264`)。pre-push hook 注入同款纪律:写 hook 失败 → create 失败。
- hooksDir 放 worktree 外的固定路径(如 `~/.flywheel/state/push-guard/hooks/`,内容由代码部署时固化)——不进 worktree 文件系统,runner 常规操作(checkout/clean)碰不到;比每 worktree 拷贝一份更不易被误删,且升级 hook 只改一处。
- `-B` reset 语义(`:236`)在预检落地后从「危险放大器」变回「安全清障」:预检保证 startPoint 是 origin tip 时,`-B` 把残留本地分支重置到 origin tip = 恰好是续接想要的。

### 4.4 指令路径快照的两个校验点

- 建成/重投:`event-route.ts:328-344` 持久化 plan_path 处只做形状校验(`isSafePlanPath`);`buildCodexInstruction`(`codex-instruction.ts:36`)是纯文本函数。存在性校验加在**调用侧**(event-route `handleCodexAutoTrigger` + FLY-827 AutoQaCoordinator re-queue):`git show <branch>:<plan_path>` miss → 走现成 MISSING fallback 文案(`codex-instruction.ts:43`),把「有值但孤儿」并进「无值」的既有降级形态,零新文案。
- 过门:`await-codex-gate design`(flywheel-comm 侧)加 reviewedTarget 存在性校验——对称于 FLY-827 code 侧已有的 `reviewedHeadSha === HEAD` fail-closed 校验(`codex-instruction.ts:31-34` 注释)。design 侧验「reviewedTarget 在当前 worktree HEAD 树上存在」,miss → 拒过门 + 提示 re-run `stage set design_review --plan <当前真实路径>`。

### 4.5 DOA 重生的对账面

前任终态数据已在 StateStore(sessions 表:status/failure/started_at/last_activity_at);寿命 = last_activity_at - started_at。退避形状(1m/2m/4m/8m durable + 第 N 次转 needs_lead + 一次性 severe alert)是 FLY-1648 已评审通过的既有 idiom。接线点:重派入口(与延续性预检同层)读同 issue+role 最近 terminal 前任;`寿命 < 阈值` 判 DOA;连续 DOA 代数入 durable 计数(按 issue+role key),健康存活重置计数(FLY-1648 R1 advisory 同款「健康恢复重置退避预算」)。

## 5. open PR 查询(增强层)

`gh api repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open`——网络 + gh auth 双依赖。定位:**best-effort 增强**,不是硬门(origin 分支存在性已是充分硬信号:GitHub 上 head 分支被删时 open PR 会自动关闭,不存在「PR open 而分支已无」的常态)。成功时把 PR 号注入:① 续接派发的 runner prompt(「本分支有 open PR #N,先读它」);② 审计行。失败时静默降级,只留 log。

预算纪律(FLY-1624 教训):每次真 fresh 派发至多 1 次 gh 调用,失败不重试——派发频度低,不会撞 GraphQL/REST 配额问题,但仍不做无谓轮询。

## 6. 备选方案否决记录

| 备选 | 否决理由 |
|------|----------|
| 只靠 prompt 指令「先读已有成果」 | FLY-1704 已实证不可执行——成果不在盘上,环境层不给(exploration §2.3) |
| 预检放 WorktreeManager.create 内 | edge-worker 低层无 issue/PR 上下文;策略进原语层污染分层(轴 1a) |
| 只加宽 resumeComputer,不做独立预检 | 产物型 run 无 progress.md 依旧漏;completed 排除依旧漏;resume 语义被撑爆(轴 1c) |
| `git fetch` 全量后本地 rev-parse 当探针 | 动本地 refs、重;fetch 失败与分支缺失难分——ls-remote 三态干净 |
| force-push 护栏做在 server 端(GitHub 保护规则) | per-branch 动态规则是平台级改造,且我们的多 repo/fork 场景配置漂移;worktree 级 hook 当天可达,server 端留 follow-up |
| hook 写进每个 worktree 的 admin 区 | 升级要遍历所有活 worktree;固定外部 hooksDir 一处升级,worktree 侧只留 config 指针 |
| DOA 做死因自动归因 | 体量另一个单;止血只需「秒死→退避→needs_lead」断路器(exploration §4) |
| indeterminate 探针降级为 warn+fresh | 违背本单哲学硬底——探不清存量就 fresh,等于把 FLY-1704 再演一遍;FLY-1257 已有 fail-dispatch 先例 |

## 7. 风险与开放问题(带进 plan)

1. **ls-remote 每 fresh 派发一次网络调用**:派发频度低(分钟级人肉/引擎节奏),20s 超时 + indeterminate fail-closed;离线开发机场景给 kill-switch env(`FLYWHEEL_CONTINUITY_PREFLIGHT=0` → 回旧行为,byte-compat 逃生口,与 FLYWHEEL_PROGRESS_RESUME=0 同型)。
2. **续接 startPoint = origin tip 时 progress.md 语义**:origin tip 上可能有也可能没有 progress.md——续接派发仍走 resume 渲染吗?设计:预检续接**不伪装成 resume**(不注入 progressResume/stage 抑制),只给 startPoint + shareParentBranch + prompt 里的「存量声明」(分支来源 + PR 号);gate 一个不跳。避免 FLY-795 fail-closed 语义被稀释。
3. **同名分支是废弃产物而非成果**(founder 明确说重做)的场景:续接反而错。设计:重做意图必须显式表达——Lead 用 close --wipe-branch(删 origin 分支)或派发参数 `freshStart:true`(审计留痕)压过预检;默认永远续接。**默认方向选「宁可续接错、不可分叉丢」**——续接错的代价是 runner 在旧基础上重整(可恢复),分叉的代价是覆盖拍板件(不可恢复)。
4. **extensions.worktreeConfig 首次启用**:repo 级一次性写;对既有 worktree 零影响(实测 T3)。老 git(<2.20)不识别——本机 2.39.5,CI ubuntu git ≥2.34,无实际暴露面。
