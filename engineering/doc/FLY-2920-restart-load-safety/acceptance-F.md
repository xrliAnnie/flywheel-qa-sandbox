# FLY-2920 内存准入不锁存 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

## 当前状态与当前裁定

F 的实现、内部 spec/quality 审查和本地相关验证已完成。正式代码评审、全量 CI、QA 和生产验证尚未完成。

Lead 2026-09-26 10:4x PDT 的三条实现裁定优先于已批准 plan 的旧取舍；不修改冻结的 design blob `da53ca9012d3c9894d14df4f70e15ead060d55c6`：

1. `pressure-boot-handoff-residual-fail-open`：缓存过期、warmup 失败及不可确认读数默认拒绝准入，显示 unknown/degraded；不把历史 pressure 或通知记录当作当前压力证据。新有效 non-danger 读数立即恢复准入。
2. `pressure-wiring-test-realtime-65s-ci-cost`：CI 组合根用短真实计时器、受控 I/O 验证生产创建/start/stop 与独立采样节拍，不能手工 tick 或 fake clock 冒充接线证明。30 秒生产节拍和约 65 秒真实长窗留给 QA。
3. `pressure-sampler-guard-tests-unlisted`：保留 kill-path inventory、child-process census，以及 test / QA / 非 macOS 的传感器开关检查；不靠全包测试寻找影响面。

## 已验证合同

| 方面 | 决定性证据 |
|---|---|
| 独立节拍 | Lead reconcile promise 挂起超过三个短真实周期，实际生产 sampler 仍启动 0/P/2P 采样；无重入、无补跑突发 |
| 启停/预算 | admission 前启动并冻结 warmup；5 秒读预算终止探针；stop 在 store.close 前等待，迟到结果不写缓存或再设 timer |
| 新鲜读数 | 实际完成时间，最多两份完整采样；90 秒以内跨失败保留 baseline；超期/回退不计算虚假 delta |
| 准入解除 | 有效 delta≤MIN 且 free≥LOW（含 8–15 band）当次放行，无需 HIGH 或两次恢复 |
| 启动与未知 | 首个有效 danger 一次阻断；正常两次 danger；warmup 截止后转 unknown 并默认拒绝，不重置期限或伪装健康 |
| 重启缓存 | 同 hostBoot/source/threshold 且非未来/新鲜证据才复用；原 deadline/expiry 不因重启/失败续期；真实 host boot 才可新链 |
| 旧 hold | 迁移只清 swap-sensor 行；即使旧行残留也不成为准入权威；手工暂停保留 |
| 一致显示 | admission 与 capacity 按同一 now 验证同一 snapshot；pressure_hold 保留类型兼容，unknown 与 manual 分别说明 |
| 通知 | 两次 danger / 两次 non-danger 才 pause/resume；稳定 episode key、持久接受后标发、失败重试；通知不阻塞采样也不决定准入 |
| 退化说明 | 过期只说采样未知，不能发虚假恢复；恢复后说明恢复派发，不把 band 叫 free≥HIGH |
| 回归 | bot/zombie/identity 原节拍、load/core=8 与 minFreeBytes=0 默认不变；旧 repair/recovery 仅读快照 |

具体文件选集与逐项排除原因由 `consumers-F.json` 记录。任何实际 30 秒生产时钟、宿主 vm_stat/压力读数、通知外送效果的未执行部分须在交卷中单列，不以短时 I/O 夹具代替。

## 实现中发现并验证的必要边界

