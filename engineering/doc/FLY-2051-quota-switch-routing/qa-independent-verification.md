# FLY-2051 切号通知按 kind 路由 — 独立 QA 验证报告
Issue: FLY-2051 (https://linear.app/geoforge3d/issue/FLY-2051/quota-monitor路由-claude-切号通知改发-flywheel-notification切号家族-per-kind)
日期: 2026-08-25
基于: plan.md · qa-evidence.md(实现者自测,本文档不复用其结论)

**结论: PASS**

验证 head: `77bbdd4fa50e2593260018070161039cc5226846`
(`git ls-remote origin flywheel-FLY-2051` 与本地 HEAD 逐字一致,PR #956,`isDraft=false`,`mergeable=MERGEABLE`)

本报告只记录**我自己跑出来的**证据。实现者的 `qa-evidence.md` 里的六轮文案迭代结论一律未被
当作已验证事实复用 —— 我重新发消息、重新回读、重新目检渲染。

---

## 1. 产品判据(谁在用、流程对不对)

founder 的原话是「不要发在 flywheel alert,因为我基本上不看那个 channel,你可以发在
flywheel notification」。所以「对」的定义有三条,缺一不可:

1. 切号消息**确实出现在** `#flywheel-notification`,并且 @ 到她;
2. 切号消息**确实不再出现在** `#flywheel-alerts`(不是"两边都发一份");
3. **其余告警一条都没跟着搬家** —— 否则就是把整个告警流搬走了,超出她的意思。

第 2 条是实现者 harness 的盲区:它按 marker 在两个频道各找**第一条**匹配,而
control 比 switch 后发、Discord 返回按新到旧排,所以「切号消息同时也投进了 alerts」
这个失败形态会被静默吞掉。我的 harness 改成**按频道数消息条数**,把这个洞堵上。

---

## 2. 真实 Discord 端到端(我自己发、自己回读、自己目检)

harness: 自写(不是复用 `discord-qa.mjs`),从**本 head 编译出的 dist** 直接调
`sendQuotaMonitorAlert`,经真实 `scripts/lead-alert.sh` + 生产 alert bot token 投递,
隔离 `FLYWHEEL_CLAIMS_DB` / `FLYWHEEL_ALERT_QUEUE_DIR` / `FLYWHEEL_ALERT_DEADLETTER_DIR`
到 scratch 目录,未触碰生产 durability state。

marker: `FLY-2051-QAv2-1787709580779` / `FLY-2051-QAv2c-1787709774069`

| # | kind | 期望落点 | 实测 | 证据 |
|---|---|---|---|---|
| 1 | `account_switched` | #flywheel-notification | ✅ sent | [消息](https://discord.com/channels/1485787271192907816/1521630422918758472/1541990489664917614) |
| 2 | `account_switch_degraded` (severe) | #flywheel-notification | ✅ sent | [消息](https://discord.com/channels/1485787271192907816/1521630422918758472/1541990492944732280) |
| 3 | `quota_switch_confirmation` | #flywheel-notification | ✅ sent | [消息](https://discord.com/channels/1485787271192907816/1521630422918758472/1541991300839247872) |
| 4 | `quota_no_target`(阴性对照) | #flywheel-alerts | ✅ sent | [消息](https://discord.com/channels/1485787271192907816/1518793447165661254/1541990496136859768) |

Discord API 终点回读断言(全部通过):

- **计数**:marker 消息在 notification 恰好 2 条、在 alerts 恰好 1 条 ⇒ **无双投、无漏投、无串频道**。
  `quota_switch_confirmation` 单跑一轮同样是 notification 1 条 / alerts 0 条。
- 切号消息含 `<@$FLYWHEEL_FOUNDER_USER_ID>`(founder mention 保留)。
- 切号消息**不含** `🎫` / `首见` / `状态 NEW` / `(quota-monitor / account_switch…)` ⇒ alert-box 与工单框全部剥掉。
- 切号消息**不含** `from5h=` / `to5h=` / `revived=` / `pending=` / `login_expired=` ⇒ 旧机器字段已清。
- 切号消息含两个 live identity-anchor email(从 `~/.flywheel/claude-profiles` 真锚点读出,不是 QA 假邮箱)。
- 每条切号消息恰好两个 ```text 块、每块 4 行、全部 printable ASCII、
  used/left/reset 三列在 raw index 8/15/22 处均非空格、**最长行 37 字符**。
- 阴性对照消息仍带 `🎫 flywheel · 首见 18:59 PDT · owner — · 状态 NEW` ⇒ 非切号 kind 的工单框**没有**被 `--plain-message` 波及。
- `quota_switch_confirmation` 按既有策略 `mention: false`,回读确认正文无 `<@`(未新增 ping)。

### Lead 硬门回灌逐条复核(`gate-recheck.mjs`,只读回读同一批真机消息)

Lead 在我跑完首轮后回灌了本单特有的硬门。我按条重核,**全部 PASS**,没有一条是引用别人的结论:

| 硬门 | 判据 | 实测 |
|---|---|---|
| ①-a 切号家族发 notification | notification 命中 3 条(switched / degraded / confirmation) | ✅ 3 |
| ①-a 阴性对照真验 | alerts 命中 1 条且是 `quota_no_target` | ✅ 1 |
| ①-b 真邮箱 | 两个 live identity-anchor email 逐字出现 | ✅ |
| ①-c 定宽 ASCII 列位 8/15/22 | **双口径**:raw index 与 wcwidth 在 4 张表 × 4 行 × 3 列上全部等于 8/15/22,且该位非空格 | ✅ |
| ①-d reset 格式 | 每个数据行 reset 段匹配 `^(0[1-9]\|1[0-2])-(0[1-9]\|[12]\d\|3[01]) (Mon\|Tue\|…\|Sun) ([01]\d\|2[0-3]):[0-5]\d$`,且不含 `\b(19\|20)\d{2}\b` | ✅ 无年份 |
| ①-d 行宽 ≤37 | raw 与 wcwidth 两个口径的最长行都 = **37** | ✅ |
| ①-e revive 叙述整段不存在 | 9 个禁词零命中:`切号时` `继续指令` `仍在等待` `已恢复` `revived=` `pending=` `login_expired=` `from5h=` `to5h=` | ✅ |
| ② 程序化列位 + 真机渲染 | 上面的双口径断言是程序化的;另有 founder 登录态下两个频道的真实渲染截图 | ✅ 两样都有 |
| ③ revive 操作面调用保留 | 见 §4「revive 只删叙述不删功能」 | ✅ |
| ④ 生效时点 | 见 §6,已核 launchd 定时 | ✅ |

`tableCount=4 · maxRawChars=37 · maxWcwidth=37 · notifyCount=3 · alertsCount=1 · fails=[]`

### 阳性对照(证明路由真的依赖那个环境变量)

同一进程内 `delete process.env.FLYWHEEL_NOTIFY_CHANNEL` 后再发一条 `account_switched`:
返回 `config_error`,**没有**投递到任何频道。这条排除了「其实是别的原因让它进了 notification」。

### founder 视角真机目检(Claude-in-Chrome,founder 本人登录态)

- `list_connected_browsers` = 1(preflight 通过),自建干净 tab,读完即关。
- `#flywheel-notification`:@Annie 高亮、`Claude 已自动切号: shopping → school` 粗体、
  原/新账号 email、两张等宽配额表(5h/7d/Fable × used/left/reset)全部对齐可读;
  degraded 那条额外显示「配额读数不完整,已按备用顺序完成切换。」
- `#flywheel-alerts`:我的阴性对照渲染成原样工单卡片(红色左边框 + 🎫 行),与它旁边
  两条历史 alert 形态一致 ⇒ 告警区没有视觉漂移。

---

## 3. 自动化门禁(我自己跑的,不是引用的)

| 项 | 结果 |
|---|---|
| focused 7 文件(quota-monitor / quota-confirmation / quota-monitor-alert / -alert-contract / LeadAlertNotifier / quota-usage-api / quota-monitor-credentials) | **207 passed / 7 files** |
| teamlead 全包本地 vitest | **未跑完** —— 两次都在 worker pool 里 SIGSEGV(exit 139)。见 §5.5 |
| `scripts/__tests__/lead-alert-strict-delivery.test.sh` | **26 passed, 0 failed** |
| `scripts/__tests__/quota-monitor-wrapper.test.sh` | **6/6**(见 §5 环境说明) |
| `pnpm -r build` | PASS |

### 突变检验(证明这些测试不是空过绿)

每个突变都事先声明该让**哪一项**变红,实测三项全部变红,随后 `git checkout --` 复原,
`git status --porcelain` 为空:

| 突变 | 声明该红的判据 | 实测 |
|---|---|---|
| M1 把 `account_switched` 的 `primaryChannel:"notify"` 去掉 | `quota-monitor-alert.test.ts` | ✅ 2 failed / 31 passed |
| M2 drain 时忽略 `deliveryChannelId`,一律用 unified 频道 | `LeadAlertNotifier.test.ts` | ✅ 1 failed / 63 passed |
| M3 去掉 `lead-alert.sh` 里 `--plain-message` 的 kind 白名单 | `quota-monitor-alert-contract.test.ts` | ✅ 1 failed / 14 passed |

M2 是我特别关心的那条:它覆盖的是**排队重投**路径 —— Discord 暂时不可用时消息落盘,
由 Bridge 的 `LeadAlertNotifier` 事后 drain。如果那条路径不认 `deliveryChannelId`,
切号消息就会在故障恢复后重新掉回 `#flywheel-alerts`。突变证明该断言真的守着这件事。

---

## 4. 代码审读要点(我核过、founder 可能关心的)

- **路由改在 kind 表里,不改全局频道**:`ROUTING` 只给三个切号 kind 加
  `primaryChannel:"notify"`;其余 12 个 kind 一行未动。频道值来自 `FLYWHEEL_NOTIFY_CHANNEL`,
  没有硬编码 snowflake(`.env` 第 114 行已有该变量)。
- **覆盖是子进程级的**:`{...process.env, FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: notifyChannel}`
  只传给这一次 `lead-alert.sh` 调用,不改本进程全局。
- **`--plain-message` 是窄能力不是通用后门**:shell 侧 `is_quota_switch_kind` 白名单拒绝
  其他 kind(`config_error` + exit 1);TS 侧 `LeadAlertNotifier` 对非白名单 kind 的
  `deliveryStyle:"plain"` 直接 dead-letter,不是降级投递。
- **排队路径的频道是被校验的**:drain 时 `deliveryChannelId` 必须匹配 `^\d{17,20}$`,
  否则 dead-letter;不会因为一个脏值就投到随机频道。
- **severe 镜像不会把切号漏回 alerts**:生产 `FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID` 未设置
  (实测 `~/.flywheel/.env` 无此键),且代码显式跳过 `severeChannel === unifiedChannel`
  与 `severeChannel === notifyChannel`。我的 #2 用例(severe 的 degraded)实测 alerts 侧 0 条。
- **revive 只删叙述不删功能(Lead 硬门 ③)**:`processLocalSnapshot()` 的调用点在本分支与
  `origin/main` **数量与位置完全一致**(5 处;其中 `const revived = await processLocalSnapshot();`
  仍紧挨在 `deps.alert({...})` 之前执行)。改的只是 `formatAccountSwitchNotification()` 不再把
  `revive` 渲染进正文 —— 该字段仍作为入参传入。所以 pane revive 在发通知前照旧真的跑,
  founder 只是不再在正文里看到它的状态。
  **顺带一个 nit(不阻塞)**:`AccountSwitchNotificationInput` 的 `revive` 与 `nowMs` 现在是
  未被使用的入参,`formatAccountSwitchNotification` 内没有读它们。留着不影响正确性,
  但下一个改这段的人容易误以为它们参与渲染。
- **表格行宽没有单测上限(nit,不阻塞)**:`quota-monitor.test.ts` 精确断言了列位 8/15/22
  与 wcwidth,但**没有**断言「最长行 ≤37」。因此将来若把 reset 格式改长,列位断言仍会全绿,
  只有手机折行会退化。建议补一条 `expect(maxLineLength).toBeLessThanOrEqual(37)`。
- **fail-loud 而不是静默丢**:`FLYWHEEL_NOTIFY_CHANNEL` 为空时 wrapper 在 exec 前就发
  `quota_monitor_down` 严重告警并拒绝启动 —— 不会出现「切号成功了但通知悄悄没了」。
  代价是切号监控本身也不启动,这是有意的 fail-closed 取舍,已在告警里可见。

---

## 5. 诚实边界(没测的、以及为什么)

1. **`quota-monitor-wrapper.test.sh` 在本 runner 会话首跑 5/6**。失败项 "environment precedence"。
   根因**不是本 PR**:该测试用 `HOME` 沙箱,而 wrapper 的 `ENV_FILE` 解析是
   `${FLYWHEEL_QUOTA_ENV_FILE:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/.env}` —— 本会话环境里
   `FLYWHEEL_STATE_DIR=/Users/xiaorongli/.flywheel` 被导出,直接绕过 `HOME` 沙箱去读了生产 `.env`。
   `unset FLYWHEEL_STATE_DIR` 后同一份测试 **6/6 PASS**;`git diff origin/main...HEAD` 显示
   该 `ENV_FILE` 行本 PR 未改动 ⇒ 属既有的测试隔离缺口,不构成本次 ship 的阻塞。
   **风险**:任何在导出了 `FLYWHEEL_STATE_DIR` 的环境里跑这条测试的人都会看到假红。
   **建议**:另开一张单给该测试加 `FLYWHEEL_QUOTA_ENV_FILE` 显式钉定,不在本 PR 扩范围。
2. **430px 手机视口的真机截图没拿到**。`resize_window` 报成功但截图仍是 900px 视口,
   两次尝试后我停手没继续钻(避免在浏览器工具上打转)。
   **代偿**:改用实测而非目测 —— 表格内容是定长 ASCII,回读断言逐行核过**最长 37 字符**
   (≤ 430px code block 的约 40 字符预算),桌面 900px 渲染已真机目检。
   **风险**:低。手机上若仍换行,坏的只是排版不是内容或路由。
   **补测时机**:下次有可用移动视口时顺手补;不阻塞。
3. **排队→drain 的重投没跑真机**。需要起一个隔离 Bridge 才能真跑。
   **代偿**:该路径由 `LeadAlertNotifier.test.ts` 覆盖,且我用突变 M2 证明了该断言非空过绿。
   **风险**:中低 —— 只有在「Discord 投递失败 + 事后 drain」这条二级路径上才生效。
4. **没有 529 N-to-N 房**。本改动的 Discord 面是 `quota-monitor → lead-alert.sh → Discord`,
   不是 Bridge/Lead/Runner 的 N-to-N 拓扑;而且 529 房用的是**测试 bot + 隔离频道**,
   恰恰**验不了**「是否真的落进生产的 `#flywheel-notification`」这个唯一要点。
   所以我用了更强的做法:**从候选 head 编译的产物,经真实 bot,投进真实的那两个频道,再回读**。
   这不是跳过 529,是选了对这个 surface 更有证明力的路径 —— 并在此明确写出。
5. **teamlead 全包本地跑:先更正一条我写错的结论,再给最终数字。**
   我第一次的全包运行把命令写成 `vitest ... 2>&1 | tail -40`,读到的 `exit 0` 其实是
   **`tail` 的退出码**,不是 vitest 的。改成直接重定向到文件后,`--pool=threads` 两次都
   **SIGSEGV(exit 139)** 跑不完。换 `--pool=forks --maxForks=3` 跑完了:
   **720/727 files pass,9548 passed / 39 failed / 17 skipped**。
   7 个失败文件**没有一个**碰 quota / alert / LeadAlertNotifier,且根因是**同一个**、来自我这个 runner 会话的环境:
   `TMPDIR=/Users/xiaorongli/.flywheel/runner-state/<exec>/browser-tmp` —— 落在 `~/.flywheel` 里面。
   于是 `codex-lead-runtime`(22 条)被它自己的护栏拒掉(报错逐字:workspace「must not overlap ~/.flywheel」),
   `CodexLeadInboxSocket`(8 条)撞 unix socket 路径,其余 `fly247-bash-suites` /
   `workflow-docs-git.integration` / `fly1674-opus46-real-tmux` / `tmux-environment-scrub` /
   `lead-delivery-adapter` 全是真 tmux / 真 git 类。
   **独立佐证**:同一个 head 在 PR #956 的 CI 上,`Unit (teamlead 1 of 3 / 2 of 3 / 3 of 3)`
   与 `Unit (heavy)`、`Quick Gate`、`Unit (light)` 全部 **pass** —— 干净 runner 上没有这 39 条。
   所以我判定:这 39 条是我本机环境造成的,不是本 PR 的回归。
6. **文案本身不是我在裁**。六轮文案迭代是 founder 与 Lead 之间定的(narrow-width gate 已 PASS);
   我验的是「最终文案在真实渲染下确实是那个样子、且字段来自真数据」,不是「这个文案是不是最好的」。

---

## 6. 生效时点

`quota-monitor` 是常驻 launchd 进程(`com.flywheel.quota-monitor`,`KeepAlive=true`)。
merge 本身不部署也不重启;代码与 `.env` 路由要**随下一班 `00:00/12:00` updater 重启**后才生效。
未申请紧急 restart。我实测确认 wrapper 会 `set -a; source ~/.flywheel/.env`,
因此重启后 `FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472` 会正常进入 daemon 环境。
