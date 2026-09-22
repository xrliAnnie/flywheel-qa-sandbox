# FLY-2702 主机 package gate 排队 — 审查后续清单
Issue: FLY-2702 (https://linear.app/geoforge3d/issue/FLY-2702/主机吞吐-本机全量-package-gate-无并发上限今天-6-7-具体同时跑-pnpm-testpackagesrun单次)
日期: 2026-09-17
基于: plan.md

有效审查已通过：round 2 / request 384bd7ed-b0e5-405c-b22a-574e3969d4f7 / question 0dc1b6ae-8aa5-4534-bb68-1550f7be53e1。以下均为服务端 non-blocking advisories；保留原审查plan字节，不另开设计或派发。Implement在落实对应功能时处理，Lead可另作明确治理处置；尤其巡检排队实际可用仍是原验收，不因列为建议而删除。

## watchdog-placement-vs-caller-group

级别：MEDIUM。只规定了 watchdog 在测试进程组之外，没规定它也要在调用方进程组之外；最常见的崩溃路径可能退化成双重失败

最常见的崩溃是 agent 命令超时或被中断，调用方整组被 SIGKILL，CLI 和 supervisor 一起死。这时只有 watchdog 还活着，才能在 5 秒内收尾。§4.1 第 4 步只写了 watchdog「在测试进程组之外」。如果实现者把它放进 supervisor 所在的组（也就是调用方的组），它会一起死，走进 L56「两者同时死亡 → recovery_hold 直到组自己结束」的分支：孤儿 gate 会一直占位到跑完，最长约一小时，L69 承诺的 ≤5s+≤2s 就不成立。建议写死：watchdog 由 launcher 派生后自己 setpgid，落在独立的进程组里，既不在调用方组也不在测试组。§7 的硬前置里再加一格：running 期间对调用方组 SIGKILL，测试组要在 5 秒内清空，名额要在 2 秒内被另一个沙箱回收。

处置：保留为实施检查项，尚未声称修复或生产验证。

## boundary-timestamp-format-and-legacy-gap

级别：MEDIUM。三个边界时间的格式不一致，legacy runner 在排队期间只会得到 UNKNOWN

(1) granted_at 和 bound_at 写入的是 ISO 字符串（StateStore.ts:37202 等处的 nowIso），而 `sessions.worktree_binding_locked_at` 由 `datetime('now')` 写入（StateStore.ts:25601/25623），格式是 `YYYY-MM-DD HH:MM:SS`：精度到秒，没有 T，也没有时区标记。V8 的 Date.parse 会把这种字符串当本地时间解析，本机 PDT 下会晚 7 小时，导致边界晚于采样时间，结果是 UNKNOWN。「严格解析」如果只接受 ISO 格式，又会一律判为不合法。两种情况下队列豁免都实际失效；方向是 fail-safe，但 STEP2 验收过不了。另外，locked_at 只在首次绑定时写一次（UPDATE 带 `generation IS NULL` 条件），通常被 bound_at/granted_at 支配，加进来只有风险。建议从边界里去掉 locked_at；如果保留，就必须显式按 UTC、秒精度解析，同一秒按边界处理，判 UNKNOWN。(2) 按 L74「无法取得 grant 时间 → UNKNOWN」，没有 workflow 绑定的 legacy/手工派发 runner 排队时每一轮都会是 UNKNOWN，STEP2 显示 UNAVAILABLE、action=REQUIRED，而不是 WAITING。应在计划里明确这是本轮范围外的已知限制，还是要为 legacy 另设边界。

处置：保留为实施检查项，尚未声称修复或生产验证。

## ancestry-anchor-unspecified

级别：MEDIUM。queued-valid 要求做 ancestry 核验，但没指定锚点进程，collector 目前也没有「既有」的进程观察能力

L74 写的是「由可信 collector 对当前 runner 与 supervisor ancestry 做既有 host 进程观察核验」。但 patrol-continuity-collector.ts 和 patrol-continuity-cli.ts 目前只读 DB 和调用 gh，不观察任何进程；lead-patrol-snapshot.sh 也没有用 ps。所以这是新能力，不是「既有」。锚点也没定义。Claude runner 的祖先链可以落到 tmux pane。Codex runner 的命令却是 app-server daemon 在沙箱里执行的，pane 里跑的只是 `codex resume --remote` TUI 客户端，不在祖先链上。StateStore 和 CommDB 里也没有登记 daemon PID（全仓只找到 quota/lead-lease 场景的 panePid）。另外，runbook 让 Lead 自己跑 `--recheck`；如果 Lead 在 Seatbelt 里，ps 同样不可用。这一条不定下来，queued-valid 永远不成立，功能就不会生效（方向是 fail-safe）。建议分 runner 类型写明锚点及其可信来源（例如给 Codex daemon PID 做登记），并规定 recheck 在沙箱内拿不到进程观察时的行为。

处置：保留为实施检查项，尚未声称修复或生产验证。

## reboot-pgid-collision-without-boot-identity

级别：LOW。去掉 bootId 后，重启后 PGID 撞号时只能靠人工修复；可以考虑一个沙箱内可用的启动纪元近似值

重启后 PID 从小号重新分配。重启前登记的 PGID 如果恰好撞上长驻进程，就会被永久 hold，要等 Lead 做记录级修复。计划已把它列为 Follow-up，概率也低。可以考虑一个不走 sysctl 的启动纪元近似值：`time.time() - time.clock_gettime(time.CLOCK_MONOTONIC)`。macOS 上 CLOCK_MONOTONIC 在睡眠期间也会累加，所以这个值跨睡眠稳定，重启后会跳变。它只作为 abandoned 的辅助证据（配合 owner lock 已自由），不用作准入依赖。

处置：保留为实施检查项，尚未声称修复或生产验证。

## suspended-row-recovery-and-retention

级别：LOW。holder 已死的 suspended 行没有回收路径，是否算 live row 也没写

§4.2 的恢复表只覆盖 queued 和 occupied。suspended 的 holder 死亡后应当同样判为 abandoned。另外，§3 的 7 天保留规则说「不得删除 live rows」，suspended 算不算 live 需要写清楚。它不占名额，不影响不变量，但会在 ledger/status 里无限期残留，也会干扰 QA 的泄漏检查。

处置：保留为实施检查项，尚未声称修复或生产验证。

## node-reader-flock-probe-mechanism

级别：LOW。TS reader 要求 owner lock 仍冲突，但 Node 没有 flock API

queued-valid 的条件之一是「owner lock 仍冲突」，而 Node 标准库不提供 flock。reader 只能复用 ProcessLifetimeFileLock.ts 的 /usr/bin/python3 helper 模式，或者引入原生模块。建议写明采用哪种方式，并说明探测必须用 O_RDONLY、不能 O_CREAT、每轮 sample 有界（有超时，失败返回 UNKNOWN），同时注明必须用 BSD flock，不能用 fcntl/lockf：对 POSIX 记录锁来说，关闭同一文件的任意 fd 都会释放持有者自己的锁。

处置：保留为实施检查项，尚未声称修复或生产验证。

## 交接验收提醒

watchdog必须在调用方组与测试组之外独立存活；真实调用方组SIGKILL是普通崩溃验收，不能用多重故障例外豁免。巡检的时间格式、legacy范围与Codex进程锚点需落到可运行测试并取得实际STEP2输出；若未实现，不得开启限流并宣称等待识别有效。保留原六体吞吐、独立基线×1.2、≤5秒接替与无RPC假红标准。

## 2026-09-18 新 run 复审 follow-ups

本节追加 request `483175f7-567a-4a78-ba55-7f6e094c22c4` 的结构化回执，不覆盖上述历史记录。完整内容在 `evidence/resume-review-round-1.json`；准确数量为 **1 HIGH + 6 MEDIUM + 4 LOW**。Lead 答复所称“其余 11 条”按实际 finding 数纠正为以下 10 条；无遗漏、无合并。

唯一 HIGH `supervisor-exit-status-discarded` 已获正式 ruling `29aa397c-baf3-4d52-b631-451a1670662a`：修复义务交本 issue 的 Implement，代码审查/QA 不豁免。完整 finding、独立阴性复现及必须追加的回归测试在 `resume-handoff.md` 与 `evidence/resume-supervisor-reproduction.json`。本 Design 未修代码，不能声称问题已解决。

| Finding key | 级别 | 后续处置与验证边界 |
|---|---|---|
| plan-boundary-locked-at-unparseable | MEDIUM | 核对实际 UTC 边界与 legacy 范围；不可按旧正文盲目加回不能解析的 locked_at。保留真实 deployed STEP 2 验收。 |
| queue-unknown-marks-sources-incomplete | MEDIUM | 区分 unrelated 队列与 genuine unknown 数据源，验证不会以旧行污染健康观测或掩盖缺失来源。 |
| stale-heartbeat-demotion-unbounded | MEDIUM | 验证高负载下重复挂起/重排的公平性；空闲窗口结果不能证明无饥饿。 |
| plan-ancestry-check-not-existing-capability | MEDIUM | 明确 PID/命令行/env probe 与真实 ancestry 的区别，不把前者报告为后者已验证。 |
| ci-bypass-not-announced | MEDIUM | 核对 CI bypass 可见性，并从吞吐验收样本排除不受控调用。 |
| host-disabled-bypass-receipt-unmarked | MEDIUM | 为 host-disable 路径保留机器可读 bypass 原因，不能将其算作限流运行。 |
| plan-statestore-citation-wrong | LOW | 按当前符号定位 StateStore 字段；旧行号已漂移，不能作为格式证据。 |
| plan-control-fd-and-status-source-divergence | LOW | 记录实际 result.json 与刷新后投影机制，区分原计划的 control fd/DB 直读描述。 |
| env-limit-accepts-more-than-plan | LOW | 对齐真实接受的环境变量取值与配置合同，避免文档和测试各自定义。 |
| plan-watchdog-ready-receipt-impossible | LOW | 保留 watchdog-before-GO 与 DB 同事务绑定，不声称 launcher READY 已含后建 watchdog PID。 |

以上是保留的非阻塞 follow-ups，不构成已修复声明，也不缩小原始验收范围。Design 的新有效 verdict 仍须由新 gate/request 返回。

### 新 run round 2：有效 APPROVED

Question `1d7f426d-a002-4e4a-908b-dcbbca428e48` / request `02f41b27-c719-4000-8e12-26ba4f6c5e9f` 返回 `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`。完整回执在 `evidence/resume-review-round-2.json`。原 10 条建议仍未声称修复；本轮新增 1 MEDIUM，共 11 条非阻塞建议。HIGH 的 Implement 修复义务仍由上述 Lead ruling 保留。

新增 **`qa-harness-not-bound-to-host-ledger` (MEDIUM)**：当前验收 evaluator 接收 manifest 自述的 preflight、capacity、运行时间与 exit/RPC 数值，没有核对真实 queue ledger、requestId、capacity 与实际 summary receipt。Implement/QA 须将证据绑定到真实实验期间的账本、运行身份及有效容量，读取实际 receipt 并拒绝缺失、bypass、host_queue 失败与错配样本；验证容量错配、虚构准入、缺失/失败回执均不得通过。手填 manifest 的 evaluator 单测不等于主机六体验收。这是原始验收证据完整性的 follow-up，不放宽 N+1、≤5s、×1.2、无 RPC 假红或 before/after 原始采样要求。
