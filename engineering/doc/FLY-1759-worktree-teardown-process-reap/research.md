# FLY-1759 worktree 拆除进程组回收 — 调研

Issue: FLY-1759 (https://linear.app/geoforge3d/issue/FLY-1759/worktree-拆除只删目录不回收进程组-泄漏累积-5-天撑爆内存8-13-oom-事故根因)
日期: 2026-08-13
基于: exploration.md

## 1. 运行时实证（本机 2026-08-13 实测）

| # | 事实 | 实测结果 | 对设计的意义 |
| -- | -- | -- | -- |
| R1 | `lsof -a -d cwd -F pn -p <pid>` 输出格式 | 三行组：`p<pid>` / `fcwd` / `n<path>`，path 为 symlink 解析后的绝对路径（`/tmp/...` 报成 `/private/tmp/...`） | 解析器按 `p`/`n` 行配对即可；**匹配前两侧都必须 canonicalize**（FLY-793 同款坑，仓里已有 `canonicalizeWorktreePath` 可复用） |
| R2 | 全机 cwd 扫描成本 | 959 个进程、load 较高的生产机上 `lsof -a -d cwd -F pn` 全扫 **0.53 s** | 每次拆除做一趟全扫可接受；sweep 批量拆 N 个 = N 趟,已有 R5#8 budget 节流兜着 |
| R3 | rename 后 cwd 归因 | 目录 `mv wt-a wt-a.removing-999` 后,lsof 对同一进程报告**新路径**（cwd 跟随 inode） | ① 「reap 必须在 rename/删除之前」的干净窗口论证成立;② 扫 `.removing-*` 残留时按残留目录自己的路径匹配即可命中 |
| R4 | `spawn(..., {detached:true})` 的进程组 | 子进程 pgid == 自身 pid（新组长）,脱离父进程组 | 逃逸形态实证:pgid 账本追不上 detached 后代 → cwd 扫描是唯一不依赖登记的地面真相;测试里用 detached spawn 造「逃逸进程」最真实 |
| R5 | `ps -axo pid=,ppid=,pgid=` | macOS 可用,三列纯数字 | 一次快照即可建 父子树 + 进程组 两个闭包 |
| R6 | 删除后归因（未在本机复测,沙箱拒 `rm -rf`） | 事故巡检（8-13 21:5x）实测:删除后 lsof 仍能报旧路径,靠「PPID=1 ∧ cwd 指向不存在目录」抓到 3 个漏网 | 删除后归因**可行但脏**（依赖 lsof 缓存名,非合同行为）→ 只作为事故取证手段,不作为设计依赖;设计只依赖删除前扫描 |

已知 POSIX 语义（不需实测）：`process.kill(-pgid, sig)` 向整组发信号；SIGKILL 不可被捕获，幸存者只可能是 uninterruptible（D 态）/僵尸；`rm -rf` 删活进程的 cwd 目录会成功（unlink 语义）。

## 2. 代码结构事实

### 2.1 注入缝（seam）先例 —— 新 reaper 照抄同款

`WorktreeManager` 已有两个测试缝：
- `constructor(config?, execFn?)` —— `WorktreeExecFn` 注入（`WorktreeManager.ts:172`），默认 `execFile`（array args 无 shell）。
- `config.bgDeleteFn` —— 后台删除注入（`WorktreeManager.ts:175`），默认 detached `/bin/rm -rf`。

→ 新增 `config.reaperFn` 缝完全同构，单测可注入假 reaper，真实进程测试用默认实现。

### 2.2 四个拆除原语的返回类型（决定 reap 结果怎么带出去）

| 原语 | 现返回 | 附加 reap 结果的方式 |
| -- | -- | -- |
| `remove()` | `void` | 改为返回 reap 摘要（调用方现在全部忽略返回值 → 加返回值字节兼容） |
| `removeIfExists()` | `boolean` | 保持 boolean；reap 摘要走 logger（该路径是 pre-create 清理,没有审计 store） |
| `removeCleanWorktreeByPath()` | `{removed, branchDeleted, error?}` | **加可选字段** `reap?: ReapSummary`（additive,现有解构调用方不受影响） |
| `removeWorktreeForce()` | `{removed, error?}` | 同上加 `reap?` |

### 2.3 调用方的审计面（reap 结果的落账点）

- Layer A `worktree-cleanup.ts`：已有 `audit()` → `store.insertEvent`（`worktree_cleanup_done/skipped/failed` 事件族）→ reap 摘要并进 `worktree_cleanup_done` payload。
- Layer B `lifecycle-sweep.ts`：已有 `audit("lifecycle_sweep_worktree_removed", ...)` → 同样并入 payload。
- reconciler / Blueprint / pruneOrphans：无 store,走 `logger.info/warn` 结构化日志。
- **幸存者/扫描失败**属于异常面：原语内部 logger.warn + 结果字段带出,有 store 的调用方落 `worktree_reap_incomplete` 审计事件。

### 2.4 repo lock 语义

四个原语全部已在 `this.locked(mainRepoPath, ...)`（可重入 `withRepoLock`）内执行。reap 作为原语内第一步,自动继承锁语义,不新增锁面。**注意**：reap 含最多 ~7 s 的等待窗（TERM 宽限 + KILL 复验）,会拉长锁持有时间 —— 对照:锁内已有多次 git 子进程调用（秒级）,且拆除本身低频,可接受;宽限窗设计成可注入时钟,单测不真等。

## 3. 平台事实

- **生产 = macOS**（本机）,无 `/proc`,cwd 枚举唯一通用工具是 `lsof`（`/usr/sbin/lsof`,系统自带）。
- **CI = ubuntu-latest**（`.github/workflows/ci.yml` 全部 job）。GitHub ubuntu runner 镜像预装 `lsof`（Linux 上 lsof 读 /proc 实现同样语义）。→ **单一 lsof 代码路径双平台可行**;Linux 上 deleted-cwd 会带 ` (deleted)` 后缀,但设计只在删除前扫描,不受影响。实现时 CI 首跑要真机确认 runner 镜像有 lsof（预期有;若缺,fallback 是 apt 装或读 /proc,留给实现节点,不改设计）。
- lsof 无 root 只能看同 uid 进程 —— Flywheel 全部进程同一用户跑,够用。

## 4. 测试基建事实

- `packages/edge-worker/src/__tests__/WorktreeManager.test.ts`：既有 `remove()` describe 块,模式 = `mkdtempSync` 临时目录 + mock-exec 脚本;部分用真 git repo。
- 真实进程 / 真 tmux 的 host-only 套件先例：`scaffold-prune.real-tmux` 等 `.real-tmux` 命名族（CI 上按环境跳过）。
- vitest 在 edge-worker 内跑（`pnpm test:packages:run` 全仓门）;真实进程测试(spawn `sleep` + `sh -c`)在 ubuntu CI 完全可跑,不依赖 tmux。
- 验收要求的「非预期类型进程」在 CI 用 `sleep`（独立二进制）+ `sh -c 'sleep N'`（shell 包一层孙进程）+ detached spawn（R4 逃逸形态）组合覆盖;真 tmux server 变体做成 host-only 附加 case。

## 5. 安全面事实（kill 是不可逆动作,列全防线）

1. **保护集**：self pid、self 的祖先链（沿 ppid 走到 1）、pid 1、pgid ≤ 1。Bridge 自身 cwd 在 main repo,正常不会命中扫描;保护集是纵深防御。
2. **路径守卫**：reap 前置断言目标路径 = 绝对路径 ∧ canonical 后 ≠ canonical(mainRepoPath) ∧ 不是 mainRepoPath 的祖先 ∧ basename 以 `<repoSlug>-` 开头（复用 `parseWorktreeKeyFromPath` 的既有前缀数学）。守卫不过 → **拒绝 reap**（fail-closed on kill）,只删目录并 logger.warn —— 错杀比漏杀更不可逆。
3. **误杀半径**：cwd 前缀匹配是「属于这棵树」的强判据;进程组扩张只扩到「组长或组员本身 cwd 命中」的组,防止把仅仅同组、cwd 在外的无关进程带进来 → 组扩张规则:目标 pgid 集合 = cwd 命中进程的 pgid;发信号前从组成员中剔除保护集;若某保护 PID 落在目标组内,该组降级为逐 PID 点杀(不发组信号)。
4. **Layer A 前置门不动**：`tmuxClosed === true` 才进 cleanup 的门保留 —— reap 是门后的兜底,不是替代;runner 正常关闭流程语义零变化。

## 6. 结论 → plan 输入

- 单一收口点成立：4 原语 × 1 私有 reap 步骤,全调用方自动覆盖,无调用方改动(除 additive 结果字段消费)。
- 检测 = 一趟 `lsof -a -d cwd -F pn` 全扫 + canonical 前缀过滤;扩张 = 一次 `ps -axo pid=,ppid=,pgid=` 快照建后代闭包 + 组闭包;动作 = TERM → 宽限复验 → KILL → 终验(逐 PID ESRCH)。
- 失败语义：扫描失败/幸存者 → 照常删目录 + 大声审计(§1.R6 说明删除后无法可靠补救,所以审计必须在删除决策点当场落账)。
- 无新 env flag、无新周期任务、无 schema 变更。
