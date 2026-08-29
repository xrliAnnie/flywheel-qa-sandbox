# FLY-1185 Runner 分支/worktree 收尾清理根治 — 调研

Issue: FLY-1185 (https://linear.app/geoforge3d/issue/FLY-1185/fix-runner-分支worktree-收尾清理没有自动发生-症状304-远端分支51-worktree-积压fly-603)
日期: 2026-07-11
基于: exploration.md(+ brainstorm gate 折入的两个 scope:MCP server 孤儿收尾、playwright 按需化)

> **SCOPE 重定(2026-07-11,Annie 直令,Tadashi 转达;issue 已重写)**:本单从「分支/worktree 清理」升级为**统一生命周期收尾**——issue 终态 ⇒ 分支+worktree+runner+cmux+thread+Linear 六项(+MCP)全自动归零,一个机制一次修好。本文件的缺口审计与机制地图仍然有效(它们正是六项中 ①② 的底料);统一合同与入口矩阵见 plan.md §0.5。追加盘点:**FLY-799 fanout-finalization**(`fanout-finalization.ts`)= **纯 collector**(自注明 cleanupNode/retry store 留待 integration,生产无 caller)——本单以其为底扩成 `collectIssueCloseoutNodes` 并首次接线;**FLY-1165 done-thread-reconcile** = 已上线的 bounded Linear reconcile 引擎(single-flight/caps/deadline/alias/veto),折入为 D 入口;**`linear-issue-finalizer.ts`** = ⑥Linear Done 自动化,折入;FLY-720/817 = crash/husk 入口,折入;FLY-867 cmux sync = 对账器,保留不动。
>
> **修订记(2026-07-11)**:本文件是 plan 前的调研快照。Codex design review 7 轮(R1×12 + R2×8 + R3×5 + R4×3 + R5×2 + R6×2 → R7 APPROVED)期间,机制细节多处被收紧,以 **plan.md(R7)为准**——主要差异:①"3 天活动闸"升级为持久化连续 eligibility 稳定闸;②quarantine 从 porcelain tar 升级为 recovery-complete 归档(含 staged/binary/ignored + restore-smoke);③所有权只认 StateStore 原子 binding(path+branch+generation),形状 fallback 移除;④本地孤儿分支周期路径零自动删(bundle+manual apply);⑤所有 ref 删除 CAS 化;⑥teardown primitive 收窄为 reap-only;⑦MCP/sweep 搭 HeartbeatService tick 而非 chrome reaper timer。

## 0. Scope 基线(gate 确认后)

统一收尾 = runner/会话到终态时**原子**收掉:worktree + 本地/远端分支 + cmux tab + Linear thread archive + 它 spawn 的 MCP server;另把 playwright-mcp 从自动注册改按需。**无新 feature flag**(Annie 明令)。

## 1. 现有机制地图(全部实读代码/生产验证)

| 机制 | 文件 | 触发 | 管什么 | 不管什么 |
|---|---|---|---|---|
| Layer A on-merge cleanup (FLY-603) | `packages/teamlead/src/bridge/worktree-cleanup.ts` | `runPostShipFinalization`(DES + /events 两路 + merge-ship-gate) | ship 后 worktree + 本地分支(dirty-safe,9 种 skip fail-closed) | 远端分支;非 ship 终态;branch≠expectedBranch 的现场 |
| Layer B boot reconciler (FLY-603) | `packages/teamlead/src/bridge/worktree-reconciler.ts` | Bridge boot(`run-infra.ts:568`) | sibling worktree:dead+clean+merged+无 open PR → 删 worktree+本地分支 | 项目内部 `worktrees/`;branch-key≠path-key;dirty;无 merge 证据;孤儿本地分支;远端分支 |
| pruneOrphans (FLY-95) | `WorktreeManager.pruneOrphans` | boot | 目录已消失的 worktree 注册 | 分支 |
| 预创建收敛 (FLY-99) | `DagDispatcher` pre/post-dispatch | 同 issue 重跑 | 残留 worktree/branch 收敛 | 其他 issue 的现场 |
| crash reaper (FLY-720, merged #403) | `crash-reaper.ts` | HeartbeatService tick | crash runner:FSM→终态 + cmux tab + thread archive | **worktree/分支(明确 non-goal,声明归 FLY-603)**;MCP 子进程 |
| closeRunner 收官 (FLY-369/1165) | `close-runner.ts` → `done-thread-archiver.ts` | 显式 close/terminate | tmux/cmux + thread archive(archive-once sink) | worktree/分支;MCP 子进程 |
| chrome-session-reaper (FLY-766) | `chrome-session-reaper.ts` | boot one-shot + 独立周期 timer(`plugin.ts:~4073`) | Chrome-for-Testing 泄漏(owner-marker 归属) | playwright-mcp 等 stdio MCP server |
| MCP slim profile (FLY-751/812) | `packages/config/src/runner-mcp-profile.ts` → TmuxAdapter `--settings {"enabledPlugins":{…}}` | runner spawn | 每-launch 禁用 plugin(实测 false ⇒ 该 MCP 子进程不 spawn) | Lead 会话;机器级默认 |

**结论:骨架齐全,本单是把缺的对象接进既有骨架,不新造平行系统。**

## 2. 六缺口的技术根因与修法输入

### 2.1 远端分支 — 零机制
- 代码零处删远端;GitHub `delete_branch_on_merge=false`(gh api 实测)。
- 修法:① repo 设置 `delete_branch_on_merge=true`(gh api PATCH,幂等,founder 批准执行,一次性);② post-ship finalization 在 Layer A 之后补 `git push origin --delete <session.branch>`(merge 已验证后执行,天然安全;设置①生效后此步对 PR 自身分支是幂等兜底,对三段式 side 分支/QA 推过的分支仍必要);③ sweep 清存量(§2.6 统一规则)。

### 2.2 QA scratch 族 — 无任何出口
- `auto-qa-coordinator.ts:1077` spawn `sessionRole:"qa"` → `deriveWorktreeKey(ident,"qa")` → sibling worktree + 分支 `flywheel-<key>-qa`;检出在被验 PR head;永不产生自己的 merged PR → Layer B `no_merge_evidence`;常 dirty。
- 修法:**QA 现场 = ephemeral 语义**。(a) 收官路径:QA session 到终态(qa_result 落库 → complete)时 closeout 直接 teardown(dirty 先 quarantine 归档);(b) sweep 规则:key 以 `-qa` 结尾 + session 终态/无 session + dead + 距最后活动 ≥3 天 → 删(不要求 merge 证据)。
- **误伤红线**:只认 `deriveWorktreeKey` 的 role 后缀 `-qa`(sanitize 后精确后缀);QA Room slot worktree(如 `flywheel-qa-slot-N` → key `qa-slot-N`,非 `-qa` 后缀)与 qa-sandbox remote 不落入此规则;shareParentBranch 的 QA(共享 implement 分支)没有独立 `-qa` worktree,天然不触发。

### 2.3 dirty worktree — fail-closed 永久滞留(347 次)
- 修法:**quarantine + 老化**。dead + 无 open PR + (有 merge 证据 或 QA-ephemeral) + 最后活动 ≥3 天 → 把 dirty 内容(`git status --porcelain` 列出的改动+未跟踪文件)打包 `~/.flywheel/archives/worktree-quarantine/<project>-<key>-<date>.tar.gz` → `git worktree remove --force` + 删分支;审计事件带 quarantine 路径。tar 失败 → 保留不删(fail-closed)。
- 「最后活动」定义:max(worktree 目录 mtime 探测的最新文件 mtime 代价高 → 用 `git -C wt log -1 --format=%ct` 的最后 commit 时间 与 `.git` gitdir 文件 mtime 取大者;实现期可简化为 commit 时间 + `git status` 有无未跟踪新文件的 stat 上限采样)。plan 里定死一种,避免歧义。

### 2.4 not_managed_path(237)+ nested_parent(209)
- 两个来源:① 项目内部 `worktrees/` 目录(全局 git-workflow 规则让 agent 在 repo 内建 worktree;有些嵌在 sibling worktree 里 → 同时制造 nested_parent 挡父);② 三段式 base worktree 挂 phase 分支(`flywheel-FLY-1160` 挂 `flywheel-FLY-1160-phase-b`)→ branch-key≠path-key。
- 修法:① sweep 扫描范围扩成两个 root:`siblingParent`(现状)+ `<projectRoot>/worktrees/`、以及**每个已注册 worktree 内部的 `worktrees/`**(git 的 `worktree list` 是全量的,直接按 path 前缀分桶即可);删除顺序按 path 深度降序(先子后父,自然消解 nested_parent);② key 匹配放宽为**同 issue 家族**:branchKey 与 pathKey 相同,或 branchKey 以 `pathKey + "-"` 开头(`FLY-1160-phase-b` ∈ `FLY-1160` 家族)→ 视为 managed;其余安全闸(dead/clean/merged/no-open-PR)不变。
- Layer A 对应放宽:`worktree-cleanup.ts` (3b) `branch_mismatch` 改为:registered branch 解析出的 key 属于该 session 的 issue 家族(且 session.branch 一致时优先直接采用)→ 用 registered branch 删。

### 2.5 本地孤儿分支(430 → 现 74)— 只有"随 worktree 删"一条路
- squash-merge 下 `git branch --merged` 失效(74 条只认 4 条);merge 证据必须走 gh(`pr list --state merged --json headRefName,headRefOid`,Layer B 已有该缓存)。
- 修法:sweep 新增 branch pass:枚举 `git for-each-ref refs/heads/<repoSlug>-*`(+ 家族形)→ 无注册 worktree + 非 protected + 无 open PR + (merged PR 存在(按 headRefOid 匹配 tip,或 tip 是 origin/main 祖先) 或 `-qa` ephemeral ≥3 天) → `git branch -D`;同规则对 `refs/remotes/origin/<repoSlug>-*` 产出远端删除表 → `git push origin --delete`(批量,失败逐条降级)。
- 远端删除的额外闸:分支最后 commit 时间 ≥3 天(`git log -1 --format=%ct origin/<b>`)+ 非 main/默认分支 + 不在 protected 清单。

### 2.6 sweep 触发面 — boot-only → 三触发,零新 timer
- boot(现状保留)+ **post-ship finalization 后 fire-and-forget 项目级 sweep**(每次 merge 后新垃圾概率最高)+ **chrome-session-reaper 既有周期 timer 搭车**(每 N tick 一次,N 定成 ≥6h 等效;不新建 timer,符合 FLY-169/208 先例)。
- gh 失败 → 项目级 no-op(现状 fail-closed 保留);personal-assistant 这类无 GitHub remote 的项目:探测 `git remote get-url origin` 不存在 → 跳过 gh 步但仍可做本地 worktree 清理(修掉现在 87 次全程 no-op 的浪费,但不作为主目标)。

## 3. MCP server 孤儿(gate 折入 scope ①)

### 3.1 生产事实
- 当前 54 个 playwright-mcp 进程(27 对 `npm exec @playwright/mcp@latest` + `node .../playwright-mcp`),**全部挂在活 claude session 下**(lead + runner 逐一核对 ppid),ppid=1 孤儿当前 0(Peter 今天撞后已被人肉清;Tadashi:曾积几十个,最老 12 天)。
- 孤儿产生机制(推断,QA 需复现验证):tmux pane 被 kill(close-runner/post-merge/OOM)→ claude 进程死 → `npm exec` 子进程 reparent 到 launchd(ppid=1)且不随 stdin EOF 退出 → 永生。
- 每会话固定 spawn 一对(即使全程不用)——54 个进程 = 每会话浪费,来源是 plugin 自动注册。

### 3.2 修法
- **源头(scope ②)**:machine 级 `~/.claude/settings.json` `"enabledPlugins": {"playwright@claude-plugins-official": false}`(ops 步骤 + 落进 fleet provisioning 脚本);需要它的会话经既有 per-launch `--settings` 合并通道 opt-in(FLY-615/751 实测 per-launch 优先级高于 user settings)。
  - **与 FLY-812 的 founder 裁决 reconcile**:FLY-812 曾裁"geoforge3d 测试需要 playwright,不进默认禁用名单"。本次是 Annie 新裁决(2026-07-11,Peter 事故后)且改的是 machine 级默认;能力经 opt-in 保留:`resolveRunnerMcpProfile` 已有 QA carve-out(`sessionRole==="qa"` 保 playwright),再加 `playwright` issue label → 显式 enable(true)通道;需在 TmuxAdapter 的 enabledPlugins 合并里支持 true 值(现只有 ponytail 用 true,机制现成)。
- **收尾原子化**:close/teardown 杀 pane 前,取 `tmux display -p -t <win> '#{pane_pid}'` → 枚举其后代进程中匹配 MCP 家族(v1 匹配器:argv 含 `@playwright/mcp` 或 basename `playwright-mcp`)→ SIGTERM→(宽限)→SIGKILL;挂进 `close-runner.ts` 与 `post-merge.ts` 的 tmux 关闭路径 + FLY-720 crash-reaper 的 teardown。
- **孤儿兜底**:chrome-session-reaper tick 搭车一个 `mcp-orphan-reaper`:枚举 ppid==1 + MCP 家族匹配 + etime ≥ 30min(硬编码常量,无新 flag)→ kill + 审计。匹配器做成表(playwright 一项起步,后续加一行即可)。

## 4. 统一收尾(closeout)的挂钩点(实测文件)

| 终态路径 | 现有动作 | 本单补充 |
|---|---|---|
| ship(approve→merge) | `post-merge.ts` tmux close → Layer A worktree+本地分支 → thread archive | + MCP 后代 reap(关 pane 前)+ 远端分支删除 + 三段式家族分支 |
| 显式 close/terminate | `close-runner.ts`(cmux + archive) | + MCP 后代 reap;worktree/分支不动(可能有未 merge 工作,交 sweep 按闸处理) |
| crash(FLY-720) | `crash-reaper.ts`(FSM + cmux + archive) | + MCP 后代 reap(pane_pid 在杀 pane 前取) |
| QA 终态(qa_result→complete) | 走 close 链 | + QA-ephemeral 全量 teardown(worktree+分支,dirty 先 quarantine) |
| 异常/漏网 | 无 | sweep v2 三触发兜底 |

## 5. 安全边界(设计输入,plan 落成硬闸)

1. open-PR 分支/worktree:不动(现状,含远端)。
2. 活 runner(tri-state liveness,unknown=不动):现状保留。
3. 最近 3 天活跃:所有**新增**删除路径(远端分支、孤儿本地分支、dirty quarantine、QA-ephemeral sweep)统一 ≥3 天闸;ship 路径的 session 自身分支除外(merge 已验证,即时删是预期行为)。
4. founder 保留清单:项目 `.flywheel/config.yaml` 新 key `cleanup.protected_branches: []`(config 不是 feature flag;默认空 = 行为不变;支持精确名与 `prefix*` 通配)。protected 同时豁免 worktree 与分支两侧。
5. main/默认分支、非管辖形状(不匹配 `<repoSlug>-` 家族/QA 族)的分支:永不删。
6. QA Room slot / qa-sandbox:形状天然不匹配 `-qa` 后缀规则(见 §2.2);plan 里加显式单测钉死。
7. 所有删除动作:`session_events` 审计(沿用 `bridge.worktree-*` source 族)+ 每一类支持 dry-run 清单输出(实现为函数参数/一次性 CLI 入口,不加 env flag)。
8. 总闸:一切新行为挂既有 `FLYWHEEL_WORKTREE_AUTOCLEAN`(=0 时全部关闭,含新增路径)。**不新增任何 env flag**;新常量(3 天、30min、tick 分频)硬编码 + 注释。

## 6. 已解决的开放问题

- FLY-720 是否覆盖本单?→ 已 merge(#403),覆盖 crash 的 FSM/cmux/thread,**明确不覆盖 worktree/分支/MCP** — 正交,本单在它的 teardown 里加钩子。
- `git branch --merged` 能否判 squash merge?→ 不能(74 条只认 4);必须用 gh merged-PR headRefOid / ancestor-of-main 双证据(Layer B 已有实现,复用其 `ghPrSets` 缓存)。
- per-launch `--settings` 能否压过 user settings 的 enabledPlugins?→ FLY-615/751 注释+实测:per-launch 是最高非 managed 优先级,且 false 实测阻止 MCP 子进程 spawn;true 路径 ponytail 已在用。
- 三段式共享 worktree 会不会被 phase 终态误删?→ closeout 只在 ship/QA-ephemeral 两条路径动 worktree;phase 中间终态(design/implement park)不触发 worktree 动作;sweep 对共享 worktree 依赖 merged+dead 闸,park 中的 phase session 在 protected keys(`listWorktreeProtectionSessions`)里。
