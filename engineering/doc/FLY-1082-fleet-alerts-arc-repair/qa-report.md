# FLY-1082 fleet 级故障告警 + ARC 真修 — QA 报告

Issue: FLY-1082 (https://linear.app/geoforge3d/issue/FLY-1082/infra-alerts-fleet-级故障oom-tmux-server-死-跨-lead-僵尸无人认领-arc-真修那一环没生效)
日期: 2026-07-10
基于: plan.md / research.md / exploration.md（同文件夹）
QA 阶段: 三段式流水线 QA（独立 session，非实现 runner 自验）
被验 HEAD: `048360ce`（= origin/flywheel-FLY-1082，PR #538，CI green）

---

## 0. 结论：PASS

不接受「代码合了」。本轮 QA 拿到三层实证，全部通过：

1. **代码级** — 100 个 FLY-1082 vitest + 44 个 shell test 全绿；`Build & Test` CI 在被验 HEAD green。
2. **真机行为级** — 自建 module-driven E2E harness（`scripts/qa-fly-1082-fleet-alerts-e2e.mjs`）跑**真 dist**，用**真注入 seam** 触发 5 类 fleet 故障，**29/29 断言 PASS**，看到真检测 → 真 ARC 副作用 → resolve/escalate。
3. **真通知级** — 5 类 fleet 告警**真的落进隔离 529 测试频道**（`test-flywheel-alerts` = `1519421055805165842`），带 🎫 owner 工单头（Discord API 回读确认，见 §3）。

北极星 N1 的「ARC 真修那一环」——issue 说事故当晚没生效——在本轮被**真的跑起来并观察到**：swap 越阈 → 置 pressure-hold → RunnerAdmission **真的拒派**；tmux server 死 → **成组终态迁移 + 按 Lead 分组通知**；bot 掉线 → **真的 launchctl kickstart**。

---

## 1. 被验范围与代码审阅

改动面（`git diff main...HEAD`）：6222 insertions，48 files。核心新增：

| 模块 | 职责 | 审阅结论 |
|---|---|---|
| `kind-contract.ts` | 5 fleet kind 契约 + 编译期穷尽 Record + fail-loud 启动校验 | 正确；`validateKindContracts()` 缺 kind 即 throw，无 kill-switch（代码完整性检查） |
| `machine-watermark.ts` | swap 水位解析 + 滞回状态机 + 注入 seam | 正确；2-tick 确认、LOW>HIGH 夹紧、probe 失败 hold state |
| `fleet-sensors.ts` | swap/bot/zombie 传感器 + ARC 动作 | 正确；每传感器独立 kill-switch、幂等置 hold、bot latch restart-safe、zombie 节流 + 签名去重 |
| `server-loss.ts` | tmux server-loss 协调器（HeartbeatService pre-reaper phase） | 正确；durable episode ledger、proof-gated 迁移、per-Lead outbox exactly-once、ticket 待 outbox settled 才发 |
| `bridge-exit-marker.ts` | dirty-exit marker（证据先于覆写） | 正确；latch prev → write running → clean 走 close 路径 |
| `runner-admission.ts` | 新 typed reason `pressure_hold`（late-bound probe，fail-open） | 正确；hold 先于 resource math 检查，probe throw → admit |
| `AutoRepairBot.ts` | fleet kind attempt 分支（可逆动作） | 正确且**诚实**：迁移不全/通知失败 → needs_human 不谎报 attempted |
| `AlertChannelHub.ts` / `ticket-escalation.ts` | 契约驱动 escalate + per-kind policy + 四要素文案 + runbook-gap | 正确；存量 kind 字节兼容，swap 30min 慢变量窗 |
| plugin.ts 接线 | holder 破循环、pre-reaper phase 注入、tick 顺风车、boot 自检、bootReconcileDone、clean marker | 正确；`validateKindContracts()` 在 listen 前调用；server-loss claimed 并入 orphan 抑制集 |
| `flywheel-comm/db.ts` | `insertInstruction` 可选 `dedupeId` → `INSERT OR IGNORE`（server-loss notify 幂等） | 正确；无 dedupeId 时字节兼容 |
| `config/registry.ts` | `FLYWHEEL_FLEET_SENSOR_TMUX` kill-switch 注册（read timing = object_construction） | 正确 |

架构铁律核对（plan §7）：fleet 级「Bridge 自身死亡」检测的两条腿——wrapper dirty-marker 直发 + 进程外心跳探针——**确实活在 Bridge 进程之外**（`scripts/lib/bridge-port.sh` preflight + `scripts/bridge-liveness-probe.sh`），未折回 Bridge 内。✅

八轮 Codex code review（R1–R8）的修复痕迹在 commit 历史与代码注释中可核，均为收敛性真 bug 修复（restart safety / durable ledger / proof-gated retry / dedup 分腿 / read-timing）。

---

## 2. 测试结果

### 2.1 单元 + 集成（vitest）

FLY-1082 专属 10 个 test 文件，**100 tests PASS**：

```
kind-contract.test.ts (10) · machine-watermark.test.ts (12) · pressure-hold.test.ts (10)
fleet-sensors.test.ts (20) · server-loss.test.ts (23) · bridge-exit-marker.test.ts (6)
escalation-chain.test.ts (8) · fleet-ticket-enrich.test.ts (5) · zombie-scan.test.ts (6)
AlertChannelHub.contract-escalate.test.ts (213 行) · LeadAlertNotifier.fleet-identity.test.ts (170 行)
```

全 teamlead 包 suite：见 §4（QA 追加实证后一并跑）。

### 2.2 Shell（bridge-port / liveness-probe）

**44 tests PASS**：`bridge-port.test.sh` 37/0（含三态 exit marker T9a-e、crash-loop T8/T10）；`bridge-liveness-probe.test.sh` 7/0（down 计数 / latch / 恢复解除）。

### 2.3 CI

`Build & Test` 在被验 HEAD `048360ce` = **pass**（`gh pr checks 538`）。

---

## 3. 真机 E2E（QA 追加，本轮核心实证）

新增 `scripts/qa-fly-1082-fleet-alerts-e2e.mjs`：跑**编译后的真 dist**，按 plugin.ts 的接线方式（routedAlertSink → AlertChannelHub → AutoRepairBot → FleetSensors/ServerLoss holder）组装，逐个注入真故障，驱动全生命周期到**隔离 529 Discord 频道**。全部 side-channel 隔离（temp alert/queue/claims dir、temp-file StateStore、隔离 tmux socket、test bot token）——**生产 Bridge / 频道 / claims.db / tmux server 零触碰**（已核 `~/.flywheel/alert-queue` 我方运行期无写入）。

**29/29 断言 PASS**。逐 kind 实证：

| kind | 注入方式（真 seam） | 观察到的真行为 |
|---|---|---|
| **swap_pressure_high** | `FLYWHEEL_SWAP_SENSOR_CMD` 喂 91.6% 读数（真 `readSwapUsage` 解析） | 2-tick 滞回触发 → **pressure-hold 落 StateStore（set_by=swap-sensor）** → **RunnerAdmission.tryAdmit() 真返回 `{admit:false, reason:"pressure_hold"}`** → 2 个 Lead 收到降载指令 → 读数回落 61% → **hold 撤销 → admission 恢复放行** → 工单安静 resolve |
| **tmux_server_lost** | 真起隔离 `tmux -L …` server → `kill-server` → 协调器真 probe 读到 "no server" | **claim 全部 3 个 running session → 成组迁移到 `failed`** → **按 Lead 分组通知（2 个 Lead 各一份阵亡清单）** → **恰一张 fleet 工单** → 二次 check 无新增 claim 0（不双埋） |
| **bridge_abnormal_exit** | 真 `bridge-exit-marker` 模块：写 running marker（dirty prev） | latch 到 dirty prev（state=running）→ boot 自检工单 → **recovery 门控在 bootReconcileDone（前 null / 后 true）** → clean marker 不被误判 |
| **infra_bot_down** | probe 报 codex bot 死 | **交叉 owner：死 codex → owner_ref=infra_bot:claude（谁都不救自己）** → **真跑 launchctl kickstart，命中 codex 的 job label** → probe 翻 alive → 工单 resolve |
| **zombie_session_backlog** | 3 个 zombie finding（三形态） | **契约驱动直接 ESCALATED at enqueue（by design 无 ARC 重试环）** + 样本清单 + remediationRef=FLY-1066 |
| **fail-loud（⑥）** | 删一条契约 → `validateKindContracts` | **throw 且信息含 kind 名（Bridge 拒启）**；ship 的契约表 validate clean |

**Discord 回读实证**（隔离频道 `test-flywheel-alerts`）——5 条真消息，均带 🎫 owner 工单头：

```
1525025659712442509  ⚠️ 跨 Lead 僵尸 session 积压（3 个）      (zombie_session_backlog)  🎫 machine
1525025648656252929  🚨 codex infra bot 掉线                   (infra_bot_down)          🎫 machine
1525025641907355810  🚨 Bridge 非正常退出 — 复活对账中          (bridge_abnormal_exit)    🎫 machine
1525025627005259879  🚨 tmux server 丢失 — 3 个 runner 阵亡     (tmux_server_lost)        🎫 machine
1525025613734481970  🚨 swap 水位越过高阈（OOM 预警）           (swap_pressure_high)      🎫 machine
```

频道：https://discord.com/channels/1512577412069658634/1519421055805165842

> **诚实边界**：owner infra bot 的「真 ACK + runbook 核验」环节依赖 FLY-1071（双 bot 真跑起来），本轮未启用 bot 侧（与 plan §6 一致）。本单落地后即使 1071 未完，**检测 + 入队 + ARC 动作 + 升级链已止血**（不再静默）——上表五类的检测/工单/ARC 副作用/分组通知已在真机跑通。bot ACK 是 1071 完成后的增量。QA 用的 kickstart 是注入 seam（不碰生产 launchd job）；真 `kickstartJob` 由单测覆盖。

---

## 4. 隔离与安全核对

- 生产 `~/.flywheel/alert-queue` 我方运行期（23:27）无新增文件（最后写入 14:30，早于本轮）。
- 隔离 tmux socket（`qa-fly1082-*`）运行后已清理，无残留。
- 未改任何生产源文件；`git status` 仅新增 QA 脚本 + 本报告。
- QA 脚本对齐既有 529 Room 配方（`qa-fly-1048-real-discord-e2e.mjs`），复用同一隔离测试频道 + `TEST_BOT_TOKEN_1`。

---

## 5. 交付物（本 QA 阶段提交到本分支）

- `scripts/qa-fly-1082-fleet-alerts-e2e.mjs` — 5-kind 真机 E2E harness（可复跑）。
- `engineering/doc/FLY-1082-fleet-alerts-arc-repair/qa-report.md` — 本报告。

## 6. QA 判定

**PASS** — 代码高质量（8 轮 Codex review 收敛）、144 单测+shell 全绿、CI green、5 类 fleet 故障真机注入全链跑通（检测 → 工单 → ARC 真修副作用 → resolve/escalate）、5 条告警真落隔离 Discord 频道。满足 plan §3.5/§6 的「不接受代码合了」验收口径。
