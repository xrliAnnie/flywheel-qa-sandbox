# Exploration: Runner worktree 做完/merge 后不自动清理 — FLY-603

**Issue**: FLY-603 ([bug] runner worktree 做完 / merge 后不自动清理 → 62 个 worktree 堆积)
**Date**: 2026-06-26
**Status**: Draft

---

## 1. 现象 (Symptom)

Annie 截图反馈：大量做完的 task 的 runner worktree 根本没被清理。

实测坐实 (`git -C ~/Dev/flywheel worktree list`)：

| 指标 | 值 |
|------|-----|
| 总 worktree 数 | **64** |
| sibling runner worktree (`~/Dev/flywheel-FLY-XXX` + 少量嵌套) | **58** |
| merged vs WIP | **混杂** —— 38 个 merged+干净、16 个仍 WIP/活跃/脏、2 个含嵌套子 worktree |

→ 清理**必须选择性**：只清 merged + 干净 + 非活跃 runner 的；保留未 merge 的 WIP、正在跑的 runner、有未提交改动的。一刀切会删掉在飞的工作。

## 2. 根因坐实 (Root cause — confirms Cass 诊断)

清理逻辑在 `packages/edge-worker/src/WorktreeManager.ts`，三个方法俱在，**但没有一个挂在「task done / PR merged」事件上**：

### 2.1 `removeIfExists()` — 生产唯一 caller 是 create 路径

`removeIfExists(mainRepoPath, projectName, issueId)` 会 remove worktree + `branch -D`（正是我们要的「清 worktree + 删本地分支」）。但生产唯一 caller 是：

- `Blueprint.ts:407` —— **建新 worktree 之前清同名旧的**（FLY-99 rerun 安全）。

即：它只在「同一个 issue 重新起 runner」时清那个 issue 的旧工作树，**从不在「做完」时清**。

### 2.2 `pruneOrphans()` — 只清「目录已消失」的孤儿

`pruneOrphans()` (`WorktreeManager.ts:304`) 遍历 worktree，但：

```ts
if (fs.existsSync(wt.path)) continue;   // 行 319：目录还在 → 直接跳过
```

→ 它**只**清理 git admin entry 还在、但磁盘目录已被删的「孤儿登记」。对一个做完、目录还原封不动在盘上的 worktree，它视而不见。callers：
- `run-infra.ts:496`（Bridge 启动时每 project 扫一遍）
- `DagDispatcher.ts:62,125`（dispatch 前后）

两处都救不了「目录还在」的 merged 工作树 → **这正是堆积的直接机制**。

### 2.3 真正的 merge 钩子把 worktree remove 有意推迟了

merge/ship 完成的权威收口是 `packages/teamlead/src/bridge/post-ship-finalization.ts::runPostShipFinalization`。它是**已存在的、原子认领、merge 时恰跑一次**的 orchestrator：

- 触发谓词 `isPostApproveShipComplete()` 要求 `landingStatus.status === "merged"`（行 76）→ **天然只在真·merged 时触发**。
- 原子认领（行 151，UNIQUE event_id）→ DES + event-route 多路并发只有一个赢家跑完整管线。
- call sites：`DirectEventSink.ts:546`、`event-route.ts:996` & `:1266`（W2 path）—— **全在 Bridge 侧**。
- 现做三件事：(1) tmux cleanup → (2) ready-to-close 通知 → (3) chat thread teardown。

而 `post-merge.ts` 顶部 FLY-102 责任边界注释**白纸黑字**写明：

```
- NOT here: worktree remove, docs archive, MEMORY update.
  Those stay with Runner / Orchestrator (future: executor lifecycle contract).
```

→ worktree remove 当年被**有意推迟**给一个「未来的 executor lifecycle contract」。**那个 contract 从没建** → 钩子永久悬空。这是 root cause 的设计层来源。

## 3. 与 runner 生命周期的关系 (边界 — FLY-586 / 597 / 369)

issue 要做 #2「确保 runner 活到清理完成」。关键洞察：

> **把 worktree 清理放在 Bridge 侧 orchestrator（post-ship-finalization）后，它根本不依赖 runner 存活。** Bridge 进程做清理，runner 死活无关 —— 这反而是「放 Bridge 侧」的优点，直接化解了「确保 runner 活到清理完成」这条要求。

但堆积恰恰说明很多 session **走不到** happy path：

- **FLY-586**：runner 在 ship 前自我退出（「收工退出」）→ session 可能停在非 merged 终态。
- **FLY-597**：close runner 不原子 → Bridge 标 archived 但进程/cmux 残留。
- **FLY-369**：runner 状态不回传 → `landingStatus` 永远到不了 `merged` → `isPostApproveShipComplete` 永不为真 → finalization 永不触发 → 钩子即便接上也不执行。

→ 单靠 on-merge 钩子，**只覆盖 happy path**；unhappy path 的工作树仍会漏。因此需要**第二层兜底 sweep**。runner-liveness 的根因属 FLY-586/597/369，本 issue **不重做 lifecycle**，只让清理对这些路径**鲁棒**（sweep 用权威信号自洽核验，不信任 runner 自报）。

## 4. 设计方向 — 两层、纯 Bridge 侧、与 runner 存活解耦

