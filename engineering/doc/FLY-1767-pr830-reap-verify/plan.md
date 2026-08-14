# FLY-1767 独立验证 PR #830 worktree 进程回收 — 验证计划

Issue: FLY-1767 (https://linear.app/geoforge3d/issue/FLY-1767/qafly-1759-独立验证-pr-830-worktree-进程回收最终-head-无-qa-verdict补验)
日期: 2026-08-14
基于: research.md

## 0. 隔离与纪律

| 约束 | 落实 |
| -- | -- |
| 被测分支零 commit | 所有 harness 在 scratchpad;跑前跑后核 `git rev-parse HEAD` + `git status --porcelain` |
| 不在共享 worktree 里 checkout | 全程只读:`git show <sha>:<path>` 取旧版本;`tsx` 直接导入 frozen head 的 TS 源 |
| 生产零触碰 | fixture 全部在 `mktemp -d /tmp/q1767-*` 的独立 git repo 里;不碰 `~/.flywheel`、不碰 9876、不跑 `restart-services.sh` |
| 自己不泄漏 | 每个 suite 装 `process.on("exit")` 兜底 `kill-server` + `kill(-pgid)` + `rm -rf`;收工核 `/tmp/q1767-*` 与残留进程为空 |
| verdict 不进引擎 | 本节点合同:不发 `qa-result`,报告交 flywheel-eng-lead |

## 1. 五组测试

### Suite 1 — 变更前基线 + 四个生产原语 + 作用域

| 用例 | 断言 |
| -- | -- |
| **NEG-BASELINE** | 真 worktree 里种 zsh→sh→sleep 三代 + 独立 sleep + double-fork 孤儿;走**旧**形态(裸 `git worktree remove --force` + `rm -rf`)→ 断言目录没了、进程**全活**、孤儿 ppid=1 且 cwd 指向已删目录(= 8-13 事故签名)|
| A `remove()` | `.removing-*` 路径;`verified` + `survivors=[]` + 独立 `kill(pid,0)` 全 ESRCH + 后代闭包全灭 + 目录删净 |
| B `removeCleanWorktreeByPath()` | `removed=true` + 同上 |
| C `removeWorktreeForce()` | 目标先弄脏(未跟踪文件)+ 同上 |
| D `removeIfExists()` orphan 分支 | 拆掉 `.git` 让 git 不再认它 → 走 Blueprint FLY-99 预清理路径;该 API 返回 `boolean` 不带 reap 记录,**只能靠真 PID 观测**判定 |
| F 作用域 | 目标 `flywheel-FLY-1` vs 兄弟 `flywheel-FLY-2` vs **前缀混淆** `flywheel-FLY-12`(目标是它的严格字符串前缀)vs 主仓 → 只有目标里的死,`matched` 恰为 1 |

每组都带一个 cwd 在主仓的**阴性对照**进程。

### Suite 2 — 闭包 / guard / 自保 / fail-open / 残留

| 用例 | 断言 |
| -- | -- |
| G ppid 闭包 | 父进程 cwd 在 worktree、子进程 `cd /` 后 exec —— 普查只看得见父,子必须靠 ppid 闭包被收掉 |
| H1–H7 guard 拒绝 | 前缀不符 / 非直接子目录 / 相对路径 / 深度不足 / symlink / realpath 漂移 / gone-proof 但目录还在 —— 每条都 `refusedReason` 且**零信号**;末尾接一个**阳性对照**:同一个受害进程在合法 target 下必须被收掉(否则整组是空过绿) |
| I 自我保护 | 把 harness 自己的 cwd 切进目标 → 自身必须活着、不在 `reaped` 里、真受害者照杀、且 summary 诚实地报 `verified:false` |
| J fail-open | J1 普查抛异常 → `scanError` + `verified:false` + **零击杀**;J2 注入抛异常的 reaper 进 `WorktreeManager` → 目录照删、错误留档、进程**没被误杀** |
| K `.removing-*` 残留 | 模拟 Bridge 在 rename 与 rm 之间崩:残留目录里有滞留进程,原路径被新 worktree 重占 → 两个路径各自成为一个 reap target,两边进程都收掉 |

### Suite 3 — 原 FAIL 项逐条闭环

| 用例 | 断言 |
| -- | -- |
| C1 | 用 `git show 1671a3f2:<file>` 确认旧文件确实带 `-D`;**逐字重放**旧 argv → exit≠0 + 打 usage + 5s 轮询后 socket 仍不存在(= 旧断言恒 false);再跑去掉 `-D` 的新写法 → exit=0 + socket 真出现 |
| C2 | 旧源码有 `if (process.env.CI) return false`,新源码没有;新源码在 CI 缺工具时 throw;`skipIf` 由能力探针驱动 |
| C3 | 旧文件断言 client pid,新文件绑 `display-message -p '#{pid}'` 的 server pid、断言 `reaped` 含它、`survivors=[]`、显式守 104 字节、socket 先记录后启动 |
| C4 | CI 从 `lsof` → `lsof tmux`;两个 shell 套件被显式列出 |

### Suite 4 — 爆炸半径与边界

| 用例 | 断言 |
| -- | -- |
| L 跨组成员 | 组长 cwd 在主仓、成员 cwd 在 worktree、二者同 pgid(实测核过)→ 成员死、**组长必须活**(不许 `kill(-pgid)`)。⚠️ 组长不能用 `wait` 写法,否则成员一死它自然退出,会被误读成误杀 |
| M 身份栅栏 | 注入「两次普查之间 pid 被回收成另一个程序」→ `identityMismatchSkipped≥1` + **一个信号都没发** + 不宣称成功 |
| N 有界死线 | 注入一个永不死的目标 + 虚拟时钟 → 必须返回、虚拟耗时 ≤ 25s、`verified:false`、survivors 含它、带 `verifyError` |
| O reap-first 顺序 | 目标弄脏让 `git worktree remove`(无 --force)被拒 → 观察到「进程已死 + 目录还在」的中间态,证明 reap 确实在文件系统动作**之前** |
| P 普查成本 | 本机真实 load 下测 `listSystemCwds()` 耗时,对照 execFile 10s 超时 |

### Suite 5 — 8-13 事故重放

一个 worktree 里同时种四个泄漏家族(3 个 node 常驻 = vitest pool worker 形态、2 个
double-fork ppid=1 守护 = codex app-server 形态、1 个真 tmux server、1 条 zsh→sh→sleep 链)
+ 一个仓库内阴性对照 → **一次** `remove()` → 断言全灭 / 对照活 / 目录没 / 耗时。

## 2. 空过绿检验(突变)

不改仓库任何字节:用 scratchpad 里的 vitest config 把 `./worktree-process-reaper.js` 别名到
一个「什么都不扫、什么都不杀,但报告 `verified:true`」的空实现(= 精确复刻修复前的行为,
只是穿了成功的外衣),再跑 PR 自带的 e2e 与 real-tmux 套件。

**突变 harness 自己也要有阳性对照**:先用同一份 config 跑一个不依赖 reaper 的测试文件,
它必须仍然全绿 —— 否则「变红」只能说明我的 config 把东西搞坏了,证明不了覆盖。
(第一次尝试正是栽在这:正则别名只替换了匹配到的子串,产出 `.//private/tmp/...`,
模块解析失败 → `no tests ran`,这是**假的**突变结果。)

## 3. 硬门清单(全过才可报 PASS)

1. 我的五组独立 harness 全绿
2. 突变检验证明回归防线非空
3. PR 自带套件在 frozen head 真跑:edge-worker 全包 + teamlead 两个 bridge 文件 + 两个 shell 套件
4. `pnpm lint` 0 error;改动包 build 通过
5. **`gh pr checks 830` 全绿**,且 CI run 的 `head_sha` 必须等于 `0aa43410`
6. PR 非 draft、MERGEABLE
7. Codex code review 状态核清楚(含「review 之后 head 漂到哪、漂的是不是生产面」)

## 4. 交付

- `qa-report.md`(本文件夹)= 完整证据
- `founder-report.html` = 交 Tadashi 投递,**我不跑 `publish-report`**
- 结论经 `flywheel-comm ask --report` 交 flywheel-eng-lead,不发 verdict 进引擎
