# FLY-2226 Discord 插件 gateway 失聪自愈 — 独立 QA 验证报告

Issue: FLY-2226 (https://linear.app/geoforge3d/issue/FLY-2226/通信投递丢失-founder-discord-消息选择性丢投2216-thread-从出生就聋-engineer-顶层-0325z)
日期: 2026-09-01
基于: plan.md, implementation-handoff.md

> 本文覆盖两轮 QA。**第一轮（QA attempt 1）在旧头 `8852c84fb` 上给出的 PASS 是错的** ——
> 它没有承载 Lead 的入场门（详见 §7），已由 rework 打回 implement attempt 2。
> **当前结论以 §0 的 attempt 2 为准。**

## 0. 判决（QA attempt 2）

**PASS**，带三条显式诚实边界（§6）。

| 产物 | 头 | 状态 |
|---|---|---|
| 插件实现 `xrliAnnie/claude-plugins-official` PR #24 | `a5d0135a9d44053436422e52c3b70f27d76b1992` | 判决前重新 fetch，未移动 · OPEN / MERGEABLE / CI SUCCESS |
| Flywheel 锚 PR #1019（纯文档 + 本报告） | `01b63b81c`（= rework baseRevision，local == origin） | CI OK SUCCESS |

## 1. 真机 E2E 环境（零生产触碰）

不走 `test-deploy.sh`：本单改动**完全在 Discord 插件进程内**，无 Bridge / Lead / Codex 侧改动，
起一个隔离插件进程即可直击被改字节；这也规避了 FLY-2231 那类 slot 环境走漏风险。

- 真 bot：`flywheel-test-3`（529 QA Testing Room，slot 3；slot 4 被 FLY-2174 占用，未碰）。
- 真频道 `ops-lead-test` `1493080995862413439`；真告警频道 `test-flywheel-alerts` `1519421055805165842`。
- 隔离：独立 `DISCORD_STATE_DIR` + 独立 `HOME`；token 从 `~/.flywheel/.env` **白名单单取一个变量**（不整包 source）。
- **污染审计（按内容 + 阳性对照）**：阳性对照命中（隔离目录有文件落在窗口内，判据有效）；
  生产 `~/.claude/channels` 1395 个文件，窗口内修改 **0**；生产运行时 `gateway-health*` 产物 **0**。
  `~/.flywheel/alerts|meta-alert` 窗口内有 2 个文件被改，**逐个按内容核过**：
  `claims.db`（生产告警账本）与 `codex_global_unhealthy.txt`（Codex 二进制指向告警，FLY-513），
  时间 13:13–13:14Z，在我最后一次运行（11:16Z）之后，与本单无关。
  ⚠️ 首次审计我用了 `find -newermt '-90 minutes'`，被 bfs 拒绝而把「命令失败」静音成了「0 命中」；
  已改用绝对 ISO 时间戳并加阳性对照重做。上面的数字来自重做后的那次。

## 2. Lead 入场门（attempt 2 必过项）

| 入场项 | 结果 |
|---|---|
| ① 核头 `a5d0135a9` 且 origin == 验证头 | ✅ 判决前重新 fetch，未移动 |
| ② latch 穿透回归（三行，含阳性对照） | ✅ **3/3**（attempt 1 时为 1/3） |
| ③ `@discordjs/ws` 运行时守卫回归 | ✅ **5/5** |
| ④ 真机臂 | 适配器**已改动**，条件不成立 ⇒ **未沿用，全部重跑**，见 §3 |

### ② latch 穿透（确定性时钟，无网络）

| 用例 | attempt 1 (`8852c84fb`) | attempt 2 (`a5d0135a9`) |
|---|---|---|
| 对照：全新 unrecoverable disconnect 告警 | PASS | PASS |
| 已告警过的 episode 再收 4004 | **FAIL（被静默吞掉，只剩日志）** | **PASS** |
| 预算耗尽 latch 期再收 4014 | **FAIL（同上）** | **PASS** |

修法机制：新增 `terminalDisconnect` 标记 —— 已告警的**非 terminal** episode 会被换成一个新 key 的
episode，从而同时绕过 `failEpisode` 的 `alerted` 早退与 alerter 的 `episodeKey` 去重；
而同一 terminal episode 内的重复事件仍然去重。日志里现在能看到两种被吞用例的 `failEpisode` 正文。

### ③ `@discordjs/ws` 运行时守卫（真 gateway + 真 `server.ts`）

| 用例 | 结果 |
|---|---|
| 对照：依赖字节未动 → 守卫通过 | PASS，日志现在**同时点名两个包** |
| 注入 `@discordjs/ws` 1.2.4（`discord.js` 仍 14.25.1）→ 守卫 fail closed | PASS，`unsupported @discordjs/ws version 1.2.4; expected 1.2.3` |
| 守卫失败走**完整告警路** | PASS，真消息 `1544304212458995762` 由 `flywheel-test-3` 投进 `test-flywheel-alerts`，真 GET 读回 |
| REST 健康时不回落 dead-letter | PASS，dead-letter 为空 |
| 依赖字节确已还原 | PASS，**用「对照组能复现」证明，而不是假定** |

🔴 **这条回归差点产出一份假报告，值得写进档**：我第一次把版本注入打在 `dist/index.js`，
文件里明明是 1.2.4，插件加载出来仍是 1.2.3 —— 包的 `exports` 把 `import` 指向 `dist/index.mjs`，
我改的 CJS 包**根本不会被加载**。若照那次结果落笔，我会对一个**工作正常**的守卫报「守卫不生效」。
改正做法：**先证明桩真的落地**（打 patch → 加载出 1.2.4；还原 → 回到 1.2.3），再采信任何结论。
同族第二个坑：我三个真机 harness 仍用旧的 2 参签名，加宽后的守卫收到 `undefined` 直接 fail closed ——
一个长得完全像回归的 harness 断裂。两个都已修在持久副本里。

## 3. 真机臂（attempt 2 重跑，不沿用）

Lead 的「沿用不重跑」是**以 reconnect adapter 未改动为条件**的。它改了：
`forceReconnect` 现在把 recovery 值**当参数传**而不再用本地常量。条件不成立，沿用就是白拿，故全部重跑。

**事故原形（最有判别力）** —— 故障注入在**传输层**（丢 `MESSAGE_CREATE`，socket / 心跳 / shard 全保持 READY）：

| 步骤 | 结果 |
|---|---|
| C2 半聋期 REST 仍可发 | PASS |
| C3 回声超时检出半聋 | PASS |
| C4 强制重连产生真 `shardReady` | PASS |
| C5 入站派发确实恢复 | PASS —— 新会话上 `1544304568471388254` 的回声真的回来了 |
| C6 成功自愈不发告警 | PASS |

**双次强制重连 + 告警 + dead-letter**：S2.1 / S2.2 均 PASS（同一 live strategy map，两次都非空转）；
S6 告警 `1544305407911272519` 由插件自己 token 真发并真 GET 读回；S7 非法频道写 dead-letter、正文无 token。

**单测**：212 pass / 0 fail / 514 assertions（attempt 1 为 208/0/504）。

## 4. issue 自带假设 A 的证伪（我独立复核过）

exploration §108 称「2216 thread 建法不同导致投递面不同」被证伪。我直接读源码核对：
`packages/teamlead/src/bridge/ChatThreadCreator.ts:366-367` 是**新建**分支（无链接），
`:1455` 是**复用**分支 `🧵 ${label} — <#${threadId}>`（有链接）。两条文案分支属实，与投递路径无关。
**这条证伪站得住。**

## 5. 部署现状（必须让 founder 看见）

- 生产运行字节 `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.5/` 里 `gateway-*` 文件数 = **0**。
  **合并 PR #24 不会改变正在跑的字节**，必须走 `scripts/discord-plugin/` cutover。
- 两个开关缺省 OFF，只有精确 `=1` 才启用；漏配 = 不启用。
- `DISCORD_ALERT_CHANNEL`：本机 16 个 lead 的 `.env` 中配置了该变量的 = **0**；
  Flywheel 仓 `packages/` + `scripts/` 全量 grep 命中 = **0**（grep 返回码 1，非静默失败）。
  ⇒ 人工逐 lead 写入之前，告警只落 dead-letter 文件，Discord 上看不见。
  attempt 2 已补一条 startup 双路提示（缺失/非法时明确写出「gateway failures will be dead-lettered locally」），
  但**它本身也发不到 Discord**，所以这仍是灰度前的人工前置。

## 6. 诚实边界（本轮没测到的）

1. **强制重连落在已 Idle 的 shard 上是空操作。** `@discordjs/ws@1.2.3` 的 `WebSocketShard.destroy()`
   开头即 `if (status === Idle) return`。我人为造出该状态后，生命周期 deadline 在 +90 s 准时触发了
   `forceReconnect`，但 shard 87 秒后仍是 Idle、无 `shardReady`（两轮同因，即 S5b/S5c 那两条 FAIL）。
   **这是我注入手法的产物,不是已确认的生产路径** —— 库自己对普通关闭一律带 `recover`，
   而真正会留下 Idle 的不可恢复 close code 走的是 `shardDisconnect`「立即告警、不做注定失败的重连」分支。
   列为**残余风险**，Lead 已记档不阻塞。
2. **24 小时零假阳性观察没做** —— 超出 QA 节点窗口。attempt 1 做过 5.5 分钟真 gateway 稳态窗
   （静默 150 s 零触发；9 次真出站 9/9 回声；强制重连 0、告警 0；追踪集合归零）。
   attempt 2 未重跑该臂，理由是本轮改动不触及探针与计时路径。计划本身已把 24 小时写成 cutover 前置门。
3. **滚动 60 分钟 3 次的预算 latch 只有单测 + 确定性探针证据**，没在真 gateway 上跑满 4 次
   （需 ~10 分钟并会在 QA 频道留 4 条告警，收益不抵成本）。

## 7. attempt 1 发生了什么（留档，不修饰）

attempt 1 我在旧头 `8852c84fb` 上跑完真机臂并落了 `qa-result PASS`。
**Lead 的 QA 入场令（10:12:06Z）比我开工还早三分钟，但我开工、progress 4/6、以及判决前的三次
`inbox --exec-id` 全部返回 `No instructions.`**，它经 teammate mailbox batch 到达时判决已不可变更。
那条入场令的第 ① 项是一道入场门：两条 Lead 必修项任一缺失即快速 FAIL —— 而两条**都不在**那个头里。
⇒ **按 Lead 判据，attempt 1 的正确结论是 FAIL。**
我在指令到达后立刻补跑入场核查、带阳性对照实证了 latch 吞噬，并请 Lead 扣住 ship 门；
Lead 在我那条纠正到达前 3 分钟已把 ship report 投进 thread，随后补置顶 hold 通知并走 rework 正门作废 ship 卡。
⇒ 教训已入库：**交出去代投的产物从交出那刻起就当它已在 founder 眼前，`--publish-only` 是权限边界不是时间窗**；
以及 Lead 已把协议升格为**入场核查必须在判决提交之前完成，收不到入场指令要主动去拉**。

## 8. 证据文件

持久留存于 `~/.flywheel/artifacts/fly2226-qa/`（含 `README.md` 复验配方、`harness/` 五个可复用 harness）：

- `evidence/` — attempt 1（旧头 `8852c84fb`）的 e2e-a..d
- `evidence-a5d0135a9/` — 修复头预跑
- attempt 2 正式轮：`attempt2.log`（单测 + R3 + C + B 全量输出）
- 真 Discord 可点证据：`1544304568471388254`（自愈后回声）、
  `1544304212458995762`（版本守卫失败告警）、`1544305407911272519`（自愈失败告警）
