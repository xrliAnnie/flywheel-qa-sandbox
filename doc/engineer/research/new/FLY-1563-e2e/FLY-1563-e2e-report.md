# FLY-1563 真机 E2E 报告 — 铃唤醒 Lead + 四步闭环

**Issue**: FLY-1563(v2·可见性:runner 提问必须主动叫醒 Lead,不靠巡逻)
**Date**: 2026-07-31
**Harness**: `e2e-wake-loop.mjs`(本目录;隔离 tmux server `-L fly1563e2e` + 真 TmuxRunnerLauncher + 真 V2Host/coordinator/doorbell + 真 v2 CLI;仅 vendor LLM 二进制为 stub,stub 全程经真 CLI 行动)
**逐字输出**: `e2e-output.log`(同目录)

## 结论

四步闭环 **ALL PASS,唤醒路径零轮询**——runner/lead 进程都阻塞在 pane stdin
上,**没有任何信箱轮询/巡逻**,唯一能移动它们的是引擎门铃贴进 pane 的铃。
(诚实边界:harness 自身轮询日志文件、runner stub 等一个编排 marker 后才发
ask——这是测试编排,不在被测的唤醒路径上;t0 之后的每一步推进都由铃驱动。)

| 步骤 | 时间戳 (UTC) | 间隔 |
|---|---|---|
| lead 清空信箱、完全空闲(NEXT_EMPTY,阻塞 stdin) | 04:53:50.168 | — |
| **t0** runner 发 ask(手里 assignment 故意不结算 = 真实任务中形态) | 04:53:52.187 | — |
| **t1** lead 被铃叫醒(BELL_SEEN) | 04:53:52.586 | **+0.40s** |
| **t2** lead 取到 runner_ask | 04:53:53.374 | +1.2s |
| **t3** lead 回信入队(先回信后销账,leadSettlement 合同) | 04:53:54.118 | +1.9s |
| **t4** runner 被铃叫醒 | 04:53:54.555 | +2.4s |
| **t5** runner 取到回答(穿过自己未结算的 assignment) | 04:53:56.258 | **+4.07s** |
| **t6** runner 结算 assignment(单发结算能力未被中途取信消耗) | 04:53:57.082 | +4.9s |
| **tc** codex 形态会话被同一门铃叫醒并取信完毕 | 04:54:00.088 | — |

(本表 = 最终代码形态的复跑,含 codex review R1 修复——lead 铃路径真跑过
pid_start 双重校验;首轮跑的数字与此一致量级:唤醒 0.46s / 闭环 4.05s。)

对照:FLY-1547 验收当天 Lead 靠 10 分钟巡逻,等了 **34 分钟**;本闭环 **4 秒**。

耐久唤醒记录(不是巡逻的证据):`session_bell_rung` 事件表 —— lead 两响
(`channel:"lead_paste"`,pid 反查 pane),两个 runner 会话各一响
(`channel:"paste_pointer"`)。铃只报「有信」,信体只经收件人自己带凭据的
`next` 取(取信即留读痕)。

## 三种会话的唤醒各验一次

- **Claude runner**(真 launcher spawn 的 tmux pane):铃贴指针 → 醒 → `next --session` 取信 ✅
- **Codex runner**(裸 TUI 形态 = 今日生产形态,`mailbox_mcp` 未配置):同一贴指针路径 → 醒 → 取信 ✅(远控附着形态的官方 codexBell 日常路径在单测 `tmux-runner-launcher.test.ts`「FLY-1563 acceptance: the bell WAKES a remote-attached codex session as a daemon turn」+ FLY-1547 真机 spike 已覆盖)
- **Lead**(真 tmux pane,register-lead 用该 pane 的 pid 注册):门铃按注册 binding 的 pid 反查 pane 贴指针 → 醒 ✅

## 修了什么(前因后果,lead 约束④)

### ③ 铃唤醒 Lead(issue 主体)

`doorbell.ts` 摇铃候选查询原有两处把 Lead 结构性排除:
`substr(m.to_agent,1,6)='v2dag:'`(Lead 收件人是 `flywheel-eng-lead`,直接滤掉)
+ `JOIN activations act`(Lead 是常驻会话,没有 activation,join 不上)。
修法(founder 指示):按收件人分两族 —— runner 会话保持活 activation 门,
Lead 走 agents 注册绑定(session_binding 非空即候选,binding 里的 pid 就是
它 pane 的地址);channel(mailbox MCP lease)优先,tmux 贴指针兜底;
codex daemon 通道是会话级的,对 Lead 不启用。Lead 铃文案单独一版
(lead 用 MCP next 工具或 next --agent + 凭据文件,没有 session ref)。

### 追加缺口:runner 任务中取不到回答(审计发现,lead 拍板本单修,ruling seq 989)

**前因**:runner 的 task_assignment processing attempt 从 spawn 起一直
running 到最终结算提案;engine `pollOnce` 对每个收件人先 resume running
attempt,导致任务进行中的任何 `next` 都 resume 到 assignment →
host 侧撞 "already handed" FenceViolation。**活证据**:本单执行 runner
(生产 v2 会话)收 lead 简报/拍板时 `next` 全部被 fence 挡死,只能 sqlite
只读看信 —— 闭环第 4 步在旧代码下结构性走不通。

**修法**(严格按 lead 四条约束):`beyondInjectedAssignment` 只在 runner
session pull(host `#nextSessionDelivery`)启用 —— 运行中的 dispatch
attempt 不挡后续非-dispatch 信件的领取(candidates SQL 新变体 N1/N2,
同 partial index、EXPLAIN 无 TEMP B-TREE,入 query-plan 锁定测试);
同一封信的 settle-before-repull(§2.1 lost-handoff)与 per-message
`pa_one_running` 一根手指没动;lead/spawn/recovery 路径字节不变。

**实现中撞出并解决的真冲突**:FLY-1503 item 8 要求 crash-settled 的
assignment 能经 session pull 重投(否则 executor 永久卡死)。谓词精化:
dispatch 行仅在「已有 attempt 且无 running attempt」(= 重投场景)时
可经 session pull 取;从未投出的归 spawn 路径,运行中的照常被略过。
item 8 原测试保持绿。

**已知边界**(诚实记录):重投的 assignment envelope 若在 host flush 后、
model 读到前丢失,与「成功收到」在 DB 上不可区分(assignment 是
settle-at-end,re-poll 不构成丢失证据)——旧代码同样无法恢复(loud fence),
新代码下该 dispatch 行归于沉默但 runner 可继续收其它信并 ask 上报;
属既有边界的等价搬移,非新增回归。

## 其余证据

- 单测/集成:v2-kernel 170、v2-engine 74(含新 fly1563-beyond-assignment 3 例)、
  v2-dag 113(含 doorbell lead 4 例)、v2-host 78(含 launcher lead-pane 2 例 +
  pid-reuse 回归 1 例 + lead lease 探测 1 例 + codexBell 唤醒 1 例 + host 级
  mid-task pull 1 例)、v2-cli 43、v2-mailbox-mcp 18,全绿。
- 生产接线说明:`runtime-config.json` 无需新键;Lead 侧 channel 路线仍按
  FLY-1547 ops-notes(per-lead credential 落盘 + lead 重启)启用,未启用时
  Lead 走本单的 pid 反查贴指针兜底 —— 即 merge + 引擎重启后 ③ 立即生效。
