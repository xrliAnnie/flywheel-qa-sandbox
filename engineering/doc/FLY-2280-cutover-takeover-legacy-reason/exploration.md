# FLY-2280 跨版本 cutover takeover 改写 legacy reason — 探索
Issue: FLY-2280 (https://linear.app/geoforge3d/issue/FLY-2280/引擎部署-restart-services-跨版本-cutover-takeover-自己改写了随后要匹配的-legacy-reason-新)
日期: 2026-09-02
基于: 无

## 问题

2026-09-02 15:25 PT 的第一张 FLY-2264 窗口部署票（`4e77a39 → 63154c2`，reason=updater）
确定性失败。`/tmp/flywheel-updater.log` 的关键行：

| 时间 | 日志 | 含义 |
|------|------|------|
| 15:25:04 | `WARNING: Bridge admission paused without an owner lease id; preserving the cutover brake for post-deploy takeover` | phase-1 对**旧 Bridge**（4e77a39，有 admission pause、无 lease 语义）发了 pause，旧 Bridge 接受但不返回 leaseId |
| 15:25:04 | `Stopping Bridge …` / `Bridge port :9876 confirmed released` | 旧 Bridge 停止 |
| 15:25:53 | `Build successful` | 新版本构建完成 |
| 15:26:17 | `Bridge health check: OK` | 新 Bridge（63154c2）健康 |
| 15:26:17 | `ERROR: new Bridge could not take ownership of the legacy cutover pause` | takeover 请求被新 Bridge 以 409 拒绝 |
| 15:26:17 | `ERROR: legacy cutover admission pause ownership was not transferred; refusing the Lead wave` | 脚本 fail-closed，不启动 Lead 波 |
| 15:26:17 | `ERROR: deploy did not converge — source HEAD 63154c2 vs deployed-sha 4e77a39` | deployed-sha 不推进，票作废 |

### 机制（三段代码各自都“对”，拼在一起必错）

1. **phase-1**（`scripts/restart-services.sh` `pause_admission_best_effort`，Step 0，Bridge 停止前）：
   无论是否处于 cutover 事务，pause 的 `reason` 都写成
   `restart-services:${RESTART_REASON}:pid=$$:started=<UTC>`。cutover 事务下（`cutover_legacy_pause_pending`
   为真）只把两个 flag 置为“稍后接管、不自行 resume”，reason 照旧。
2. **旧 Bridge**（30bd50ec7 之前的 `StateStore.setAdmissionPause`）：
   `INSERT … ON CONFLICT(id) DO UPDATE SET paused_until=…, reason=excluded.reason …`，
   **无条件覆盖** `admission_pause.reason`；响应只有 `active/remainingSeconds`，没有 `leaseId`。
   于是 DB 里 host 工具写的 `FLY-2264 arm64 tmux destructive window`（receipt `.pause.reason`）
   被改成 `restart-services:updater:pid=…`。
3. **takeover**（`takeover_cutover_admission_pause_after_bridge_health`，新 Bridge 健康后、Lead 波前）：
   cutover 分支从 receipt 读 `.pause.reason` 作 `expectedLegacyReason`；新 Bridge 执行
   `UPDATE admission_pause SET lease_id=? … WHERE id=1 AND lease_id IS NULL AND reason=?`
   → 0 行 → `AdmissionPauseLeaseConflictError` → 409 → 脚本 `return 1` → 拒绝 Lead 波。

一句话：**phase-1 和 takeover 对同一行用了两套词汇**。普通部署路径两边都取自同一个变量
（run-local receipt 里的 `pauseIdentifier`），所以自洽；cutover 路径 phase-1 写自己的标识、takeover
却去匹配 host 工具的 reason，两边从不曾相等。

### 为什么既有测试没抓到

`scripts/__tests__/restart-services-admission-pause.test.sh` 的 cutover 用例
`legacy_pause_takeover_then_resume` 让 phase-1 的 curl **失败**（`CURL_RC=22`，模拟旧 Bridge 已 bootout
或 404），从未模拟“旧 Bridge 接受 pause 并覆盖 reason、不返 leaseId”这一真实跨版本形态。fake curl 是无状态的
（固定回包），无法表达“reason 被谁改成了什么”。而 FLY-2264 runbook §6 步骤 1 恰好写着“旧 Bridge 已 bootout
时，第一次 pause API 不可达仍保持此状态”——测试锁的是这句，生产走的是另一条：`services-bootstrap`
把旧 Bridge 又拉了起来，phase-1 的 pause 是**可达且成功**的。

### 之后发生了什么（updater 日志可证的部分）

第二张票 15:59:50 起跑：phase-1 收到 `admission pause unavailable (… foreign owner …)`（409），
按**普通部署**继续（receipt 此时已不是 legacy 形态，`cutover_legacy_pause_pending` 为假，不再尝试 takeover），
16:04:07 `deployed-sha updated to 63154c2`，16:04:40 `no owner lease id; preserving the admission brake`。
receipt 显示 16:05 由新工具做了 §7 续期（`reacquiredAfterLapse:false`）、18:19 resume。
15:26 与 15:59 之间 lease 与 handoff 如何被取得，updater 日志没有记录——推断为人工介入，本文不假装知道细节。

## 修法候选

| 方案 | 做法 | 结果 |
|------|------|------|
| **A. 同一 reason（推荐）** | cutover 事务下 phase-1 的 pause `reason` 直接取 receipt `.pause.reason`；takeover 逻辑不变 | 旧 Bridge 覆盖 reason 变成**幂等**（写回同一串）；lease-aware Bridge 应答 phase-1 时走既有 adopt+handoff 分支；404/超时都不改变匹配结果 |
| B. 跳过 phase-1 pause | cutover 事务下不发 pause，只置 flag | reason 不被碰；但失去 TTL 刷新（构建+15 分钟健康窗可能吃光 receipt 剩余预算）；重试票撞上 lease-aware Bridge 上的 stale reason 时无法自愈 |
| C. takeover 容忍自写标识 | phase-1 记下自己写的标识；takeover 先试 receipt reason，409 再试自写标识 | 需要知道“phase-1 的写入到底落没落”：curl 超时但服务端已提交时两种状态同一痕迹（[[feedback_two_states_one_trace]]），双候选仍可能双 409；机制在长 |
| D. Bridge 放宽匹配 | `reason LIKE 'restart-services:%'` 也算 legacy 匹配 | 破坏“identifier 不匹配即 409、绝不接管外部 brake”的合同；且改在服务端，修不了旧 Bridge 一侧 |

选 **A**：它把“需要知道写入是否落地”这个问题整个消掉——不管旧 Bridge 是覆盖了、没收到、还是超时后才提交，
DB 里的 reason 都等于 receipt 的 reason。修改只在 `restart-services.sh` 一处，Bridge、host 工具、receipt
schema、handoff 合同全部不动。

A 附带一条**负向守卫**：phase-1 在读 receipt reason 时用与 takeover 相同的谓词校验
（string、非空、≤200、首尾无空白、无 CR/LF）；校验失败在**任何 curl 与 Bridge 停止之前**以 rc=1 退出并点名原因。
今天这类错误只会在新 Bridge 起来后才暴露（旧 Bridge 已停、Lead 全被拒），提前到 Step 0 前是纯收益。
两处共用一个 helper，删掉 takeover 内联的 jq 谓词——净行数接近零。

## 锁定边界

- 只改 `scripts/restart-services.sh` 的 `pause_admission_best_effort` / `takeover_cutover_admission_pause_after_bridge_health`
  与它们的测试；不改 `packages/teamlead`（`expectedLegacyReason` 精确匹配、409 不泄漏 id 的合同保持）。
- 不改 `scripts/host-terminal-cutover.sh` 与 receipt/handoff schema；runbook 只补两句事实
  （phase-1 会以 receipt reason 续 TTL；reason 必须 ≤200、首尾无空白）。
- 普通部署路径（无 legacy receipt）的 identifier、run-local receipt、takeover、resume 行为**一字不动**，
  既有 34 条 admission-pause 用例必须原样通过。
- 不做 `max(remaining, 1800)` 之类的 TTL 保守化：takeover 本来就把 TTL 改写为 1800s，这是 FLY-2264 已接受的语义。
- rollback 路径在 cutover 事务下的 pause（对 lease-aware 新 Bridge 可能 adopt 并写 handoff，随后旧 Bridge 回来）
  属于 FLY-2264 runbook §8 的既有语义，本单不动。
- 补的是**跨版本引导段测试**：旧 Bridge（接受 pause、覆盖 reason、不返 leaseId）+ 新脚本 + legacy receipt；
  必须先在修复前的脚本上 RED。

## 已知风险

1. 旧 Bridge 没有所有权语义，phase-1 的写入本质就是覆盖；同 reason 只让覆盖幂等，**不能**检测第三方在窗口内
   另发过 pause。这由 runbook 的窗口纪律（唯一一张票、窗口内不得用新工具 pause）保证，本单不新造检测。
2. phase-1 把 TTL 改写为 `ADMISSION_PAUSE_SECONDS`（1800s）。若 legacy 剩余 >1800s 会被缩短；1800s 仍大于
   rollback 900s + Bridge boot 180s 的窗口预算，且 takeover 之后 host §7 会立刻续期。receipt 里的 expiry 在续期前
   会偏乐观——现状 takeover 已经如此，本单不新增也不消除。
3. reason 若含首尾空白或超过 200 字符，Bridge 存的是 `trim().slice(0,200)` 后的串，receipt 存原文，永远 409。
   新增的 phase-1 校验把这一失败提前到 Bridge 停止之前；jq 的 `length` 按码点计、JS 的 `slice` 按 UTF-16
   单元计，含非 BMP 字符（emoji）的接近 200 字符的 reason 仍可能两边不一致——runbook 示例全是 ASCII，
   作为文档约束记录，不为它建机制。
4. 每次 pause 都把 `alert_state` 置回 pending，5 分钟后 founder 会再收一条 admission pause 告警；现状 phase-1 也如此，
   条数不变。该告警正文只渲染 `set_by`（恒为 `bridge-admission-api`）与 `paused_until`，不含 reason，
   所以 reason 文本的变化对 founder 不可见。
5. 第二张票那种“receipt 已不是 legacy 形态”的路径不受影响。

## 成功定义

- 新的跨版本用例：seed 一个 NULL-owner 行（reason = receipt reason）→ phase-1 以 legacy 模式的 fake Bridge 应答
  （覆盖 reason、无 leaseId）→ takeover 以 lease 模式的 fake Bridge 应答（`lease_id IS NULL AND reason = expected`
  精确匹配，否则 409）。断言：rc=0；phase-1 wire 上的 reason == receipt reason 且不含 `pid=`；行上 lease 为 UUID、
  handoff 0600 同值；不 resume；日志 `legacy pause atomically adopted; owner handoff is durable`。
- 尺子：同一用例指向 `origin/main` 的脚本必须 RED，失败串为 `could not take ownership of the legacy cutover pause`。
- 负例：receipt reason 缺失 / 空 / 首尾空白 / 201 字符 → phase-1 rc=1，`curl.argv` 为空，日志点名。
- 既有 admission-pause 套件 34 条与 `scripts/test-restart-services.sh` 的 FLY-2264 fence 断言全部原样通过。
