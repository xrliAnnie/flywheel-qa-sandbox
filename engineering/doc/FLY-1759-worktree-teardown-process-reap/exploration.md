# FLY-1759 worktree 拆除进程组回收 — 探索

Issue: FLY-1759 (https://linear.app/geoforge3d/issue/FLY-1759/worktree-拆除只删目录不回收进程组-泄漏累积-5-天撑爆内存8-13-oom-事故根因)
日期: 2026-08-13
基于: 无

## 1. 问题一句话

拆 worktree 时只操作文件系统（删目录 / `git worktree remove`），**不回收在 worktree 里跑的进程**。进程失去父亲（PPID=1）、失去工作目录，但继续吃内存。机器 24 小时开关 worktree，泄漏持续累积 —— 2026-08-13 攒了 5 天撑爆内存（空闲 71 MB、swap 35.5/36 GB、load 106）。

## 2. 代码审计结论（本分支 f3a27971）

### 2.1 所有生产拆除路径收口在 `WorktreeManager` 四个原语

grep 全仓（排除 tests），`git worktree remove` 与 `.removing-` 改名删除**只存在于** `packages/edge-worker/src/WorktreeManager.ts`：

| 原语 | 机制 | 行号 | 生产调用方 |
| -- | -- | -- | -- |
| `removeUnlocked()` | rename 到 `.removing-<ts>` → `git worktree prune` → 后台 `rm -rf`（`bgDelete`，detached、fire-and-forget） | `WorktreeManager.ts:600-636` | `removeIfExistsUnlocked()`（registered 分支）、`pruneOrphans()` |
| `removeIfExistsUnlocked()` orphan 分支 | 目录在盘但未注册 → awaited `fs.promises.rm` | `WorktreeManager.ts:697` | `Blueprint.ts:1376`（FLY-99 pre-create 残留清理） |
| `removeCleanWorktreeByPathUnlocked()` | `git worktree remove`（无 --force，dirty-safe） | `WorktreeManager.ts:870-905` | `worktree-cleanup.ts:310`（Layer A on-merge）、`removeRegisteredWorktree()` → `lifecycle-sweep.ts:588,734`（Layer B）+ `worktree-reconciler.ts:296` |
| `removeWorktreeForce()` | `git worktree remove --force`（quarantine 后） | `WorktreeManager.ts:971-989` | `lifecycle-sweep.ts:737` |

事故里的两个调用点对应：**A** = `removeUnlocked()`（`.removing-1786654157900` 的 10 个孤儿 vitest worker），**B** = `removeCleanWorktreeByPathUnlocked()`（18 个残留 codex app-server）。

### 2.2 现状零进程回收

四个原语及其全部调用方（Layer A/B、reconciler、Blueprint、pruneOrphans）中 grep `reap|SIGKILL|process.kill` 零命中。唯一的进程侧动作是上游 `postMergeTmuxCleanup` 关 runner 的 tmux pane —— 它只杀 pane 前台进程链，**覆盖不了**已 daemonize / 换 session 的后代（vitest pool worker、codex app-server、嵌套 tmux server、shell-snapshot zsh —— 全部是事故实证）。Layer A 甚至把 `tmuxClosed === true` 当作删除的前置门（`worktree-cleanup.ts:158`），说明设计上假定「pane 关了 = 进程清了」，这个假定被事故推翻。

### 2.3 `.removing-*` 残留无人清

`bgDelete` 是 detached `rm -rf`。Bridge 在 rename 之后、rm 完成之前 crash → `.removing-*` 目录永久残留，且没有任何 sweep 找它（grep `removing` 在 run-infra / Blueprint 零命中）。FLY-1674 的 10 个 vitest worker 绑的就是一个 `.removing-*` 路径。

## 3. 方向盘点

### 3.1 检测「worktree 里的进程」怎么枚举 —— 四个候选

| 候选 | 判定 |
| -- | -- |
| **按进程名枚举**（vitest / codex / node 白名单） | ❌ **issue 明令禁止**。8-13 清理实测漏掉 tmux server、zsh —— 「漏的不是某几类进程，是 worktree 里的任何东西」 |
| **spawn 时登记 pgid，拆除时按账本杀** | ❌ 覆盖不了 runner 里任意命令产生的后代：double-fork / `setsid` / tmux server 会脱离登记的进程组；事故里的 tmux -D 和 codex app-server 正是这种逃逸形态。账本永远追不上未知后代 |
| **cwd 扫描**（`lsof -a -d cwd` 全机一趟，按路径前缀过滤） | ✅ **选定**。枚举无关、覆盖任意进程类型；事故巡检用的就是 cwd 判据且四类泄漏（vitest/codex/tmux/zsh）全部命中；实测本机 959 进程全扫 0.5 s |
| **全 fd 扫描**（`lsof +D` 递归整树） | ❌ 数量级更贵（要 stat 整棵目录树），且事故四类泄漏 cwd 判据已全覆盖；「cwd 在外面但握着 worktree 文件 fd」的形态未在事故中出现 → 记为诚实边界，不做 |

### 3.2 回收动作挂在哪 —— 三个候选

| 候选 | 判定 |
| -- | -- |
| **每个调用方各自加 reap**（Layer A、Layer B、reconciler、Blueprint…） | ❌ N 处必然漂移 —— 8-13 手工清理「按进程类型枚举漏了 3 个」就是同构教训的调用方版：按调用点枚举一样会漏 |
| **`WorktreeManager` 原语层单一收口** | ✅ **选定**。四个原语全在一个类里，一个私有 reap 步骤在文件系统/git 变更**之前**执行，所有现在和未来的调用方自动覆盖 |
| **独立巡逻 daemon**（周期扫 PPID=1 + cwd 指向不存在目录） | ❌ 作为主修法违反 Annie 定案「修结构别加报警器」；且目录删掉后归因变脏（事故里能找到是运气好 lsof 还报旧路径）。可作 follow-up 观测，不属本单 |

### 3.3 回收时机

**先 reap 再动文件系统**（issue 硬要求）。实测佐证：rename 后 lsof 报告的是**新路径**（cwd 跟随 inode），目录删除后归因进一步劣化 —— 在原路径还在时扫描是唯一干净窗口。

### 3.4 杀不掉 / 扫不了怎么办 —— fail-open 删目录 + 大声审计

两个失败面：lsof 超时/不可用（扫描失败）、SIGKILL 后仍有幸存者（uninterruptible 状态）。选择：**照常删目录，但写结构化审计事件**（`worktree_reap_*`）。理由：fail-closed（不删）会把内存泄漏换成流水线卡死 —— pre-create 清理（FLY-99）堵住 = runner 起不来 = issue 停摆，比泄漏更糟；今天的行为是「静默泄漏」，新行为的底线是「要么清掉、要么大声留案」。

### 3.5 不加新 env flag

倾向**无条件生效**，不加 `FLYWHEEL_WORKTREE_REAP=0` 类开关：刚完成 62-flag 收敛战役（FLY-1456/FLY-1413），且 FLY-1466 Annie 有「不加新 flag」铁律先例；一个能被关掉的 reap 等于留了一条静默回到 OOM 路径的门。这是正确性修复，不是实验。（若 design review 认为需要逃生口，再议。）

## 4. 范围边界（诚实声明）

**做**：四个 WorktreeManager 拆除原语的 reap 前置 + `.removing-*` crash 残留的 boot 收敛 + 两个调用点各一个真实进程验收 case（含非 node 类型进程）。

**不做**（各有归属）：
- QA slot 拆房（`scripts/test-teardown.sh` 的 `worktree remove --force`）—— FLY-1482 领域，shell 侧另有 census/finalizer 机制；本单只覆盖 TS 生产原语。
- 常驻 Lead 的内存容量问题（事故时 free=69MB 的真因是 15 个常驻 Lead ≈ 15GB）—— FLY-517 / FLY-779 容量族，与本单泄漏族无关，issue 已明确切开。
- 「cwd 在外、握 worktree 文件 fd」的进程 —— 未在事故中出现，全 fd 扫描成本不成比例。
- 周期性全机孤儿巡逻（检测器）—— 结构修好后如仍需观测，另立单。

## 5. 验收草案（承 issue 硬要求）

1. 真起子进程（**混型**：`sleep` + `sh`/`zsh` 包一层孙进程；host-only 变体加真 tmux server）在临时 git worktree 里 → 走真实拆除路径 → 断言进程组**零存活 PID**（逐 PID `kill(pid,0)` 复验 ESRCH，不是「发了信号」）。
2. 两个调用点各一个 case：`remove()`（`.removing-` 路径）+ `removeCleanWorktreeByPath()`（`git worktree remove` 路径）。
3. 阴性对照：cwd 在 worktree **外**（如 main repo）的进程不被杀。
4. 回归防线 = 上述 case 本身：实现若回退到只删目录，断言 1 直接 FAIL，CI 可跑。
