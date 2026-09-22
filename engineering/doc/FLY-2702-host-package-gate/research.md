# FLY-2702 主机 package gate 排队 — 调研
Issue: FLY-2702 (https://linear.app/geoforge3d/issue/FLY-2702/主机吞吐-本机全量-package-gate-无并发上限今天-6-7-具体同时跑-pnpm-testpackagesrun单次)
日期: 2026-09-17
基于: exploration.md

## 已核对的调用链
| 路径 | 当前行为 / 设计约束 |
|---|---|
| package.json: scripts.test:packages:run | 直接 node scripts/package-gate.mjs；入口保持不改 |
| scripts/package-gate.mjs: runGate / execute | 建 summary，先 pnpm -r build，再按包名顺序跑 test:run；单次 gate 无主机协调 |
| scripts/package-gate.mjs: classifyAttempt / summarizeRun | 仅完整 RPC-only receipt 才重试一次，artifact=2、真实失败=1、通过=0；不改变 |
| scripts/package-gate-reporter.mjs | 结果完整性证明，保留现有 schemaVersion=1 |
| scripts/__tests__/package-gate.test.mjs | 假 pnpm 子进程记录构建/重试次序，另有真实 Vitest reporter 负向；适合扩展跨进程门禁 |
| packages/teamlead/src/lead-backends/codex/ProcessLifetimeFileLock.ts | 已有 /usr/bin/python3 + flock helper；不能直接当槽位复用：stdin EOF 会释放，测试孙进程可能仍存活 |
| packages/teamlead/src/patrol-continuity-collector.ts:180–346 | 核验 session、worktree、activation、attempt、TURN；等待只支持 gate/parked/long_task/phase |
| 同 collector:468–478,739–755 | 远端查询前后重读本地状态 fingerprint；队位/心跳不能进入稳定 identity digest |
| packages/teamlead/src/patrol-continuity.ts:253–279 | 当前 ACTIVE 检查先于 WAITING；新增队列种类需首次就正确显示 WAITING，且不掩盖 sources incomplete |
| packages/teamlead/src/patrol-continuity-cli.ts | sample 和 recheck 必须接同一个 reader，避免已排队者被旧 STALLED 候选 nudge |
| scripts/lead-patrol-snapshot.sh:452–569 | WAITING 不追加 STALLED；其他 dead/quota/menu/capture findings 必须保留 |
| packages/teamlead/lead-rules-base/runbooks/patrol-v1.md:95–115 | STEP 2 最终判定和 nudge 前复核，必须同步可执行消费 |
| packages/teamlead/src/bridge/lead-patrol-snapshot.ts | HOME 可换成 scratch，PATROL_HELPER_SOURCES 有闭包 pin；不能用环境 HOME 定队列 |
| scripts/flywheel-patrol-continuity.mjs | 按 realpath 载入 teamlead/dist，不接受工作树源码通过即生产生效 |
| scripts/package-onboard.sh / package-onboard-files.allow | 新独立 helper 必须进入打包闭包和 smoke 测试 |

## 外部原始资料（2026-09-17 查阅）
- [SQLite 事务](https://www.sqlite.org/lang_transaction.html)：BEGIN IMMEDIATE 先取写事务，可能返回 SQLITE_BUSY。用于读队首、核算槽位、认领同一原子提交；忙时等待，不绕过。
- [Node 子进程](https://nodejs.org/api/child_process.html)：POSIX detached 建立独立进程组；kill 发送信号不证明退出。设计必须另做组存活核验。
- [Python subprocess](https://docs.python.org/3/library/subprocess.html)：start_new_session 与 pass_fds 支持本地监督进程及启动屏障。所有子命令传 argv，不拼 shell。

以上支持协议选择，不证明 macOS 上实现已经可用；macOS 多进程崩溃注入是实现验收硬项。此阶段没有移植 Linux flock 语义作为 macOS 生产证明。

## 主机依赖与恢复结论
Python sqlite3 免 Node build 依赖；账本必须在 OS 用户数据库的真实 home 下，不读 HOME、CODEX_HOME、FLYWHEEL_STATE_DIR。平台固定本轮 macOS，Linux 可共享协议但需独立测试；Windows 不宣称支持。没有 Python / sqlite3 / flock 或必需路径访问权限时本机 enabled gate 返回基础设施错误，不无声直接跑测试。

Round 1验证推翻了ps/boot identity准入方案：当前Codex沙箱拒绝ps、kern.boottime与kern.bootsessionuuid。修订使用每request内核flock生命周期锁证明holder，PGID signal0只有ESRCH才证明空组；跨沙箱EPERM保留容量。watchdog在原沙箱处理lifeline EOF与同组收尾。见sandbox-primitives.json；无需常驻Bridge调度。

## 巡检证据模型
全局账本是协调信号，不是权限授予；同 UID 能修改文件，本轮不是对恶意同用户进程的安全隔离。巡检仍独立验证当前 execution/activation/attempt/TURN、worktree 与进程事实。不能因为 env 自称 exec 或写了 JSON 就取得 WAITING。

队列 reader 用 SQLite 只读事务取得一致快照；可读 ledger.json 仅给人看。正常未启用/尚无账本属于 absent，保留既有巡检；损坏、权限失败、身份无法核验则 UNKNOWN 并列出原因。明确属于旧 activation 的记录忽略，不能无限豁免新体。

## 尚待实证
N=2/3 优劣、≤5 秒切换、全量六体吞吐、无 RPC 假红、异常组自动回收、真实部署 STEP 2。全部列入 plan 的测试矩阵，不能在设计完成时写成已通过。
