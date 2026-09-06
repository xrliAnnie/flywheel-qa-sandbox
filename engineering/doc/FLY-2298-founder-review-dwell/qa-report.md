# FLY-2298 founder_review 等待判据 — QA 验证报告
Issue: FLY-2298 (https://linear.app/geoforge3d/issue/FLY-2298/病根-dwell-的是否等-founder判据不认-founder-review-卡-question-checkpoint)
日期: 2026-09-06
基于: implementation-evidence.md

## 结论

**PASS。** PR #1100，验证头 `3ee5ea112`（实现内容）/ 绑定头见文末。

判据："一个 `pm` 节点停在一张已开的 `founder_review` 卡上，本该被认成『在等 founder』，
却被路由成 `deep_dive`，每 3 小时强制重读一次终端 + 工作日志，拿不到『同一 waiting episode
只提醒一次』的抑制。" —— 用**生产事故原始行**复现前后对照，已修复。

## 1. 生产事故重放（最强证据：真数据，不是构造 fixture）

从生产 `~/.flywheel/teamlead.db` **只读**取出 2026-09-03T10:37:03Z 那一 tick 的原始行，
装进隔离 fixture，再跑**真脚本**两遍（origin/main 一遍，PR head 一遍）。生产库全程未被写入。

真实行（逐字来自生产）：

| run_id | issue | pm 节点 execution_id | 节点 started_at | 卡 binding created_at |
|---|---|---|---|---|
| `7feee5e1…` | FLY-2071 | `a0277565…` | 2026-09-03 03:08:20 | `94875688…` @ 07:11:46.566Z |
| `b6e03464…` | FLY-2119 | `f7b7779b…` | 2026-09-03 03:05:06 | `ac114f91…` @ 05:01:39.755Z |
| `1ed28604…` | FLY-2261 | `6b3f9eb7…` | 2026-09-03 03:05:26 | `8a96f422…` @ 07:11:34.570Z |

BEFORE（`origin/main` 的 `lead-patrol-snapshot.sh`）：

```
NODE_DWELL issue=FLY-2071 … over_threshold=yes route=deep_dive
NODE_DWELL issue=FLY-2119 … over_threshold=yes route=deep_dive
NODE_DWELL issue=FLY-2261 … over_threshold=yes route=deep_dive
```

AFTER（PR head 的同一脚本、同一 fixture）：

```
NODE_DWELL issue=FLY-2071 … route=founder_reminder episode=2026-09-03T07:11:46.566Z
NODE_DWELL issue=FLY-2119 … route=founder_reminder episode=2026-09-03T05:01:39.755Z
NODE_DWELL issue=FLY-2261 … route=founder_reminder episode=2026-09-03T07:11:34.570Z
```

三个体全部翻转，episode 锚在**那张卡**的 immutable `created_at` 上。

### 设计假设用真数据交叉验证

第三判据依赖 `question.from_agent == 节点 execution_id`。生产 mailbox 里仍存活的两张
founder_review 卡实测吻合：`3aa24562` 的 `from_agent = a0277565…`（= FLY-2071 pm 的
execution_id）、`a2af6b1f` 的 `from_agent = 6b3f9eb7…`（= FLY-2261 pm 的 execution_id）。
这条 join 不是纸面推理。

## 2. episode 语义（同一份生产 fixture 上继续跑）

| 场景 | 期望 | 实测 |
|---|---|---|
| 旧规则 Lead 写 `waiting_founder`（不带 `episodeStartedAt`） | 拒收且响 | `RECEIPT_REJECTED episode_missing`，rc=65 |
| 新规则 Lead 带 episode 写收据 | 落库 | `episode_started_at=2026-09-03T07:11:46.566Z` |
| 同 episode 下一 tick | 静音 | `waiting_episode_reminded=yes route=none`，零 DWELL_ACTION |
| **纯时间流逝 +7h（>2 个阈值窗）** | **仍静音** | `route=none`，零 DWELL_ACTION ✅ 本单核心诉求 |
| founder 回卡 + 绑新卡且已超阈 | 重新武装一条 | `route=founder_reminder`，该 issue 恰好 1 条 action |
| 卡 binding 跨 run / 跨 execution | 不得豁免 | FLY-9001 仍 `route=deep_dive` ✅ 假阴防线成立 |

## 3. 529 QA Room 实机 N-to-N（真 Discord，零 mock，未碰生产）

`scripts/test-deploy.sh 2 --extra-lead 3:Ops-Test` 把 **PR head 的本 worktree** 部署进
隔离 slot（`FLYWHEEL_DIR=/Users/xiaorongli/Dev/flywheel-FLY-2298`，
`TEAMLEAD_DB_PATH` / `FLYWHEEL_DELIVERY_SECRET_PATH` 全部 slot 内；生产配置未被触碰）。
单 Bridge + **两个真 Lead** = N-to-N 拓扑。

- **归属边界**：`flywheel-test-2` 的快照只出 QA-2071（有卡 → `founder_reminder`）；
  `flywheel-test-3` 的快照只出 QA-9002（无卡 → `deep_dive`）。互不串台。
- **真 Discord 投递**：用 slot 真 bot token POST 到真频道 `1493080993173737583`，
  消息 id `1546109623289774185`（2026-09-06T10:47:39.520Z，author `product-lead-test`），
  并**从 Discord GET 回读原文**作为落地证明（`evidence/529-discord-message.json`）。
- **真收据 → 真抑制**：投递成功后用真 CLI 写 `waiting_founder`（带快照原样的 episode），
  下一 tick `waiting_episode_reminded=yes route=none`；再把收据倒填 7 小时，仍然 `route=none`。
- 结束后 `scripts/test-teardown.sh 2` 干净退出，残留 launchd Lead job = 0。

## 4. 硬门

- **CI（PR head `3ee5ea112`）：14/14 全绿**（Quick Gate / Unit ×5 / Script Tests ×5 / NPM payload / Classify / CI OK）。
- 本地确认：`scripts/__tests__/lead-patrol-snapshot.test.sh` 331 passed / 0 failed；
  `StateStore.node-dwell-review` + `node-dwell-control` + `fly369-patrol-rule` 41/41；`pnpm -r build` rc=0。

## 5. 部署面必须知道的两件事（不是 blocker）

1. **legacy 收据一次性重武装 —— 已定量。** 迁移前的 `waiting_founder` 收据没有
   `episode_started_at`，新判据要求非空，所以部署后第一个 patrol tick 会把仍在等 founder 的
   legacy episode 各重武装一次。**当前生产实测受影响 = 7 个节点**（FLY-1759 / 1687 / 1758 /
   1765 / 1560 / 1766 / 2309，全部是 `founder_gate/review` 且 run 仍 active）。
   ⇒ founder 会收到 7 条 grouped reminder，之后恢复 exact-episode 抑制。方向正确（这 7 个
   确实在等她）、一次性、自愈。
2. **旧规则窗口已被部署链闭合。** 规则文件在 `packages/teamlead/lead-rules-base/*`，
   `scripts/restart-services.sh:1950` 对该前缀 `_restart_all_leads=true`，所以这次部署会重启
   全部 Lead、换上三判据规则。万一某个 Lead 仍持旧规则，写收据会 `RECEIPT_REJECTED
   episode_missing` 当场报错（fail-loud，不是静默吞掉）。

## 6. 诚实边界（我明确没做到的）

- **真 Lead 的 prompt 遵循没验成。** 529 房里我确实把真 slot Lead 拉起来并让它跑 patrol，
  但它在 5h Claude 配额 2%（08:39 本地才 reset）下被限流，单轮 thinking 4 分半没有推进，
  我中断了它以免继续吃全机共享配额。因此「真 Lead 读了新规则后会不会把快照的 `episode=`
  原样填进收据 JSON」这一步**没有实机样本**。风险被 `RECEIPT_REJECTED episode_missing`
  的 fail-loud 兜住（Lead 当场看得见、当轮可改），但它仍是一个未验证点。
- **Claude-in-Chrome 断连，founder 浏览器路径没跑。** `list_connected_browsers` = `[]`，
  `chrome-diagnose.sh` = `LOCAL_STATUS=READY`（FLY-1116 那种半死态），修复需要 founder
  亲手做 R5/R6，我做不了。本单没有 founder 点击类动作，所以改用真 bot token 的
  Discord POST + GET 回读来证明投递落地——证据强度不低于截图，但**浏览器侧确实没跑**。
- **529 slot 的 chat thread 未启用**，grouped reminder 落在频道顶层而不是 issue thread。
  这是该 slot 的既有限制（同房 07:39 的历史消息里 Lead 自己也这么说），不是本 PR 的行为。
  「一个 issue 一条」这条语义我验的是 action 计数，不是 thread 归属。
- **`founder_review_card_binding.created_at` 若不可解析**，`strftime` 会返回 NULL 并
  `coalesce` 回落到节点 `started_at`（静默、不 fail-loud）。当前写入方产不出这种形状，
  我没有构造该输入，只是把它记在这里。
