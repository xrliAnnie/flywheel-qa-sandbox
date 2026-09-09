# FLY-2134 监控者的监控 — 探索
Issue: FLY-2134 (https://linear.app/geoforge3d/issue/FLY-2134/infra观测-没有人监控这些监控者4-例自动机制静默失效-2-5-个月无一发出声音-其中全舰-12-个-lead-的-1043)
日期: 2026-09-08
基于: 无

**Mode**: Technical · **Depth**: Deep · **Status**: final(Lead 4 问已非阻塞发出,ask `5025382b`;未答则按本文推荐值)

> Linear MCP 本会话 401,issue 评论未读;issue 正文来自 dispatch 注入。~/.flywheel/.env 无 Linear key,curl 兜底也放弃。这是本文的一条边界。

## 0. 一句话

给全舰每个「自动机制」登记一个**期望产出物 + 新鲜度阈值**,由一个**独立进程**按产出物年龄判活并告警,与该机制自身的日志、退出码、是否被 disabled 全部无关;再让这个检查者、Bridge、bridge-liveness-probe 三方互看成环,回答「谁监控监控者」。

## 1. 2026-09-08 复核:四例现状(全部只读取证,命令见 §8)

| # | 机制 | 08-28 issue 记 | 09-08 复核 | 结论 |
|---|---|---|---|---|
| 1 | `~/.flywheel/token-usage.db` | 最后写入 06-30;launchd 单元 disabled | 仍 06-30 20:28;`com.flywheel.token-usage-daily => disabled`;`units.manifest` 把它登记为 `copy` 策略,`fly1814-aux-decisions.tsv` 记 `pending / provenance unknown` | **仍死**。FLY-1814 census 对 disabled 标签**故意 `continue`**(设计:收敛不得撤销有记录的决定),只计 `skipped_disabled`,不算 anomaly ⇒ 永不告警 |
| 2 | chezmoi `com.chezmoi.auto-sync` | ahead 118;远端 03-15 | **ahead 126**;远端仍 `121bcd2` 2026-03-15;本地最新 09-06;`launchctl list` 报 last exit **0**;`chezmoi-sync.log` 每天写「Sync completed」;error log 里 `chezmoi re-add` 反复 `Killed: 9` | **仍死且仍报成功**。脚本只在有*未提交*改动时才 push,push 失败后已提交的积压再无人推 |
| 3 | 8 个 aux 单元 disabled | 全部 disabled,不知谁关的 | 仍全部 disabled。FLY-1814 已查:6 个带 `bak-fly886-20260709` 戳(FLY-886 sub→tidal-echo 迁移被取消的残留),`skills-update` / `token-usage-daily` 来源不明;Annie 08-18 裁定「要救不过不急,逐条审批」⇒ D3b 清单,`fly1814-enable-aux-job.sh` 单标签救回 | **已知、已有审批通道**。本单不救、不 enable;只解决「关掉」和「在跑」在所有报告里长得一样 |
| 4 | `~/.claude/agent-memory` 零副本 | `?? agent-memory/`,chezmoi 0 命中 | **已修**(FLY-2145 + FLY-2146,09-03/04):独立私有仓 `xrliAnnie/lead-memory`,`com.flywheel.lead-memory-sync` 每小时 :17 推,`com.flywheel.lead-memory-arrival-check` 每小时 :40 看远端;09-08 本地 HEAD `8c6a26e` == `ls-remote` 远端;`arrival/checks.tsv` 每小时一行 `fresh`。规模已长到 12 夹 · 1,234 md · 61 MB | **不再是数据损失风险**。但 FLY-2146 plan §7 明写:「看者本身没人看……是 FLY-2134 可消费的心跳面;本单不做元监控」⇒ 看者的台账是本单的登记对象 |

复核中撞到的**同族新实例**(issue 边界说「真实数量只会更多」,验证了):

| 形状 | 实例 | 证据 |
|---|---|---|
| B 假设存在而从未存在 | `~/.flywheel/runner-memory/`(FLY-2147 runner 角色记忆,4 项目 · 194 md · 800K) | 非 git、无远端、无备份;与 #4 修复前完全同形 |
| A 报成功地死 | `daily-standup.sh` 里的 gbrain doc sync | `/tmp/flywheel-standup.log` 连续 10+ 天每天 `WARNING: gbrain doc sync failed (non-fatal)`,standup 本身 `Delivered: true` |
| B(机器级) | Time Machine | `tmutil destinationinfo` → `No destinations configured` |

**一个未被注意的半成品**:`notify-receipts.json`(FLY-929)——Bridge 在 `publish-report --kind token_report --expected-date` 时写回执,但**读回执的 expect tick 被 FLY-1243 退役,从未实现**(`truth.ts:826`)。它本来就是第 1 例的看者,只造了写的一半。

## 2. 两种失效形状与各自修法(issue 原判据,沿用)

```
A 「报成功地死」  机制在、已停;日志/退出码/launchd 状态仍报正常或安静 disabled
   ⇒ 验产出物,不验运行:看【远端/产出物】有没有、多久没变
B 「假设存在而从未存在」  没人建过,所有人以为有
   ⇒ 把假设变断言:先登记「应该有」,让 missing 本身成为一条会响的告警
```

两种形状**一个机制就能同时覆盖**:一张「期望产出物」登记表 + 一个只看产出物年龄的独立观察者。A 由 `stale` 抓,B 由 `missing` 抓。

## 3. 已有可复用之物(仓库实扫,路径可点)

| 已有 | 位置 | 复用为 |
|---|---|---|
| **单机制版「验产出」看者**:远端 head + 本地待送年龄 + 写者 receipt 年龄;条件三态 True/False/None;`enter/renotify(24h)/recover` episode 账;发帖成功才记时;固定表头 TSV 台账 | `scripts/lead-memory/arrival-check.sh:9-14,166,219-236,284-305` | **架构模板**:把它写死的 5 个条件泛化成表驱动 |
| 进程外 probe 骨架:seam 函数 `_probe_curl/_probe_now/_probe_post`、v4 原子状态文件、`BASH_SOURCE==$0` 守卫、永远 exit 0 + stdout 判词、grace + 连续计数滞回 | `scripts/bridge-liveness-probe.sh:56-67,106-120,265-288,353-356` | 文件骨架 + 测试形态(`scripts/__tests__/bridge-liveness-probe.test.sh:28-45`) |
| 直发 Discord:`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` + `${FLYWHEEL_PROBE_BOT_TOKEN_ENV:-CODEX_INFRA_BOT_TOKEN}`,可选 `FLYWHEEL_FOUNDER_DISCORD_USER_ID` | probe `:43-67`;arrival-check `:24-38` | 告警投递(三个 env 名在 `~/.flywheel/.env` 均已存在) |
| 工具函数库:`lm_bounded`(经 `bounded-run.sh`,超时 124)、`lm_remote_head`(ls-remote)、`lm_write_json_atomic`、`lm_append_tsv`、`lm_lock_acquire/release`(mkdir 锁含 pid、死 pid 回收) | `scripts/lead-memory/lib/sync-common.sh:28-97,195-232` | 直接 source(或抽到 `scripts/lib/`,见 research) |
| launchd 单元登记与收敛:5 列 TSV、`copy` 策略字节权威、census 五套 CI 守卫、`docs/operations/launchd-units.md` 交付流程 | `scripts/launchd/units.manifest`;`scripts/lib/converge-nonlead-daemons.sh:61-65,656-693,1003-1055` | 新 launchd 单元的**唯一**登记与安装路径 |
| Bridge liveness 三点合同:builder / validator / probe jq;W-2 的「artifact 时间 + 阈值」公式;validator 只遍历 `REQUIRED_LIVENESS_ROWS`,不拒绝额外 component | `packages/teamlead/src/bridge/liveness-manifest.ts:150-197`;`packages/config/src/feature-flags/truth.ts:1024-1173`;probe `:125-155` | 可选 W-4 lane 的接入点 |
| shell 测试约定:source-and-stub `*.test.sh`,CI 显式枚举(`ci-shell-suite-enumeration.test.sh` 抓漏登) | `scripts/__tests__/`;`.github/workflows/ci.yml:401,1225` | 新 suite 必须同 PR 改 ci.yml |

**缺的**(要建):① 产出物新鲜度登记表(mechanism → artifact → threshold)本身;② sqlite 行龄 / 通用 git 远端漂移两种探针;③ 出进程机制的 lane(W-3 只是静态断言);④ 「看者被谁看」的闭环。**不需要建**:新的 lead-alert kind(直发不走 claims.db,四处枚举不动)、新的 Bridge HTTP 端点、新的告警队列。

## 4. 外部调研(Layer 1,业界共识,零新意即是好事)

- Dead man's switch / heartbeat monitoring:观察者持「期望周期 + 宽限」,任务**不**主动报平安时才响;三层里只有这一层能抓「沉默」型失效(passive logging → exit-code alerting → dead man's switch)。
- 观察者必须在**另一个故障域**(不同进程、最好不同机器):与被观察者同死则形同虚设。本地 launchd 已是「另一进程」;「另一台机器」是 FLY-2146 §7 记录的 founder follow-up,本单不解。
- 简单的 `now - last_success > interval × k` 比复杂系统更有效;把「谁看看者」用 2–3 方互看成环解决。
- Sources:[deadmancheck](https://github.com/Kriss-V/deadmancheck) · [Dead man's switch explained](https://crontap.com/blog/dead-man-switch-explained-for-developers) · [Cron monitoring best practices](https://cronradar.com/comparisons/cron-monitoring-best-practices) · [Monitoring the Monitor (Pratilipi)](https://medium.com/team-pratilipi/monitoring-the-monitor-how-we-solved-silent-pipeline-failures-at-pratilipi-965b72691a6b) · [Stale continuous aggregates](https://mydba.dev/blog/timescaledb-stale-cagg)

## 5. 选项比较

### Option A:在 `units.manifest` 上加两列(`expected_artifact`、`max_age_h`),census 顺带算年龄
- **核心**:一张表管到底,census 已在三个锚点上跑。
- **Pros**:零新单元;登记处唯一。
- **Cons**:① 单元 ≠ 产出物——chezmoi 在 `com.chezmoi.*` 域外、lead-memory 远端观察是 GitHub workflow、runner-memory 根本没有机制却最需要登记(形状 B),这些都进不了 units.manifest;② `_cnd_load_manifest` 是 5 列严格 fail-closed 语法,五套 CI 守卫与 `retire-units.sh` 都读它,加列是横切改动;③ census 只在 restart-services / standup 等锚点上跑,不是每小时,且它运行在 Bridge 部署链里——观察者和被观察者共域。
- **Appetite**:1–2 周,但把「单元表」和「产出物表」两种语义搅在一处,以后每加一行都要争论「这算单元还是产出物」。

### Option B(推荐):独立产出物登记表 + 进程外每小时看者 + 三方互看成环
- **核心**:新表 `scripts/launchd/artifact-freshness.manifest`(TSV,按产出物而非单元登记,可引用 owner label);新脚本 `scripts/artifact-freshness-check.sh` 每小时跑,三种探针(`file_mtime` / `sqlite_max` / `git_remote_head`)算出四态 `fresh | stale | missing | undetermined`;按 arrival-check 的 episode 账直发 Discord;写 `state/artifact-freshness/last-run.json` + `checks.tsv`。Bridge `/health` 加**可选** `w4_artifact_freshness` lane 读 `last-run.json` 年龄;probe 把 W-4 `stale` 折进既有 `degraded` episode;看者反过来登记 probe 的 `state/bridge-liveness-probe.json` 年龄 ⇒ **看者 → probe → Bridge → 看者** 三方成环,任何一方死掉都有另一方响。
- **Pros**:产出物语义纯净,形状 B 天然可登记(目标不存在 ⇒ `missing`);复用 arrival-check 80% 形态;不依赖 Bridge 存活;闭环是结构性的而非「再加一个看者」的无穷回归。
- **Cons**:多一个 launchd 单元(走 FLY-1814 交付流程,plist 改动不会被 converge 自动刷新);Bridge/probe 各改一小处(可选行,旧 probe 不受影响);登记表与 units.manifest 是两张表(各管各的语义,用测试锁「登记表里引用的 owner label 必须在 units.manifest 或 external 名单中」防漂移)。
- **Appetite**:2–3 周含 QA。
- **切掉**:不救任何 aux 单元;不修 chezmoi;不建 runner-memory 远端;不做每日正向摘要;不做第二台机器。

### Option C:全部做进 Bridge(W-4 lane 直接跑登记表探针,不起新进程)
- **核心**:Bridge 每小时在进程内跑探针,/health 暴露,probe 转发。
- **Pros**:不新增 launchd 单元;TypeScript 测试更顺手。
- **Cons**:观察者与最大的被观察者同进程;Bridge 今天自我了断 3 次、上周整机重启;Bridge 死 = 所有产出物检查一起死,只剩 probe 报「Bridge down」,与本单要解的「监控者自己死了没人知道」正面冲突。`ls-remote` / sqlite 读也不该进 Bridge 事件循环(p99 已有 500ms 尖峰)。
- **Appetite**:1–2 周,但违反本单的第一原则。

### 推荐:Option B
理由:① 只有 B 让形状 A、B 用同一个 `verdict` 词表覆盖;② 只有 B 的观察者不与 Bridge 同死;③ 环是有限的三方,不是「再来一个看者」。

## 6. 给 Lead 的判断题(非阻塞,ask `5025382b-f79e-4054-a85d-499abb9591dd`;**2026-09-08 Lead 裁定四条全按推荐**,Q2 附:建 runner-memory 远端的单由 Lead 开)

| # | 问题 | 推荐 | 若相反 |
|---|---|---|---|
| Q1 | token-usage.db 行登记 `active`(立刻响一次 + 24h 重提,直到 D3b 救回或改 `suspended`)还是 `suspended`(只在 `--status` 列出,不响)? | **active**——它就是第 1 例,沉默就是问题 | 改一个字段,行为由测试锁 |
| Q2 | runner-memory 登记为 `git_remote_head` 行、持续报 `missing` 直到有远端,并另开单建远端? | **是**——这是「把假设变断言」的字面演示 | 从 v1 登记表删一行 |
| Q3 | 告警直发 Discord(probe/arrival-check 先例)vs `lead-alert.sh`(claims.db 去重 + Claw duty,但 queue 由 Bridge 排空)? | **直发**,自带 episode 账 | 加 kind 四处枚举 + 接受 Bridge 死时告警随之死 |
| Q4 | W-4 可选 lane + probe 折入 degraded,纳入本单? | **纳入**——它才是标题的答案 | 环缺一边,看者的死只靠人看 `--status` |

## 7. 边界(本单不做、也别当已知)

- 不 enable 任何 disabled 单元(D3b 是 Annie 逐条审批的通道);不修 chezmoi 的推送逻辑;不建 runner-memory 远端;不配 Time Machine。
- 不读任何机制自己的日志或退出码——这是设计约束,不是省事(测试用静态断言锁:脚本不含 `launchctl`、不读 `*.log`、不读 `runs.tsv`)。
- 「远端存在」只能证明到 `ls-remote` 一层;远端内容是否可恢复、是否被人 force-push 覆盖,不在本单。
- 第二台机器 / 异地观察者:仍是 founder follow-up。
- Linear 评论未读(MCP 401);若 issue 上有本文未见的 Lead 裁定,以裁定为准,写 `design-correction.md`。

## 8. 复核命令(只读;`launchctl` 一族按 FLY-913 护栏须落文件再执行)

```bash
stat -f '%Sm' ~/.flywheel/token-usage.db                       # Jun 30 20:28:46 2026
launchctl print-disabled gui/$(id -u) | grep 'com.flywheel'    # 8 个 => disabled
git -C ~/.local/share/chezmoi status -sb                       # ahead 126
git -C ~/.local/share/chezmoi log -1 --format=%ci @{u}         # 2026-03-15
tail -3 ~/.local/share/chezmoi-sync-error.log                  # chezmoi re-add Killed: 9
git -C ~/.claude/agent-memory rev-parse HEAD; git -C ~/.claude/agent-memory ls-remote --heads origin main   # 相等
tail -2 ~/.flywheel/state/lead-memory/arrival/checks.tsv       # verdict fresh
ls ~/.flywheel/runner-memory/.git                               # No such file
grep -c 'gbrain doc sync failed' /tmp/flywheel-standup.log
tmutil destinationinfo                                          # No destinations configured
```

## 9. 下一步

- [x] 4 问已发 Lead(非阻塞)
- [ ] research.md:登记表语法、三种探针的判定规则与边界、W-4 合同细节、测试与 CI 登记点、交付/回滚步骤的仓内证据
- [ ] plan.md → Codex design review
