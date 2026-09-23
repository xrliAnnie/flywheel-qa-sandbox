# PR #1285 / FLY-2776 — code review round 1

**Status: CHANGES REQUESTED**

审查对象：`main...bad98d5fc`（`HEAD`）。阅读了完整 diff、指定的四份设计材料、真实 launcher/test/alert/Bridge 代码。以下行号均绑定到 `HEAD`。审查期间工作树出现 `scripts/__tests__/fly2776-dev-channels-geometry.test.sh` 的未提交改动；本报告不把那份未提交改动算进 PR。

## Findings

1. **BLOCKER — 普通对话中的独立选项行会被当成活确认框。** `packages/teamlead/scripts/claude-lead.sh:1728-1739`。新式样允许无 `❯` 的 `1. I am using this for local development`，正文只需三选一，且不排除同屏的 Claude 输入框。用无 locale 的 C 环境执行当前函数：一块包含本 issue 整段 capture 引用、末尾仍有 Claude 输入框的非模态屏幕返回 `present`；普通编号列表行加一句 `Please use --channels...` 也返回 `present`。P4/P12 都只覆盖“选项在行中”的引用，未覆盖独占一行的转述。冷启恢复这类对话时，poller 会向活 prompt 发 `1`。设计评审的 NIT 6 已登记整块粘贴风险，但它仍在代码中，且本 PR 放宽到只需一条正文后更易触发。**建议：**加入真实 prompt/转述屏幕的负例；在发送前以模态结构或活 prompt 排除条件证明当前是 Select 对话框，同时保留 49×16 真框的正例。

2. **BLOCKER — 更窄的真框既不确认，也不告警。** `packages/teamlead/scripts/claude-lead.sh:1728-1739,1985-1989`。用安装的 Claude 2.1.280 在隔离 tmux **43×16** 实测：选项行折成 `❯ 1. I am using this for local` / `development`，标题滚出视口，`--dangerously-...` 句前半也滚出，仅 `Please use --channels...` 可还原。把该真实 capture 送入 C 环境下的现有判定与漂移条件，结果为 `present=0, match_option_row=0, semantic_hits=1, alert=0`。Lead 会停在框上，90 秒后只记 `NOT_SEEN`，与 `:1663-1664`“窄 pane 不再静默”的保证矛盾。**建议：**保持 <44 列不自动按键的安全边界，但让漂移探测识别“折行选项标签 + 一条正文 + 模态底栏/频道区”这一形状；用该 43×16 真 capture 加告警正例，并验证普通 transcript 不告警。

3. **BLOCKER — 退出码 2 把永久死信误记为已送达。** `packages/teamlead/scripts/claude-lead.sh:1816-1823`。`scripts/lead-alert.sh:1254-1262,1471-1481,1604-1607` 对“已入队”和“dead_lettered”（无频道、无 token、永久 HTTP 4xx）都退出 2；新调用将所有 2 记作 `DRIFT_ALERT_SENT`。例如配置里有 Lead 但 token 不在进程环境，alert 会进入死信、不会由 Bridge 队列投递，startup log 却声称 SENT；相同签名之后直接命中死信回执。这正是告警本身失效时最需要准确日志的路径。A4 只把 fake alert 的退出码设成 2，无法区别两种结果。**建议：**传 `--strict-delivery` 并解析其单行 `sent|duplicate|queued_transient|dead_lettered|config_error` 回执；只把 `sent`/`queued_transient` 视作送达或可投递，死信明确记 UNSENT，并增加两种 rc=2 的测试。

4. **BLOCKER — 同一失败形状在首次告警后被永久静音。** `packages/teamlead/scripts/claude-lead.sh:1810,1822`。固定 `--signature dev-channels-drift-${shape}` 覆盖了 `lead-alert.sh` 默认的每日签名；其 event ID 是 project/lead/kind/signature 的哈希（`scripts/lead-alert.sh:1134-1150`），`sent` 回执以后永远在 `:1249-1252` 直接返回 0。某 Lead 今天因选项行仍在但正文文案漂移而告警、人工恢复后，下个月同一形状再发生，只会重现 `DRIFT_ALERT_SENT` 日志，不会再通知；`alert_claims`/`alert_deliveries` 无按 episode 清除机制。形状签名限制了重启风暴，但不满足“以后再次卡住仍响”的目的。**建议：**签名包含有界时间桶（例如 UTC 日）或可持久识别并重置的故障 episode；保留同桶内去重，测试首次、重复冷启和新桶/新 episode 三种情况。

5. **BLOCKER — F 层原始 tty 前提失败时，新套件无法提供要求的 CI 证据。** `scripts/__tests__/fly2776-dev-channels-geometry.test.sh:149-169,204-218`。fake Claude 的 `stty -icanon ... || true` 吞掉 ioctl 失败，却仍等待无 Enter 的原始字节。本机实际运行新套件：F1 已记录 `matched` 与发送 `1`，但 `keys=[]`，最终 `DEV_CHANNELS_CONFIRM_UNVERIFIED`；整套 **16 passed, 1 failed**。同仓 fly1679 的 E 层在 `:823-834,864-874` 明确区分“raw tty 被宿主拒绝”和任意 harness 故障。CI 安装了 tmux（`.github/workflows/ci.yml:1366-1368`），但脚本并未证明 raw mode 在 CI 可用；G/M 在 CI 无 Claude 二进制时显式 SKIP，F 是唯一预期把关层。**建议：**F 子进程报告 `raw=ok|denied|error`；CI 中非 `ok` 必须红，允许的本地宿主拒绝要显式说明并由其他可运行验证补足，不得被当作 F gate 已执行。加入该前提本身的负控。

6. **NIT — G1/G2 的“到达可收信 prompt”断言并没有检查 prompt。** `scripts/__tests__/fly2776-dev-channels-geometry.test.sh:273-289`。测试只要求日志 `confirmed=1` 且最终画面不再含选项行；Claude 退出、进入其他 modal 或停在 onboarding 时也可满足该断言。当前 G1/G2 在本机通过，但这只证明对话框消失。**建议：**同时断言 pane 进程仍存活和明确的 Claude 接收 prompt 标记，避免把“框消失”表述为“可收信”。

7. **NIT — F3a 仅确认文本变异应用，没有证明该变异被测试抓住。** `scripts/__tests__/fly2776-dev-channels-geometry.test.sh:199-217`。去掉行锚定后只比较源字符串是否不同，未将变异判定式用于独占/行中转述负例；即使变异接受 transcript，F3a 也 PASS。**建议：**运行变异后的判定式对 P12 形状，要求它错误命中，再要求原版拒绝；或删除 F3a 的“变异负控”表述。

## Verification

- `bash -n`、`git diff main...HEAD --check`：通过。
- `fly1679-dev-channels-v2.test.sh`：45 passed、0 failed；该环境明确拒绝 raw tty，因此旧 E 层按其既有三态规则打印 SKIP。
- `fly2776-dev-channels-geometry.test.sh`：16 passed、1 failed（F1）；G1/G2/M1 与 A 层通过，不能据此宣称整套通过。
- `ci-shell-suite-enumeration.test.sh`：通过；新 suite 已登记在 shard 6。
- 无 locale 的 C 环境下，49×16 无边框及带边框折行正例都能匹配；新 `sed` 字面量、ERE 交替、`grep -e` 和 here-string 未发现多字节/`pipefail` 反转。生产 poller 的新 tmux 与 alert 外部调用均在命令替换里；未发现新的 bare-exec、`set -u` 或 `set -e` 致命路径。
