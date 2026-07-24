# FLY-1182 quota-stuck session 恢复手册 — Annie 三问答卷

Issue: FLY-1182
日期: 2026-07-16
基于: plan.md (Rev 3) / qa-report-phase3.md

---

## Annie Q&A

### 问 1:额度到期怎么 detect?

现在由机器上的外部 `quota-monitor` daemon 同时看两类信号,不是只看终端里的 100% 用量条:

1. **账号级 5h / weekly**:`quota-monitor` 直接用当前 Keychain token 调 OAuth usage API。
   默认每 20 分钟轮询;5h 用量达到 70% 后加速到每 10 分钟。代码默认 5h 在 90% 触发,
   weekly 在 100% 触发,并记录 API 给出的绝对 reset 时间。当前生产止血配置把 5h 阈值
   临时抬到 100%。
2. **模型级额度**:daemon 默认每 60 秒扫一次受管 Claude pane,识别
   `You've reached your <model> limit ... switch models with /model`。结果是
   `capped / clear / unknown` 三态;活跃 spinner、截断或看不清都算 `unknown`,绝不据此
   关闭 runner 或切号。模型 cap 按 `(账号,模型)` 做有界 bench,不会永久废掉整个账号。
3. **身份与候选复核**:观测账号、Keychain token 的真实 OAuth 身份和台账 generation
   必须一致,候选账号还要重新查 usage;有冲突、身份不明、API blind 或所有候选都不可用时
   一律 fail-closed 并告警,不猜、不重新登录。
4. **529 不算 quota**:瞬时 529 / server overloaded 自身不会触发切换;只有同一份证据里另有
   真账号级或模型级 cap 时,真 cap 才继续走切换。

### 问 2:谁执行切换、怎么切?

**机制启用时,唯一执行者是 launchd 常驻的外部 `quota-monitor` daemon
(`com.flywheel.quota-monitor`)。** FLY-1456 已把 cutover 永久固化:旧的
“Codex Bot 认领 20 秒,否则 Bridge watchdog 兜底”整条路径永久退役;Bridge 不执行切换,
认证后的 `/api/account-switch` 固定返回 410。`FLYWHEEL_QUOTA_DAEMON_CUTOVER` 已墓碑化,
不得再设置;没有 Bridge fallback。

**当前生产还没有常开。** 2026-07-16 的止血冻结把
`~/.flywheel/quota-monitor.json` 设为 `trigger5hPct: 100`、`order: []`。daemon 仍会 detect
并在命中时告警,但空候选池使它处于 monitor-only,绝不会改 Keychain。只有冻结 owner 明确
放行、隔离 QA 复验通过并经 Annie GO 后,才能恢复候选 `order`;在那之前不能说“自动切换已生效”。

**2026-07-16 PT 生产池状态增补**:五个槽已按
`business → personal1 → school → shopping → personal` 完成真登录、capture 和
`verify --source pool`;journal 已 commit 到 `awaiting_1252`,store/state generation=4,
final Keychain 独立复验为 `personal` match。这个结果只解除“池污染/身份不一致”前置,
**不等于 enable**:config 仍是 `100/[]`,且没有运行 `promote-enabled`。详细证据见
`evidence/production-pool-rebuild-20260716.md`;下一门仍是 FLY-1252 precheck + Annie
监督 GO/解冻。

解除冻结后的切换事务如下:

1. daemon 把 detection / generation / 受影响 pane 先持久化,重启后也能继续或安全作废旧意图。
2. 在账号锁内做 CAS:只有“仍是刚才观测到的账号 + generation 未变”才允许继续,并按
   quota 类型选候选。5h 选任一已恢复且验证可用的账号;weekly / both 选 weekly reset
   最近的可用账号;模型级跳过同模型仍在 bench 的账号。
3. daemon 调 `flywheel-claude-profile use <target>`。Keychain 变更全程持锁,凭据从 stdin
   传给 `security -i`,不进 argv;第一次写前先保存并证明旧值可恢复,写后立即读回校验。
4. profile 脚本还会把目标 token 实际探测出的 OAuth UUID/email 与该槽的已确认
   identity anchor 比对。任一 freshness、身份、写回或 verify 失败都不 commit;已动过
   Keychain 就恢复 preimage 并再次验证。daemon 只有在 profile 成功后才 CAS commit 台账。
5. 切换、失败和需要人工处理的事件走统一 lead-alert 管线落 `#flywheel-alerts`。原 issue
   提到的 `#flywheel-notify` 黄色 digest 属于旧 Bridge 路径,在 daemon cutover 下不再是
   当前交付;通知路由的后续归一由 FLY-1252 跟踪。GO 卡必须把这个落点变化明示给 Annie。

**真正切完以后,新启动的 Claude 进程会读取新的 Keychain 凭据。** 当前冻结状态没有发生这一步。

### 问 3:卡在 quota 的旧 runner 怎么恢复?