- 实际 `LeadAlertNotifier` 在同毫秒接收同类 pause/resume/degraded 时，旧队列文件名仅含时间、Lead 和 eventType，会覆盖已返回 `queued:true` 的记录。F 的修复仅为 pressure sampler 消息增加稳定 eventId 后缀；需用真实队列及冻结时钟证明三种通知均可回放，其他告警文件名合同保持原样。
- 原 `sensorOn("SWAP")` 动态环境读取未进入 flag inventory；迁到新 sampler 的直接读取使 `feature-flags-drift` 给出明确红灯。按 `doc/engineer/implementation/flag-authoring-runbook.md` 将这一现有开关接入 registry/store codec/global wrapper，保留正常初始化 seed 路径，不新增豁免或隐藏读取。动态启停须覆盖关闭期间的在途采样和再次开启，不能在 registry 声明 call_time 后实际只在构造时读取。
- 缓存首次读取失败后，稍后恢复读取不能用空通知状态覆盖已有 pending/episode 历史；恢复持久化前必须保留历史。主机身份未知只限制旧采样缓存的可信度，新的有效采样仍可解除准入。
- sampler 接线保留既有 catalog/schema/flag 初始化保护，之后尽早启动并在任何可派发的准入前绑定；不得为提前采样绕过迁移失败的安全边界。

最终源文件哈希与检查收据见 `verification-F.json`；`consumers-F.json` 已覆盖 notifier、flag registry/store/runtime/route 及相应守卫。

## 内部 spec 审查第一轮（非正式 code gate）

首轮冻结后审查指出两处 F 合同缺口，均接受并进入红绿修正：

- 独立 unknown 事件使用 boot/warmup 固定 ID：同 boot 第二次 outage/recovery 被真实 notifier 的永久去重吞掉。每次新的退化事件需要独立持久身份；重试/重启仍沿用该事件身份。
- capacity 先 probe admission 再独立读压力，可能在 expiry 边界同时显示 admit 与 unknown hold。同一次 capacity 构建必须共用同一压力评估，增加跨 expiry 的可执行反例。

首轮源码的 owning build 和 lint 已通过（`/tmp/fly2920-F-build.log`、`/tmp/fly2920-F-lint.log`，lint 25 条既有 warning）；这不是修正后版本的最终验证。正式代码门、完整相关回归和 QA 均未完成。

内部 spec R2 已通过：实际 notifier 两轮退化/恢复跨重启的红绿测试证明新事件不被旧键吞掉；capacity 的 expiry 边界测试证明共享一次评估。相应日志为 `/tmp/fly2920-F-r1-outage-{red,green}.log` 与 `/tmp/fly2920-F-r1-capacity-{red,green}.log`。

内部 quality R1 随后提出停机通知生命周期问题：`attachAlertSink` 的外送 await 之后仍可进入 `resolve`，而后者本身有跨 await 的数据库写入。需要在适配器中重查 generation/running，并在关库前 drain 已开始的持久副作用，覆盖 stop 在 alert 前后和 resolve 期间的场景。另将“无法验证 host boot”导致所有通知不落盘/不发送的 advisory 纳入本组修复：未知身份只限制证据缓存复用，不能取消退化/恢复告知。修复已完成，内部 quality R2 通过；四项新增反例先红后绿。

## 最终本地验证

- 23 个变更/新增源码与守卫文件的 SHA-256 在最终检查后逐项一致。
- 显式相关选集：49 个 Vitest 文件合计 993 项通过，另 1 个 Node 文件 10 项通过。StateStore 显式迁移选择有 95 项未选，随后 related 整文件 104 项通过。
- 配置 related：7 文件 / 183 项；teamlead related：40 个明确 include 中依赖图选出 32 文件 / 808 项，均通过。未被依赖图选中的文件仍已按显式选集运行。
- Bridge 既有 QA report publishing 测试初次超过 5000ms；保持源码和 timeout 不变，单项重跑通过，最终 related 整文件 39 项也通过。原失败记录保留，不据此断言宿主负载是唯一原因。
- `pnpm lint` 通过，25 条既有 warning；teamlead 及依赖构建通过；teamlead / voice-codex dependent typecheck 通过；真实留存消费者扫描 `ok:true`、无错误。
- 这些是本地相关验证与内部审查，不能作为正式代码门、完整 CI、QA、生产或 ship 证据。
