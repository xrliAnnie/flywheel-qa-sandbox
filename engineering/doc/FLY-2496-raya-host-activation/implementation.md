# FLY-2496 Raya 宿主激活 — 实现记录
Issue: FLY-2496 (https://linear.app/geoforge3d/issue/FLY-2496/raya宿主激活-生产-raya-卡在旧壳-0f77e977班车判-host-capability-absent缺)
日期: 2026-09-13
基于: plan.md

A–F 的实现已完成；最终全仓验证、评审与 PR 仍待完成。没有执行生产 register、install、restart 或 deploy。

## B：班车前置准备与割接

迁移 P2 先核账本授权和旧 owner，fetch 并比对精确目标，在隔离 worktree 构建并冻结有限导出。探针与 quiet15m 通过后才 ff；ff 后重验 checkout、导出、两仓绑定、persona、旧 owner 和静默窗口。导出文件与目录 fsync 后，才允许 quiesce。任何已有版本目录必须与准备好的导出完全一致，避免停机后才发现晋升冲突。

一旦有 stop intent，恢复只验证冻结的候选、继续未完成的 quiesce 并晋升；不重新 fetch、ff、构建或发送 prestop 探针。P3 经持锁 CLI 发幂等探针、计算连续 cursor 边界，再调用真实 seed 工具；未决窗口进入 awaiting_reconciliation，无 severe 告警。prestop 失败保留旧服务，记录重试标记；ff 前失败也保留主 checkout。

`quiet-check`、`prestop-probe`、`cutover-probe`、`seed-boundary` 使用同一部署锁。班车委托锁要求 CLI 父 PID 与磁盘 PID/start 三者匹配，不重新获取或释放父锁。历史最多回看 500 条；页数不足以证明边界时拒绝生成 seed。

## C：账本与恢复命令

`raya-migration-manifest.js init` 支持计划中的 target/auth-message/auth-channel/probe-token-env 参数、`--dry-run` 与 `--resume-from-failed`。dry-run 核验读取与 nudge，不发 Discord 探针、不写账本。首次标准 stateDir 可以尚不存在；初始化只记录公共 launcher 解出的 cursor 路径，不提前创建运行时目录。

`precheck.intent` 在 POST 前以 0600、fsync、rename 落盘。丢失响应后按 nonce 从 intent 时间减 60 秒向前分页恢复；恢复不自动重发。只留下该 intent 的目录可以继续初始化；已存在 manifest 必须显式 resume，且 P2 中任何旧 owner 有 stop intent/receipt 都拒绝重置。

人工恢复只追加带时间、依据和 `by: flywheel-eng-lead` 的记录：

- `resolve --message-id <id> --as confirmed_processed|confirmed_unprocessed|side_effect_reconciled --evidence <text>`：只处理 stop-window，拒绝 unprocessed 后出现 processed，既有处置不可改写。
- `resolve --as lookback_confirmed --boundary-message-id <id> --evidence <text>`：REST 验证边界早于探针，只处理 lookback_exhausted；不会清除人类消息未决项。
- `resolve --as probe_message-id <id> --evidence <text>`：REST 验证频道、bot、完整 nonce 内容后记录找到的探针。
- `resolve --as probe_not_delivered --evidence <text>`：追加 nonce 的显式重试授权；不直接删除 intent，班车后续据此收敛。
- `resolve-quiet-window --message-id <id> --as confirmed_processed|confirmed_unprocessed --evidence <text>`：独立的 Lead 裁定入口。未处理的 quiet-window 消息会把最终 cursor 边界压回其之前。

最后一项依据 Lead 问题 `6c85dcab-2a63-40c9-95f8-dab50143d92f` 的当前裁定：quiet-window-violated 保持 unresolved，除非 Lead 逐条显式处置并署名；禁止 lookback_confirmed 静默清除，禁止 B0 越过未处置人类消息。prestop 最后可逆步骤仍必须重验 quiet 15m。

初始化产物已交给真实 shell 的 base/Bridge/checkpoint 守卫验证。P2/P3 允许尚未播种的 null cursor digest；P4b 仍要求有效 SHA，不能绕过真实 seed。

## E：告警回执裁定

Lead 问题 `756a57d2-2983-4092-95a4-bbf16e267f61` 裁定不新增 receipt 子系统：direct 的 activation_probe 严格输出为 `sent message_id=<Discord id>`，旧 kind 输出保持不变；queued 保留现有状态。待实现的 proof collect 必须有界等待 drain，再按唯一 marker 从 Discord REST 取得真实消息 id，统一记为 `discord_message_id`。queued 状态本身不是通过证据。

Lead 问题 `8f76eeec-c86b-4915-a595-04d23a5448ab` 接受实际 TUI producer 的适配：无时间戳的 `real TUI up` 行仅诊断，实证必须是公共 windowed verifier 通过、精确 raya-raya 活 pane、当前 thread/CODEX_HOME/workspace 绑定，以及 pane PID 启动时间严格晚于当前 Lead process_started_at。对应 helper 已用旧 pane、旧 thread、错误窗口负例验证。summary 使用实际 mailbox producer 的 `type=summary_absorption_round`，并从 `lead_event:raya:summary-absorption:<slot>` 取得 roundId，拒绝把传输 envelope 当成数据库内容。

`raya-migration-proof.js collect --text-message-id <id>` 在同一部署锁内核验冻结文件/两仓 SHA、公共 preflight/live verify、旧 owner 缺席、当前线程与 TUI、真实 ACK/outbound、summary 和告警。写入前再次检查窗口、进程、线程和文件绑定；任何漂移不写 proof。临时产物先经过现有 `raya_validate_proof` 与 P6 守卫，再原子写入。激活标识始终为 `<migration_id>:<activated_at>`，不随 PID 改变。实时 cursor 可以已前进，`seeded_after` 保留原 seed-input 的边界，并核验当前 cursor 未倒退；emptyChannels 写为 `"0"`。

## 当前验证

迁移 CLI 组合测试（授权、初始化、持久探针/锁、人工恢复、班车历史窗口、真实 seed 写入器）59/59；proof 19/19；updater shell 38/38；source wrapper 37/37；prestop 11/11。prestop 覆盖构建、目标、persona、ff、身份与候选碰撞的拒绝，以及正常晋升和停机恢复。

全仓 `pnpm lint` exit 0（16 条既有 warning）、`pnpm -r build` exit 0。`pnpm test:packages:run` **exit 1，保留红回执**：claude-runner 49 files / 1267 tests passed，1 file / 1 test failed、2 skipped，另有 1 个 worker error；递归队列在此退出，teamlead 全包未运行。原始日志 `/tmp/fly2496-final-packages.log` 的关键失败：

```text
FAIL test/kill-path-inventory.test.ts > FLY-2211 kill-path inventory > classifies every mechanical kill-path hit in production roots
AssertionError: expected [ Array(661) ] to deeply equal [ Array(660) ]
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
```

清单失败隔离复现（1 failed / 4 passed），是本单新增 `raya-migration-io.ts:process.kill(owner, 0)` 缺少 `signal-0-probe` 登记。只补这一条清单后，隔离 5/5 通过。依 Lead 裁定 `f2e8189a-2f19-44f4-b1e1-08db66f91105` 不重跑全量；保留上述红结果，进入 review/非 draft PR，以精确 HEAD CI 为准。若 CI 只红在 onTaskUpdate，已获准一次 `gh run rerun --failed`。以上不是全仓全绿、生产或 QA 验收。

PR #1179 的首轮 CI（run `34797896224`，HEAD `9989c6899`）Quick Gate 报 `unclassified_retention_consumer:packages/teamlead/src/bin/raya-migration-proof-evidence.ts:mailbox:read`。已补该精确读者的 `candidate_guarded` 登记：证据缺失时采集器拒绝，不改变保留或删除策略。新增登记断言先红后绿，消费者 gate 测试 8/8、全源码扫描通过。该修复需要新 HEAD 的 CI 和评审，旧 HEAD 的结果不能替代。

## 代码审查阻断项：前激活恢复

R2（question `f8d1b684-32e9-4c50-bbb9-8f345cae0246`，HEAD `ee351fc76100b9507211da7aee2e98653a8d297c`）要求修复 HIGH `p3-resume-flywheel-drift-wedge`：班车更新 Flywheel 后，P2 stop intent、P3 或 P4b 恢复会被旧 Flywheel SHA 卡住。新增同锁前激活重绑定，保持 Raya checkout、canonical、registry、summary receipt、persona 和导出绑定，核验当前部署 SHA、Bridge health/buildSha 与公共 `flywheel-lead.sh verify --stage registered`；仅更新 Flywheel SHA 并追加 `pre_activation_rebinds`，不推进 checkpoint，然后恢复原路径。失败进入 awaiting_pre_activation_rebind，不改变绑定。

范围依据 Lead 问题 `f13736d1-8bf7-4337-8434-11a707ac4ae8` 与 `8ba7ae38-5451-4508-952a-ce6d2deddf63` 的明确裁定：允许 Raya 尚未安装；这里使用 registered verify，不能要求已安装的活进程或 windowed verify。P5/P6 原有恢复保持不变。六个回归用例先红（原有 11 通过、新增 6 失败），修复后通过；用例调用真实 raya_prepare_source，覆盖 P2 部分停止、P3、P4b、P3 未决消息及健康/公共核验拒绝。另补 registry、persona 和 checkout 漂移负例。

R2 的七个 MEDIUM advisory 已报告，Lead 明确拥有后续处理：prestop probe intent 恢复、重绑定告警去重、旧 plist disable、无效账本分类、ff 后失败告警、停机授权再次核验、频繁部署时 P5 重绑定活性。本次只修 HIGH；最终审查与精确新 HEAD CI 仍需通过。

HIGH 修复后的受影响回归：prestop 20/20、updater 38/38、source wrapper 37/37，shell 语法与 diff whitespace 检查通过。既有 P3 单元 fixture 显式写入账本匹配的部署 SHA，使其继续独立验证对账等待；真实 SHA 漂移路径由上述非 stub 回归覆盖。

HEAD `ee351fc76100b9507211da7aee2e98653a8d297c` 的 CI run `34798384945`：除 teamlead 1/3 及依赖它的 CI OK 外全部通过；该分片实际失败为 `raya-migration-init.test.ts` 七项 `legacy-executable-invalid`。fixture 的 `/bin/sh` 在 Linux 为符号链接，被正确的普通可执行文件守卫拒绝。改用临时目录内 mode 0700 普通可执行文件，仅修测试跨平台假设，不放宽运行时守卫。没有使用 CI 重跑授权；后续新 HEAD 自然触发新 CI。

R3 question `7398a387-c9b9-41d4-8af3-ff7d7d3a1fe0` 对 `fd9d5ab76d39a00a2d254928b673d5de7a5ddc1a` 返回 APPROVED（HIGH 已解决），另有八项 MEDIUM：前述七项加 `pre-activation-rebind-silent-wait`（绑定漂移或持续健康失败可能静默等待）。已全部报告 Lead，非阻断建议不扩入本单。

该 HEAD 的 CI run `34799608312` Unit light 发现 `FLYWHEEL_DEPLOYED_SHA_FILE` 缺少变量分类；隔离 flag drift suite 复现 2 failed / 12 passed。将其登记为 NON_FLAG_ALLOWLIST 的 SHA marker 文件路径后 14/14 通过，不增加功能开关。此分类修复需要再次刷新精确 HEAD review/CI。

## Engine conflict rework（2026-09-14）

请求 `rework:8a7e65b040556dcce8a3eb1415bb7c9021fb4a1e22670d36d7449158137b1b93` 从基准 `51931efec2884183175861bcd30c3c6936297976` 同步 main `e551e320ba71093276199afa21e2445a7b9974ea`，合并提交 `d7c27bebb`。唯一冲突是 retention consumer 配置的并行追加：保留 Raya proof mailbox 读者与 FLY-2490 session_events backfill 读者，二者均为 candidate_guarded；没有额外功能修改。

复验：retention tests 8/8 + scanner ok；lint exit 0（18 warnings）；递归 build exit 0；Raya migration 7 files / 69 tests passed；prestop 20/20、updater 38/38、source wrapper 37/37。已重新读取 Lead 裁定 f2e8189a-2f19-44f4-b1e1-08db66f91105，此前全量套件红回执继续保留，不重复全量。最终 HEAD 需要新 review 和 CI；未执行生产操作。

## Rework review HIGH：旧 owner 重启复活

精确头 `da185f8dc` 的 CI run `34807617806` 全部通过，但评审 `d85e7607-36d8-4577-b334-5afa030f3297` 重试后返回 CHANGES_REQUESTED。HIGH `legacy-plist-not-disabled-reboot-dual-owner` 将先前 disable advisory 升级：bootout 不持久，RunAtLoad plist 与忽略的旧 dist 仍可能在登录时启动。Lead `423db2f5-afaa-41df-945d-4e7414d11ed6` 明确要求在本 PR source-only 修复，其余 MEDIUM/LOW 不扩入；若新审查提出同源新 HIGH，停止并报告 Lead。

现在每个匹配且获账本授权的旧 job 在 bootout 前执行持久 disable，读回精确 label 的 disabled=true 后持久记录 disabled_at_ms。已卸载 job 也必须禁用，部分停止仍续原回执。old_stopped_at 快捷路径、P3+ 恢复、P7 finalization/后续事务都只读核验两个 job 已禁用且确实不存在；旧产物存在不能代替禁用证据。proof collect 同样拒绝可在登录时复活的旧 job。未删除旧产物或移动 plist；没有执行宿主命令。

回归先 RED：旧实现不能通过禁用失败与重启测试；修复后验证真实 RunAtLoad plist 的模拟登录，未禁用对照复活、禁用后不复活、忽略的 dist 仍在；还覆盖禁用失败零 bootout、部分停止恢复、禁用覆盖被移除时恢复/P7 拒绝，以及 proof 拒绝未禁用 job。验证结果以本轮最终回执为准。

本轮最终验证：updater 38/38、prestop 20/20、wrapper 37/37；迁移/proof 7 files / 70 tests passed（含新 proof 负例）；pnpm lint exit 0（18 warnings），pnpm -r build exit 0。旧全量 package 红回执仍按已核实 Lead 裁定保留，不重跑全量。新 HEAD 需要新的 CI 与评审。

### macOS readback 格式更正

评审 `a5ce13c9-f3c7-46fa-b5e1-910ce4139068` 对 `01c2b2860` 返回同源 HIGH `legacy-disabled-readback-format-mismatch`：生产 macOS 输出 disabled/enabled，而旧 fixture 只用 true/false。按前次裁定先停并报告；Lead `33257716-6284-44b5-b0da-91ca5a14f2e5` 只授权解析器和测试更正：disabled 或 true 才是禁用，enabled/false/未知值拒绝，stop intent 位置不动。若第三次同源 HIGH，停报 Lead；本轮 review 通过后按 leadAcceptance 收口，不再新开一轮。

真实输出 fixture 先复现 proof 3 failed / 11 passed；两个解析器最小更正后 proof 14/14、updater shell 39/39，覆盖新旧格式和未禁用/未知值。pnpm lint exit 0（18 warnings），pnpm -r build exit 0。未执行生产命令；其他建议仍属 follow-up。最终新 HEAD 的 review/CI 待验证。

## Resume conflict-only sync（2026-09-14）

按 Lead 指令 a9398009-2438-40d7-9140-3d58eb616c18，同步 main `14866f7e5`，merge `2cee58281`。唯一文本冲突保留 Raya mailbox candidate_guarded 与 main 三项 release_signal protect 登记。自动合并重复登记 `FLYWHEEL_DEPLOYED_SHA_FILE`，lint/build 先失败；`9bb81c593` 合并为一项并保留 readiness/Raya 两种用途，无运行时功能变更。此前两项 HIGH 修复保持原字节。

冻结依赖后复验：pnpm lint exit 0（18 warnings）、pnpm -r build exit 0；migration/proof 7 files / 73 tests passed；prestop 20/20、updater 39/39、source wrapper 37/37、alert strict delivery 31/31；config flag/truth 53/53、retention consumer 8/8 和全源码 scanner 通过。错误的初次测试路径及 package filter 未执行测试，均已用上述正确命令替代，不计为通过证据。main 自带文档 whitespace 保持不变；本 issue 的 scripts/packages diff whitespace 检查通过。

此前 `4d1160a5e` 的 CI 34809758763 最终 attempt 3 全绿，R3 review APPROVED 且 Lead acceptance 已保存于 PR；其七项非阻断建议仍为 follow-up。此前全量 package 红回执按 f2e8189a 裁定保留，不重复宿主全量。合并后的最终头须重新绑定 review/CI；本次不执行生产 register/install/restart/deploy，实际割接仍由 Lead 在独立授权后执行。

## Review HIGH：真实 tmux pane 格式（2026-09-14）

`060383130` 的 CI `34820844552` 已全绿，评审 `0e11a6cd-1370-444e-b83b-ace8b93cc2d2` 仍因 HIGH `proof-tui-pane-format-never-matches-real-tmux` 返回 CHANGES_REQUESTED。Lead 问题 `8d1f34cb-39be-4a61-abb5-52ae365fe463` 只批准该项 parser/证据测试修复，其余 MEDIUM/LOW 留 follow-up；若再出同源 HIGH，停报 Lead。

独立 tmux 3.7c 私有 socket 复现：display-message 与 list-panes 在本环境均保留 tab（reviewer 的 underscore 现象未复现），但 pane_start_command 均包含外层双引号和内部转义，现有前缀匹配确定性失败。新增真实 tmux 回归先 RED：1 failed / 9 passed，错误 tui-thread-binding-invalid。最小修复改用 list-panes -F，并以 Python shlex 只解码成一个 command 参数；不执行采集到的命令。仍要求唯一 pane、正确窗口、活 PID、匹配 home/workspace/remote/thread，且 pane 出生时间晚于 Lead。

真实私有 socket 用例包含带空格的 home/workspace 和错误 thread/home/workspace 负例；夹具覆盖旧进程、错误窗口、dead pane、多 pane 与额外 argv 拒绝。tmux socket 及模拟 sleep 进程在 finally 中清理。环境执行 ps 被 EPERM 拒绝，因此该集成用例的 verifier 与 process birth 使用固定夹具，只声称真实 tmux 格式验证，不能作为宿主 live proof。更新 full-proof fixture 为真实引号格式后，两文件 24/24 通过。原两项 legacy disable/readback HIGH 修复未动，无生产操作。

### Locale-free TUI evidence correction

同源 review `abb186b7-6ecb-464d-b5bd-9b77ad82670b` 对 `c03f420d7` 仍 CHANGES_REQUESTED：无 locale 时 tab 被 tmux 清洗为下划线。按前次裁定停报，Lead `75986202-4d63-4f7a-9f98-0680b2dddb22` 批准最后一轮窄修，优先采用不依赖 tab 的格式；若再出现同源 HIGH，冻结并将原话交 Lead 治理，不能自行判通过。

私有 socket、删除 LANG 和全部 LC_* 的独立复现证实 tab 输出只有一个字段，-u 后恢复四字段。回归先 RED 1 failed / 9 passed（tui-pane-invalid）。修复 `49dbdbf69` 使用可打印竖线分隔三个身份字段与命令，命令中的竖线完整保留、多行 pane 拒绝；-u 仅补充保证 Unicode 输出。回归显式清除 locale，并用移除 -u 的对照证明分隔符不依赖它；带空格与竖线的路径通过，既有线程/路径/出生时间/dead pane/额外 argv/多 pane 负例继续拒绝。

最终 proof 24/24，pnpm lint exit0（18 warnings）、pnpm -r build exit0。ps/verifier 仍是前述显式夹具，未增加生产证据声明。旧 disable/readback HIGH 与其余 M/L 均未修改。最终头一次推送含里程碑后重新评审/CI。