### Layer A — on-merge 钩子（防新堆积）

在 `runPostShipFinalization` 内加一个 worktree-cleanup stage（**在 tmux cleanup 之后**，因为 runner 的 cwd 就是该工作树，必须先 kill tmux 再删目录）：

```
worktreeManager.removeIfExists(project.projectRoot, projectName, issueId)
```

- 复用现成方法（issue 要做 #1 明确要求复用 removeIfExists）。
- orchestrator 已要求 `landingStatus=merged` → **选择性的 merged 条件天然满足**。
- fire-and-forget + 自审计错误（与 orchestrator 其余 stage 一致），绝不 throw。
- `project.projectRoot` 即 mainRepoPath，在 Bridge 层每 project 可得。

### Layer B — reconciler sweep（排空积压 + 兜 unhappy path）

boot 时（+ 可选低频周期）扫 sibling worktree，对每个候选做**多信号交叉核验**才删（详见 research 文档 §「权威 merged 判定」）：

| 判据 | 信号源 | 失败即保留 |
|------|--------|-----------|
| 是 runner sibling worktree | path/branch 前缀 + 排除嵌套 | 非本类不碰 |
| 无活跃 session | StateStore `sessions.status` ∉ {running, awaiting_review, approved_to_ship} | 活跃保留 |
| **PR 已 merged** | **权威信号（§5）** | 未证实 merged 保留 |
| 工作树干净 | `git status --porcelain` 空 | 脏保留 |
| 无 OPEN PR | gh PR state | 有开着的 PR 保留 |
| 非嵌套父 | path 不是别的 worktree 的前缀 | 含嵌套子的父级保留 |

全部通过 → 清理。任一不过 → 保留（fail-safe 偏向保留，宁可漏清不可误删）。这层独立覆盖 §3 的所有 unhappy path，且能排空现有积压。

## 5. 关键技术坑 — squash-merge 破坏 naive merged 判定

**已坐实**：`.github/workflows/ship-on-comment.yml:147` → `merge_method: 'squash'`。Flywheel `:cool:` deploy 用 **squash merge**。

→ squash-merged 分支的 HEAD commit **不是** `origin/main` 的祖先（squash 造新 commit）。所以：

```
git merge-base --is-ancestor <branch> origin/main   # squash-merged 分支会误报 "未 merge"
```

**结论**：sweep 的「是否 merged」**绝不能**只靠分支祖先关系。必须叠加权威信号（见 research 文档）：

1. `gh pr` → 该分支某 MERGED PR 的 `headRefOid` == worktree 当前 HEAD（**squash-safe + reuse-safe**：证明工作树 tip 正是被 merge 的那个 commit，未被复用推新）。
2. 或 worktree HEAD 是 `origin/main` 祖先（commit 字面在 main 上，is-ancestor=TRUE 永远可信）。

实战印证：`flywheel-FLY-369` 分支名虽在 merged 集，但**同名分支可有多个 PR**（旧 merged + 新 follow-up）。只有 `headRefOid == 本地 HEAD` 才能区分「已 merge 未动」与「merge 后又推了新工作」。`flywheel-FLY-286` HEAD ≠ 其 merged PR#280 的 head → 正确识别为「真 WIP」并保留。

## 6. 本 session 已做 — 存量选择性清理（Annie 现在要的止血，Lead 拍板执行）

Lead（Tadashi）确认 scope = research/plan 机制（**本 session 不动 Bridge 代码**）+ **立即对现有存量做选择性清理**（删前清单报 Lead 过目）。

清理判定逻辑（=Layer B 的人工先行版，全用权威信号）：四项全过才清 —— 无活跃 session + 工作树干净 + 无 OPEN PR + merged 铁证（ancestor-of-main 或 headRefOid-match）。

结果（58 sibling worktree 全覆盖、账平、无静默遗漏）：
- **可清 38 个**：merged + 干净 + 非活跃。
- **HOLD 2 个**：FLY-496 / FLY-592 含嵌套子 worktree（物理删父会毁子）→ 手动逐个处理。
- **保留 16 个**：WIP(no-merge-evidence) / OPEN PR / dirty / 活跃 session（含本 runner FLY-603）。

`git worktree remove`（**绝不 --force**，自带 dirty 拒删保护）+ `git branch -D`（已验 merged，安全）。

## 7. 开放问题

1. **积压排空谁来做**：已由本 session（research runner）选择性清理 + Lead 过目，非 Cass 手动。Layer B sweep 上线后作为长期自动机制（首跑即排空残余）。
2. **周期 sweep 频率**：boot-only 够不够，还是 N 小时一次 timer？倾向 boot + piggyback 某个已有 poller，避免新增 timer（参照 FLY-208 misroute patrol piggyback 模式）。
3. **跨 project 适用性**：GeoForge3D / JoyCon / sub 等同样有 runner worktree。设计 project-agnostic（按 `project.projectRoot` 逐 project 扫）。
4. **嵌套 worktree**：QA sandbox / pr-checkout 会在 runner worktree 内再建 worktree。sweep 必须识别「父含嵌套子」并跳过父，避免误删子。
5. **branch -D vs -d**：已验 merged 用 -D 安全；Layer B 内若 merged 判定置信度足够可 -D，否则 -d（拒删未 merge）兜底。
