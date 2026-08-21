# FLY-1959 删除老 self-ship 路 — 探索
Issue: FLY-1959 (https://linear.app/geoforge3d/issue/FLY-1959/self-ship净删除-删掉老自-ship-重启路只留定时班车-founder-紧急一张票)
日期: 2026-08-21
基于: 无

## 1. 已定方向

Founder 已明确裁定本单替代取消的 FLY-1934，并且性质是净删除：新 engine land 路 merge 后不应投任何重启票，老的 `self-ship-restart.sh → self-ship-pending.d → QueueDirectories` 链必须整条消失。这里不重新讨论产品方向，只把既定边界翻译成可验证的工程合同。

最终只有两个入口：

1. launchd `StartCalendarInterval` 在本地 `00:00` / `12:00` 发车；当 `deployed-sha != origin/main` 时，拉到最新 `main`，只执行一次全舰部署和一次既有播报。
2. Founder 授权后运行 `scripts/request-restart.sh`；它向 `~/.flywheel/self-ship-urgent.d` 原子投一个 token，再对 updater 做不带 `-k` 的 `launchctl kickstart`。plist 的 `QueueDirectories` 只看 urgent dir，`ThrottleInterval=60`。

`merge` 本身永不再触发即时重启，也不再产生等待下班车的 per-merge marker。

紧急票按 founder 的每次显式调用计意图：同一 updater 开场 snapshot 中的多张票合并成一次 restart；当前票被 claim 之后才发布的新票属于下一次人工意图，允许再 restart，但由 launchd 保证至少间隔 60 秒。不能按 `targetSha == deployed-sha` 去重，因为紧急入口正需要在代码已是最新时仍能强制全舰重启；也不新增跨 invocation receipt/ledger。

## 2. 当前链路

当前 `main@f4d789396` 仍有三层普通 merge 状态：

- `.claude/commands/spin.md` 与 `orchestrator.md` 要求 merge 后运行 `scripts/self-ship-restart.sh`；
- `self-ship-restart.sh` 调 `scripts/lib/self-ship-queue.sh::ssq_enqueue`，写 `self-ship-pending.d` marker，并 kickstart updater；
- `scripts/update-flywheel.sh` 以 marker 为主流程，做 due/backoff/block/ack/report；plist 的 `QueueDirectories` 直接监视 pending dir。

这套链的结构性问题不是“重试策略不够好”，而是 merge 被赋予了不该有的点火权。继续修 marker、收据或隔离仓会保留错误心智模型。

## 3. 方案比较

### A. 净删除普通 marker，保留最小 urgent token（采用）

- 删除 `self-ship-restart.sh`、`lib/self-ship-queue.sh` 与对应测试/打包清单；
- ship 文档在 merge 完成后直接结束，不做部署 handoff；
- updater 只做 schedule drift 检查和 urgent forced restart；
- urgent token 耐久到 updater 成功取得 singleton lock 并 claim 为止。claim 会在 restart 前把本轮合法 token 原子移出 watched dir；随后只尝试一次 restart，失败不自动重试。`ThrottleInterval=60` 只限制多个独立 token / crash 前未完成 claim 的重新拉起，不是 retry ledger。

优点是代码和心智模型都与 founder 裁定一致，且净删除量最大。缺点是失去 per-PR deployment identity；这是有意删除的旧路能力，不应用新台账补回。

### B. 搬用 PR #906 的普通 pending + urgent 双队列（不采用）

它能把普通 marker 从即时触发改成定时消费，但 merge 仍然产 marker，updater 仍保留 ack/backoff/blocked/report 状态机，不满足“老路删净”和仓内 `self-ship-pending` 零活引用。

### C. 只改 plist，不删旧脚本（不采用）

这能暂时止住即时触发，却留下 runner 继续投票、目录继续增长、文档继续教旧入口。它只是禁用，不是净删除，未来仍会出现两套走法。

## 4. 边界与非目标

- 不新增 urgent receipt、attempt ledger、blocked/quarantine 目录或自研 backoff；launchd 只会重新拉起尚未 claim 的票，claim 后失败不自动重试。
- 不改变 `restart-services.sh` 的全舰 restart 实现、既有播报内容或 founder authorization gate。
- 不在 implement 节点 bootout/bootstrap 生产 updater；本节点只交付 repo bytes、测试、切换说明和 PR。
- 历史过程文档可以保留事故叙述中的 `self-ship-pending`，但所有活代码、活规则、运行手册和模板必须改成双入口模型。
- `request-restart.sh` 的成功只代表紧急 token 已持久化且 updater 已被 nudge，不代表 restart 已完成。
- 紧急票是 at-most-once：claim 前 crash 会由 watched dir 重拉；claim 后的正常失败、SIGTERM/INT 由 updater 发一条票据唯一告警，但 SIGKILL、宿主 panic 或断电无法执行 trap，可能无告警地丢失本票。Founder 观察不到完成时需要重新投票；不为填这个缺口恢复 receipt/ledger。
- 告警去重不是永久吞声：urgent failure signature 绑定 token 唯一 basename，同一票只报一次、不同票各自可见；scheduled failure signature 绑定 route + UTC `YYYYMMDD`，持续故障每天仍会提醒一次。

## 5. 验收映射

| 要求 | 可证伪证据 |
| --- | --- |
| 普通 merge 不即时重启 | ship/orchestrator 路径不再调用任何 restart/updater handoff；旧脚本路径不存在 |
| pending 老路删净 | 计划中固定的 `git grep` active-scope 合同为零；queue library、pending tests、plist/provision/R4 引用删除 |
| 班车批量部署一次 | harness 令 `deployed-sha` 落后并断言 deploy command 恰调用一次；追平时零次 |
| Founder 紧急票可用 | request harness 断言 token 先落盘，再 no-`-k` kickstart；updater 校验 token target 已在 `origin/main`，即使无 drift也只 restart一次 |
| 每分钟至多一次 | plist 结构化断言 `ThrottleInterval == 60` 且 `QueueDirectories` 只有 urgent dir |
| 多票语义明确 | 同一开场 snapshot 批量 claim 后只 restart一次；claim 后的新票留到 launchd 下一轮，作为新的 founder intent |
| 探测不确定不热拉 | fetch/git probe 在有界尝试后仍失败时，token claim-once、逐票告警、零 deploy、非零退出；不保留 watched condition，founder按告警决定是否重投 |
| 告警有界且不永久静默 | 同一 urgent basename 重放沿用同一 signature；不同 basename不同；scheduled同 UTC 日相同、跨日不同 |
| 晚到 token 不丢 | updater snapshot/claim A 后注入 B，A 只产生一次 attempt，B 留给下一实例 |
| 空转病不回归 | plist 不再监视旧目录；bootout/bootstrap 真机 24h runs 观测由 QA/ship 窗执行 |