**v1 不会把已经卡住的旧 runner 自动搬到新账号。** 切 Keychain 只影响之后新建的 Claude
进程;旧进程保留自己启动时的认证/运行状态,不能宣称 daemon、Bridge 或 Bot 会把它原地迁移。

支持的恢复方式只有两条:

1. **等原账号 reset**:从 `~/.flywheel/claude-accounts.json` 的
   `quotaExhaustedUntil` / `weeklyResetAt`,或 `#flywheel-alerts` 事件,看准确恢复时间;旧
   runner 到时在原进程继续。
2. **Lead close + redispatch**:如果不能等,由 Lead 关闭卡住的旧 runner,再按同一任务
   redispatch。新 runner 读取已切好的 Keychain,并从 `progress.md` 的 cursor/chunk 状态续跑。

Lead 自己若卡住,可由 operator 重启对应 launchd service,让新进程读取当前 Keychain。
选择题/付费确认 pane 仍由人处理;不要自动按键。恢复失败就停手并升级给 Annie,不要重复
close 或盲目切账号。

---

## Operator Runbook

### Read-only checks

```bash
flywheel-claude-profile status
flywheel-claude-profile list
jq '{generation,activeAccount,accounts}' ~/.flywheel/claude-accounts.json
launchctl print gui/$(id -u)/com.flywheel.quota-monitor
```

这些命令只用于确认当前账号、reset 时间、generation 和 daemon 健康。不要为了“试试看”
直接手工改台账或 Keychain。

### First real switch observation checklist

常开后的**第一次自然切换**不是再做一次人工切号;operator 只观察并保存以下事实。任一身份、
generation 或通知不一致都按失败处理,停止额外写操作并保留现场:

1. `#flywheel-alerts` 出现一条 `account_switched`（正常）或
   `account_switch_degraded`（严重、需人工复核）事件;正文中的 `from→to`、scope、usage、
   `revived/pending/login_expired` 与本次触发一致。daemon cutover 下不要等
   `#flywheel-notify` 旧 digest。
2. `~/.flywheel/claude-accounts.json` 的 `generation` **恰好 +1**、`activeAccount=to`;
   profile `.active`、`~/.claude.json.oauthAccount` 与 Keychain token 的真实 OAuth
   UUID/email 全部指向同一 `to` identity anchor。任何一项不一致都不是成功。
3. `~/.flywheel/quota-monitor-state.json` 不再留本次 `pendingDetection`;账号级切换应打开
   对应 revive epoch,模型级切换还应留下同 generation 的延迟 confirmation。锁、临时文件、
   rebuild journal 均不得卡在写入中间态。
4. 下一个健康 tick 的 PID/start time、runtime tree hash、config hash 与 launchd 当前进程
   一致,且没有 `account_switch_failed` / `machine_account_conflict` / outbox 堵塞。健康 marker
   只能证明 tick 完整,不能替代第 2 项身份断言。
5. 默认约 7 分钟后检查 `quota_switch_confirmation`:逐 pane 记录
   `recovered / still_capped_or_choice / unknown_in_flight / capture_failed /
   pane_disappeared`,并保存 `~/.flywheel/quota-confirmations/` 的完整证据。不要把
   `pane_disappeared` 或 capture failure 算作恢复。
6. v1 边界仍成立:旧 runner 不会被 token 搬家。它若仍卡 quota,只能等原账号 reset,
   或由 Lead close + redispatch;观察期不得为了制造“recovered”数字自动关闭它。
7. 候选选择要与触发一致:weekly / both 选可用候选里 weekly reset 最近者;5h 选已恢复且
   freshness/identity 验证通过的候选;模型级跳过同模型 bench 中的账号。纯 529 必须保持
   generation 不变、零切换。

### Recovery decision

```text
旧 runner 卡在 quota
  ├─ 可以等 → 查 quotaExhaustedUntil / weeklyResetAt → 等精确 reset
  └─ 不能等 → Lead close 旧 runner → redispatch 同一任务 → 从 progress.md 续跑

旧 Lead 卡住
  └─ operator 重启 com.flywheel.lead.<project>-<leadId> → 新进程读当前 Keychain
```

Lead service 的手动重启命令:

```bash
launchctl kickstart -k gui/$(id -u)/com.flywheel.lead.<project>-<leadId>
```

`flywheel-claude-profile use <name>` 是写操作,不是普通恢复命令。它只应由受控切换事务或
明确的人工事故流程执行;单独运行可能让 profile 标记、账号台账和 generation 不一致。

### Retired paths

以下是 FLY-1456 后永久退役的历史架构,不要使用或写进 GO 卡。退役不再由 env 控制,
`FLYWHEEL_QUOTA_DAEMON_CUTOVER` 已墓碑化且不得设置:

- Codex Infra Bot claim `/api/account-switch`;
- 20 秒 claim window + Bridge watchdog fallback;
- `/api/rescue` 自动 close + successor;
- `#flywheel-notify` 的旧 Bridge digest 作为当前切换成功证据。

当前证据源是 daemon durable state / account store、`#flywheel-alerts` 事件和新进程的真实
OAuth identity 验证。
