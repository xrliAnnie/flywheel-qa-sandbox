# FLY-2076 Claw 值守席位 — 独立 QA 报告(DAG qa 节点)

Issue: FLY-2076 (https://linear.app/geoforge3d/issue/FLY-2076/2073值守-claw-infrabot-值守上岗对整条队列负责-初审三去向宁转勿吞)
日期: 2026-08-27
基于: plan.md §12(founder 返工)、PRD `product/doc/FLY-2060-alerts-duty/prd.md` R1/R2/Q3/§6、实现方自验报告 `qa-report.md`

> 本文是**独立复核**,不是实现方 `qa-report.md` 的复述。每条结论都由我在冻结 head 上亲自跑出来,
> 并对每个关键判据加了阴性对照(证明我的尺子会变红)。与实现方声称不一致的地方,逐条写在 §6。

## 0. 结论

**PASS。** 被验 head `80a8925a6beba8d5f9932ffe519ac43e3a82c274`,
`git ls-remote origin flywheel-FLY-2076` 与本地 HEAD 相等(2026-08-27 14:40 PT 核过)。

founder 返工三条硬门,我全部独立复现:

1. **一条连续真实链**(告警 → 真 Discord root/thread → 工单 → Claw 去向 ② → 热切 OFF 只落账 → 热切回 ON 同一 event id 恢复):**11/11 PASS**,新一轮真实 Discord 消息 id `1542651011171094548` / `1542651023699476524`(与实现方那轮不同,是我这次真跑出来的)。
2. **总开关进 database、改后不重启**:我另外走了**真正的运维入口**(`/api/fleet/flag/stage` + `/api/fleet/flag/apply` 的真实 handler,即 `flywheel-comm feature-flags apply` 打的那两个端点)——实现方只验到 `store.applyFlagValueChange` 这一层。**7/7 PASS**,含「managed flag 无 reason 必须 400」的阴性对照。
3. **Claw = 拿到新职责,不是新 agent**:改的是既有 `.lead/claude-infra-bot-lead/identity.md`,里程碑与角色文件表述正确;没有新增 agent、没有新增告警层、没有指标/考核/hard limit/噪音判定层。

另有 **1 条 MEDIUM 咨询级发现**(不挡硬门,见 §5.1)与 **1 条部署前置条件**(见 §5.2),都交 Lead / founder 判。

## 1. 我自己跑的证据(全部在冻结 head 上)

| # | 验的是什么 | 结果 | 复跑命令 |
|---|---|---|---|
| A | 连续真实 Discord 全链 + 热 OFF/ON | **11/11 PASS** | `TEST_BOT_TOKEN_1=… QA_REPO_ROOT=$PWD node qa-e2e/real-discord-e2e.mjs` |
| B | A 的**阴性对照**(突变检验) | 见 §2,**尺子会红** | 见 §2 |
| C | 真 Bridge 挂载 / duty 能力隔离 | **9/9 PASS** | `env -u DISCORD_OWNER_USER_ID QA_REPO_ROOT=$PWD node qa-e2e/bridge-mount.mjs` |
| D | 积压排空 / 无 hard limit / 无噪音层 | **6/6 PASS** | `QA_REPO_ROOT=$PWD node qa-e2e/backlog-drain.mjs` |
| E | **运维入口真开关**(新增,我写的) | **7/7 PASS** | `node qa-e2e/qa2076-operator-flag-path.mjs` |
| F | **启动 provisioning × 活 Bridge**(新增,我写的) | **6/6 PASS** | `TEST_BOT_TOKEN_1=… node qa-e2e/qa2076-duty-launch-live-bridge.mjs` |
| G | 角色 / 门控 shell harness | **19/19 PASS**(5+8+1+5) | `bash packages/teamlead/scripts/__tests__/{alert-duty-launch-plan,apply-alert-duty-gate,fly2076-identity-sentinel,lead-duty-provision}.test.sh` |
| H | 定向单测(11 个文件) | **266 passed**(175 + 91) | 见 §4 |
| I | flag drift / registry | **13 passed** | `pnpm --filter flywheel-config exec vitest run src/__tests__/feature-flags-drift.test.ts` |

### E 的细节(founder 那句「feature flag 必须进 database、不需要重启」)

我用真实的 `handleFlagStage` / `handleFlagApply`(Bridge `/api/fleet/flag/*` 背后的同一份代码)+ 真实
StateStore flag store 跑:

```
✓ baseline: the running pipeline reads ON
✓ operator route accepts alert_system for staging — code=200
✓ operator apply commits the change to flag_values — code=200 {"ok":true}
✓ SAME live flagStore object now reads OFF (no restart, no new object)
✓ value is durable in flag_values — raw=0 override=true
✓ operator route turns it back ON hot — code=200
✓ negative control: managed flag refuses a reasonless change — code=400
```

只有 fleet-console 的 token 发放与 audit sink 是我替身实现(**明说**:这两块是既有 console 基建,
不属于本单改动面);flag 的解析、STORE_MANAGED_FLAGS 归属、codec、CAS revision、落 `flag_values`、
以及**同一个活对象下一次读立即变**,全是产品代码。

### F 的细节(接入机制:Claw 启动时怎么变成全队列席位)

实现方的两个 harness 分别验了「真 Bridge 挂 /duty」和「provisioning 脚本对 fixture 的行为」。
我把两半**接起来**:真的 `createBridgeApp` 起进程 → 真的 Discord `/users/@me` 解析 dispatcher bot
身份(`1493068669444427927`)→ 真的 `lead-duty-provision.sh` → 真的 `access.json` 被改。

```
✓ real Discord resolves the dispatcher bot identity — 1493068669444427927
✓ seat launch line … [alert-duty] seat=true lead=claude-infra-bot-lead channel=1519421055805165842 gate=changed dispatcher=1493068669444427927 token=set
✓ the REAL access.json alerts group is now 全队列 — {"requireMention":false,"allowFrom":[]}
✓ the real dispatcher bot is ADDED to allowBots without dropping the existing entry — ["999999999999999999","1493068669444427927"]
✓ negative control: 非席位 Lead → seat=false 且 access.json 一字未动
✓ negative control: 没有 duty token → gate=skipped:no_duty_token 且 access.json 一字未动
```

fixture 形状我核过跟**生产**一致:`~/.claude/channels/discord-claude-infra-bot-lead/access.json`
的 `allowBots` 在**顶层**、group 里只有 `requireMention` / `allowFrom`。生产该文件里
`1518793447165661254`(= `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`)这一组**已存在**且当前
`requireMention: true` —— 也就是说这次 provisioning 有明确的翻转目标,不会走
`skipped:no_alert_group`。

## 2. 我对 A 做的突变检验(证明 A 不是空过绿测)

先在隔离沙箱(拷贝 dist、软链 node_modules)跑一遍**健康对照**:11/11 PASS,证明沙箱本身没坏。

| 突变 | 结果 | 说明 |
|---|---|---|
| M1:`infra-alert-wiring.js` 的 `if (!alertsEnabled())` 改成 `if (false)` | **10 PASS / 1 FAIL** | 只有「OFF 落 lead_events」这条红。对外行为仍正确 —— 因为 `LeadAlertNotifier.alert()` 是**第二道**独立的门。这是个**正面**发现:防御是两层的。 |
| M2:`storeAlertSystemEnabled()` 直接 `return true` | **7 PASS / 4 FAIL** | 包含「OFF 时真的往 Discord 发了一条」(消息 id `1542651356580552805`)。判据在**会让它失败的方向**上确实会红。 |

两个突变都已还原(沙箱是拷贝,worktree 的 dist 未被改)。M2 在隔离 QA 频道留下一条「OFF 期间不该出现」的
测试消息,那是突变检验的痕迹,不是产品行为。

## 3. 我读代码找门的漏口(结果:没找到旁路)

- 全仓只有一处 `new LeadAlertNotifier`(`plugin.ts:8978`),已带 `deliveryEnabled`。
- `plugin.ts` 里所有告警发射都汇到 `routedAlertSink` → `routedAlertSinkCore`(已带 `alertsEnabled`);
  `alertHub.handle` 只从 `routedAlertSinkCore.rawSink` 进入,没有旁路调用。
- `WorkflowEngineDispatcher` 的 `reconcileWorkflowEngineAlerts` / `reconcileAdmissionPauseAlert` 都在门后,
  OFF 时不 claim durable row(不消耗 attempt)。
- `founder-action-drain` 的 `emit_alert` 分支 OFF 时**原样返回**,不消耗 must-deliver 预算;
  我另外核过 `drainFounderActionLedger` 是**逐行独立**循环,只有 `depends_on` 会等父行 —— 而全仓
  生产代码没有任何 `dependsOn:` 写入点,所以不存在「一条被推迟的 emit_alert 卡住其他 founder 动作」。
- `MetaAlertNotifier` 是桌面/文件的**兜底元告警**(告警系统自己坏了才用),不进频道、不派工单、
  不投 Claw —— 不在这个开关的语义面内。但它引出了 §5.1 的发现。

`rescue-route` 删掉 `ackTicket` 是**计划内的唯一删除**(plan T14 / research §1.4):让 `acked_at`
只有值守一个写入者。相关测试已改为断言「rescue 不写 ACK」,我跑过通过。

## 4. 定向单测(我自己跑的)

| 范围 | 结果 |
|---|---|
| `flag-store-runtime` / `infra-alert-wiring` / `founder-action-drain` / `alert-duty-router` / `alert-ticket-lifecycle` / `alert-threads-tickets` / `LeadAlertNotifier` / `alert-duty-seat` / `alert-duty-seat-cli` / `rescue-route` | **175 passed(10 files)** |
| `workflow-engine-dispatcher` | **91 passed** |
| `flywheel-config` feature-flags drift | **13 passed** |
| `pnpm --filter flywheel-config test:run` | **675 passed / 44 files** |
| `pnpm lint` | **exit 0**(15 warnings,均在本 PR 未改文件) |
| `pnpm --filter flywheel-config --filter flywheel-teamlead --filter flywheel-comm build` | PASS |

## 5. 发现与边界

### 5.1 【MEDIUM,咨询级,本分支新引入】关掉告警系统 + 旧队列非空 ⇒ 会给 founder 弹一个**假的**「告警链路坏了」

**机制(实测,不是推理)**:开关 OFF 时 `LeadAlertNotifier.drainQueue()` 提前返回
`{ sent: 0, remaining: <队列里的条数> }`。`plugin.ts` 的 60s drain timer 里那个既有判据是
`sent === 0 && remaining > 0` → `drainStuckCycles++`,累计 5 次(≈5 分钟)后触发
`metaAlertNotifier.notify({ reason: "drain_stuck", … "The Discord alert path is likely down or misconfigured." })`
—— 桌面通知 + 文件,10 分钟去抖后**反复**发。

**实测证据**(`qa-e2e/qa2076-off-drain-stuck-probe.mjs`,真 `LeadAlertNotifier` + 真队列目录):

```
alert while ON with 503 backend -> {"queued":true}
drainQueue while OFF -> {"sent":0,"remaining":1,"deadLettered":0,"staleSuppressed":0}
plugin condition (sent===0 && remaining>0) -> true
```

**为什么是本分支新引入的**:改动前 `sent=0 && remaining>0` 只可能来自「真的发不出去」;
改动后「操作者主动关掉」也会产生同一个信号。两种状态留下同一个痕迹。

**为什么我没有据此判 FAIL**:
- founder 写下的 OFF 合同是「不进频道、不派工单、Claw 不接;账本仍记」—— 这条元告警走的是
  **桌面/文件**,不进 Discord 频道、不建工单、不投 Claw,三条硬门都不破;
- 触发还需要「切 OFF 那一刻旧队列非空」。我查了生产 `~/.flywheel/alert-queue/`:**0 个 `.json`**
  (只有一个 `.rate-*` 桶文件,不计入 `entries`),所以今天不会发生。

**但它值得修**:最可能按下这个开关的场景恰恰是**告警风暴**,而风暴正是队列非空的时候。
修法是一行(OFF 时把 `drainStuckCycles` 归零,或干脆 OFF 时跳过这个 timer 分支)。
我不替 Lead / founder 决定要不要在本单修 —— 只把代价说清楚:不修的代价是「她关掉告警后,
可能被反复告知告警链路坏了」。

`remaining > FLYWHEEL_ALERT_QUEUE_MAX`(默认 500)的 `queue_overflow` 元告警同理,门槛更高。

### 5.2 【部署前置,非缺陷】`FLYWHEEL_ALERT_DUTY_TOKEN` 现在还没配

`~/.flywheel/.env` 里目前**没有** `FLYWHEEL_ALERT_DUTY_TOKEN`(我 grep 过,0 处)。
设计是 **fail-closed**:没有它,`lead-duty-provision.sh` 打
`gate=skipped:no_duty_token` 且**不动** `access.json` —— 我在 §1.F 用阴性对照实测过。
所以部署时必须由运维补这一项,否则 Claw 仍然是「只看 @ 我的」,不是全队列席位。
这不是代码缺陷,是一条必须写进部署清单的前置条件。

### 5.3 【未覆盖,诚实边界】真的 Claw 自己判 ①/②/③,没验

链路里 🧭 那一帖是 harness 用真 bot token 发进真 thread 的,随后的 `handoff` 走的是真 CLI + 真账本
+ 真根消息重渲染 —— **机制**是真的,**判断**不是 Claw 做的。

我追过一层「什么在铸这个约束」,不是一句「太难」:
- `resolveAlertDutySeat()` 只在 `leadId === "claude-infra-bot-lead"` 时返回席位
  (`packages/teamlead/src/alert-duty-seat.ts:22`);
- 529 QA Room 的 slot Lead 拿的是 slot agentId(`flywheel-test-N`),而且 test-deploy 生成的
  身份提示里明写 Bridge 会对**生产 Lead 名**做 scope 检查并 403
  (`scripts/test-deploy.sh:1201`、`:1629`)。

也就是说:**529 房用现有开关拼不出 Claw 的值守席位**。要验这条腿,得手工造一份
`agentId=claude-infra-bot-lead` 的 slot projects.json 并起一个带 Claw identity 的真 Lead 进程,
那超出本 qa 节点的边界。**风险定价**:角色文件的行为契约(三去向/不装懂/压力自述/R8/runbook 沉淀)
目前只有文本审查 + 哨兵脚本背书,没有一次真实的自主判断样本。上线后第一条生产告警仍需有人看一眼
Claw 选对了没有。

### 5.4 全量测试的诚实边界(以及我自己犯的两次量错)

`pnpm --filter flywheel-teamlead test:run` 我跑了三轮,失败数 **55 → 29 → 20**。差异**全部是我自己的
测量环境**,不是代码:

1. 第一轮 55:我这个 runner session 的 `TMPDIR` 在 `~/.flywheel/...` 里面,而
   `codex-lead-runtime` 的 full-access 守卫**正确地**拒绝了与 `~/.flywheel` 重叠的 project root
   → 26 条假红。换 TMPDIR 后消失。
2. 第二轮 29:新 TMPDIR 路径太长,`CodexLeadInboxSocket` 的 unix socket 撞 `sun_path` 104 上限
   → 8 条假红。换短 TMPDIR 后消失。

剩下 20 条,我逐类归因:

- **`fly247-bash-suites` 的 3 条**(`flywheel-fleet report` / `--changes-file` / `lead-flags`):
  确定性失败。我用 `git archive dedf2aed5`(merge-base = main)在临时目录跑**同一批 bash suite**,
  失败**逐字相同**(`✗ R1: rc=0` / `✗ E3 rc=1 status=rejected model=absent` / `✗ L9 rc=1 mutated=no`)
  ⇒ **main 上已经这样,与本 PR 无关**。
- **其余 17 条**:5s/10s 超时形状(真 git / Keychain / chokidar / 真 tmux),每轮命中的文件不同;
  单独跑 `createLeadRuntime-preflight`(4/4)、`workflow-docs-git.integration`(4/4)全绿
  ⇒ 高负载并发导致。
- **`fly1674-opus46-real-tmux` 1 条**:单跑也红,错误是
  `ENOENT … /private/tmp/f1674-*/tmux/tmux-501`(它自己起的 tmux 从没落出 socket)。
  与实现方 §6 报的 `tmux-slot-routing.real-tmux` 同一族(宿主 tmux 环境)。本 PR 的 diff
  **一个 tmux / runner 文件都没碰**(`git diff --name-only` 对 `tmux|runner` 零命中),
  该测试文件 import 的 `flywheel-claude-runner` / `workflow-menu.js` 也都不在 diff 里。
- `pnpm --filter flywheel-comm test:run`:1650/1651,唯一失败
  `qa-result.realgit.test.ts` 是 5s 超时,单跑 **2/2 PASS**。

**我没有把这些说成全绿**;也没有把它们赖给本 PR —— 每一条都给了归因证据。

### 5.5 其它不越界声称的部分

- 我没有部署、没有重启任何生产进程、没有改生产 `.env` / `access.json` / `teamlead.db`。
- 真实 Discord 证据落在隔离的 `#test-flywheel-alerts`(`1519421055805165842`),
  mention 全部是不可 ping 的假 snowflake,`allowed_mentions.parse=[]`。
- FLY-2077(contact book 内容)、FLY-2078(被 @ Lead 的必达性)不在本单验收面内。
- flag 的 CI 拦截与存量迁移 founder 已另立单,本单确实没做 —— 我核过,没有偷偷做。

## 6. 与实现方 `qa-report.md` 的差异

| 项 | 实现方声称 | 我的实测 | 处置 |
|---|---|---|---|
| 连续真实链 11/11 | PASS(标记 `QA2076-5823537`) | **复现 PASS**,新消息 id `1542651011171094548` | 一致 |
| Bridge mount 9/9 | PASS | 首轮我拿到 8/9 —— 是我 shell 里 `DISCORD_OWNER_USER_ID` 污染导致「control: distinct tokens load cleanly」红;`env -u` 后 **9/9** | 一致(我的仪器问题) |
| backlog 6/6、shell 19/19 | PASS | 复现 PASS | 一致 |
| 「`pnpm test:packages:run` 只剩一条既有 real-tmux 失败」 | — | 我在 teamlead 全量看到更多失败,但归因后**没有一条落在本 PR 面上**(§5.4) | 补充说明,不构成分歧 |
| 运维入口 | 只验到 `store.applyFlagValueChange` | 我补验了 `/api/fleet/flag/stage`+`apply` 真 handler,7/7 | **我这边更强,结论相同** |
| OFF 的副作用面 | 「不发送、不 deadletter、不消费排队项」 | 属实,但**没提** drain-stuck 元告警会因此误报(§5.1) | **新增发现** |

## 7. 可重跑清单

```bash
export TMPDIR=/tmp/q76 && mkdir -p $TMPDIR
set -a; . ~/.flywheel/.env; set +a
QA=engineering/doc/FLY-2076-claw-duty-seat/qa-e2e
QA_REPO_ROOT=$PWD node $QA/real-discord-e2e.mjs                 # 11/11
env -u DISCORD_OWNER_USER_ID QA_REPO_ROOT=$PWD node $QA/bridge-mount.mjs   # 9/9
QA_REPO_ROOT=$PWD node $QA/backlog-drain.mjs                    # 6/6
node $QA/qa2076-operator-flag-path.mjs                          # 7/7  (本报告新增)
env -u DISCORD_OWNER_USER_ID node $QA/qa2076-duty-launch-live-bridge.mjs   # 6/6  (本报告新增)
node $QA/qa2076-off-drain-stuck-probe.mjs                       # §5.1 证据
```
