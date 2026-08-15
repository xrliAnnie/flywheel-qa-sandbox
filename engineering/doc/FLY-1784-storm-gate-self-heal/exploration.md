# FLY-1784 restart-storm gate 自锁无自愈 — 探索

Issue: FLY-1784 (https://linear.app/geoforge3d/issue/FLY-1784/infra复盘-restart-storm-gate-自锁无自愈-bridge-plist-keepalive-30s-使60s-内-3)
日期: 2026-08-15
基于: 无(本文件夹首篇;上游材料 = `~/.flywheel/incidents/2026-08-14-restart-loop.md` + issue 正文)

---

## 1. 任务重述

2026-08-14 深夜 `launchctl submit` 连环重启风暴触发 FLY-1501 restart-storm gate,Bridge 被闸 held 约 20 分钟,期间没有任何自动恢复路径,最终靠 Annie 手动按 runbook `restart-storm-gate.py resume bridge` 才恢复。本 issue 要求复盘 gate 的自锁形态并给出 design:

1. gate 区分「真实启动风暴」与「KeepAlive 探测重拉」;
2. held 后带稳定窗自愈(自动 resume + 告警留痕);
3. gate held 即时告警;
4. (Annie §5.3 候选)held 期间 refused 启动不计窗;告警文案带 resume 命令。

Lead 给出的性价比预排序:告警带 resume 命令(最小)> refused 不计窗(拆自锁)> 稳定窗自动 resume(自动放闸有风险,谨慎定)。

## 2. ★ 审计发现:issue 的假设与现行代码/铁证不符(必须先修正事实)

按「Worker 先审计 codebase」纪律,先对 `scripts/restart-storm-gate.py`(gate 本体)、`scripts/flywheel-bridge-wrapper.sh`(调用方)、生产 plist、当晚的 ledger / claims.db / meta-alert marker 做了逐条取证。结论:**issue 列的 4 个交付方向里,有 2.5 个已经是现状**,真正的结构性缺陷只剩一个。

### 2.1 假设 vs 事实对照表

| # | Issue / 事故报告的假设 | 审计事实([生产现状],均有铁证) |
|---|---|---|
| 1 | 「60 秒内 3 次」阈值 | 生产 `~/.flywheel/.env` **没有** `FLYWHEEL_RESTART_STORM_*` 覆盖 → 生效的是 gate 默认值 **600 秒窗口 / >5 次**(`restart-storm-gate.py:700-702`)。meta-alert marker 原文 "crashed **6** times" 与之吻合 |
| 2 | KeepAlive 30 秒重拉让窗口恒成立 → held 永远解不开 | held 状态下 `_gate()` **短路返回 EXIT_HELD,根本不写 ledger**(`restart-storm-gate.py:710-719`)——refused 启动本来就不计窗。铁证:ledger `bridge.jsonl` 在 hold(seq 170, 06:44:32Z)之后到 resume(seq 171, 06:55:41Z)之间**零新事件**,而这 11 分钟里 wrapper 每 30 秒被拉起一次(wrapper log 每 30 秒一条 held)。自锁的真因更简单:**held 是终态,除人工 `resume` 外没有任何出口** |
| 3 | 「gate 转 held 于 23:35:21」 | 23:35:21(06:35:21Z)是 **episode 窗口起点**(第 1 次启动 seq 165 的时间戳);真正转 held 是 **23:44:32**(seq 170 = 第 6 次启动,>5 触发)。23:35–23:44 之间 Bridge 反复被重启风暴本身杀掉/拉起(gate 一直放行),23:44 之后才是 gate 闸死 |
| 4 | 「held 20 分钟零告警」 | **告警在 hold 后 1 秒内投递成功**:claims.db `restart_storm_hold` 行 `state=sent, attempt_count=1, 06:44:33Z`;meta-alert 桌面+本地文件双通道也在 06:44:32Z 写成。它落在 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`(#flywheel-alerts 统一告警频道)——**投递没坏,是没人看到/没被处置**(视觉可见性问题,不是投递问题) |
| 5 | 告警文案缺 resume 配方 | 文案**已经带命令**:"Inspect the service, then run `restart-storm-gate.py resume bridge`"(`restart-storm-gate.py:586-591`)。可改进点只剩:相对路径→绝对路径一行可复制、缺「预计何时自动恢复」信息 |

### 2.2 修正后的问题本质

**唯一的结构性缺陷:gate 的 held 是 fail-closed 终态,无收敛出口。**

- 拦风暴是对的(600s/>5 那晚确实该拦);
- 告警发了、文案带配方,但落在深夜没人看的 alerts 频道 → 20 分钟 down 靠 runner 的 ask 才被注意;
- held 之后风暴源头已拆(launchd job 已 remove、真实启动请求归零),gate 无法感知「风暴已停」——**不是因为它把 KeepAlive 重拉计为风暴(它没有),而是因为它压根没有任何「重新看一眼」的机制**。

### 2.3 关键洞察:不需要区分「风暴」与「探测」

issue 方向 1(区分真实风暴 vs KeepAlive 探测)在 launchd 语义下不可行也不必要:

- **不可行**:launchd 不告诉 wrapper 这次拉起是 KeepAlive 例行重拉还是 bootstrap/kickstart;wrapper 视角两者完全同形。
- **不必要**:对 Bridge 这类常驻进程,**启动成功本身就是「风暴已停」的检测器**——放行一次,进程活下来 → launchd 不再拉起,窗口自然干净;进程又死 → KeepAlive 30 秒节奏下最多 ~3 分钟内(6 次)再次触发 held。一次探测的代价被 gate 自己的窗口机制天然封顶。

这正是断路器(circuit breaker)的经典 **half-open(半开)** 状态:closed(放行)→ open(held)→ 冷却后 half-open(放一次探测)→ 成功回 closed / 失败回 open 并加大冷却。现行 gate 是一台**没有 half-open 的断路器**,这就是全部病灶。

## 3. 方案选项

### 方案 A(推荐):gate 内建 half-open 自愈 + 指数退避 + 全程告警留痕

held 后冷却 N 分钟自动 resume 一次(= 放一次探测):

- 探测成功(进程活过稳定窗)→ 退避梯子归零,回正常;
- 探测失败(再次 held)→ 下次冷却时间翻倍(5→10→20→40→60 分钟,封顶 60,**永不进入无出口终态**);
- 每次 hold、每次自动 resume 都发告警留痕(沿用现有 lead-alert 通道 + claims 去重);
- 人工 `resume` / `arm-controlled-wave` 永远优先,且会重置退避梯子。

实现位置:`restart-storm-gate.py` 自身。**零新 daemon、零新 timer**——KeepAlive 每 30 秒拉 wrapper → wrapper 调 gate,这就是现成的评估 tick;gate 只需在 held 分支里看一眼「距 hold 时刻是否已过冷却期」。

- 优点:根治「fail-closed 无收敛出口」;最坏情况(真·永久 crash-loop)代价被封顶为每小时 ≤6 次启动尝试 + ~1 条告警/小时(持续 crash-loop 本来就该持续有人被 nag);风暴期间探测被 gate 窗口自然再拦。
- 风险:「自动放闸」——用指数退避 + 封顶 + 每次留痕缓解;首次探测延迟 5 分钟,比人工快(那晚人工花了 20 分钟)但不鲁莽。
- 复杂度:中。新增一个 sidecar 状态文件(退避梯子记忆),**不改 `.state` 文件 shape**(shape 有严格校验,改了会造成回滚炸弹——旧代码读到新 shape 直接 EXIT_INVALID → 永不启动;详见 research)。

### 方案 B(搭车小改):hold 告警文案增强

- resume 命令给绝对路径一行可复制(`python3 ~/Dev/flywheel/scripts/restart-storm-gate.py resume bridge`);
- 文案加「将于 HH:MM 自动重试(第 k 次,下次退避 N 分钟)」——让读者知道系统会自救,也知道等不及可以手动;
- 可选:severe hold 告警支持 `--mention-user` ping founder(lead-alert.sh 已有该参数)。

单独做 B 而不做 A = 只是把 runbook 抄进告警,20 分钟 down 的结构性问题原样保留(那晚告警本来就带了命令、也 sent 了,还是 down 了 20 分钟)。B 应作为 A 的附属交付而非替代。

### 方案 C(已是现状,0 工作量):held 期间 refused 不计窗

审计确认现行代码已如此(§2.1 #2)。交付物 = 在复盘/设计文档里写清事实修正,不改代码。

### 被拒绝的备选

| 备选 | 拒绝理由 |
|---|---|
| wrapper/plist 侧退避(held 时拉长 ThrottleInterval) | launchd 不支持动态 throttle;改 plist + reload 本身就是一次危险的服务面变更,还拖慢正常 crash 恢复。gate 侧退避零成本达到同效 |
| 区分真实启动请求 vs KeepAlive 探测(方向 1 原文) | launchd 不提供拉起原因;且 §2.3 论证了不必要 |
| 交给 #flywheel-alerts 的 claw autofix bot 跑 resume runbook | 依赖 Discord + bot 进程在线,而 Bridge down 场景正是这些依赖最不可靠的时刻;gate 是全系统最底层的 stdlib-only 兜底,自愈逻辑必须同层。claw 作为纵深(看到 hold 告警后人肉/半自动处置)不冲突,但不是主修 |
| held 状态 TTL 直接过期(无梯子) | 无退避的自动放闸在真·crash-loop 下会以固定周期永远撞墙,告警噪音和启动churn 都比梯子差;梯子只多一个 sidecar 文件的复杂度 |

## 4. 关键设计决策(带倾向,供 review 定夺)

1. **机制对所有 child 生效还是 bridge 专属?** 倾向:**统一生效**(bridge / cmux-watcher / quota-monitor / lead.* 都是 KeepAlive 监管、同构自锁)。gate 代码本就不按 child 分支,人为加 allowlist 反而增加复杂度。lead.* 的 controlled-wave 机制与此正交(它管「预期内重启不计窗」,本方案管「held 后如何出来」)。
2. **要不要 disable 开关?** 倾向:**不加**。Annie 有「不加新 flag」倾向 + 本机制就是在治「fail-closed 无出口」这个病,留一个把病态行为再打开的开关与治病目标矛盾。退避参数(base/cap)按 gate 现有 env 风格给两个可调 knob 即可。
3. **退避梯子封顶后要不要转「人工专属」终态?** 倾向:**不转,封顶 60 分钟永远探测**。终态 = 在更高层面复刻同一个病(fail-closed 无出口);封顶后的代价(每小时 ≤6 次启动尝试)完全可承受,且系统永远不可能被 gate 永久闸死。
4. **告警节奏**:每次 hold 一条(episode 天然去重)+ 每次自动 resume 一条;真·持续 crash-loop 稳态 ≈ 2 条/小时,是 feature 不是 bug(该被 nag)。

## 5. 诚实边界

- 本设计**不解决**「重启风暴本身」(那是雷 1,FLY-1671 request-restart.sh 正路 + FLY-913 护栏补 submit 模式,事故报告 §5.1/5.2,另单);
- **不解决** hold 之前 Bridge 已被风暴反复杀掉的那 9 分钟(23:35–23:44)——那段时间 gate 一直在放行,down 是风暴自身造成的;
- **不改** 600s/>5 阈值本身(那晚阈值工作正确);
- **不碰** plist / wrapper / launchd 配置;
- 告警「被看到」的最后一公里(深夜谁盯 #flywheel-alerts)只能缓解(mention + 文案),不在 gate 层根治。
