# FLY-2920 内存准入不锁存 — 实现验收
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920)
日期: 2026-09-26
基于: plan.md

## 当前状态与当前裁定

F 实现进行中。本页不表示实现完成、正式代码评审通过、全量 CI、QA 或生产验证。

Lead 2026-09-26 10:4x PDT 的三条实现裁定优先于已批准 plan 的旧取舍；不修改冻结的 design blob `da53ca9012d3c9894d14df4f70e15ead060d55c6`：

1. `pressure-boot-handoff-residual-fail-open`：缓存过期、warmup 失败及不可确认读数默认拒绝准入，显示 unknown/degraded；不把历史 pressure 或通知记录当作当前压力证据。新有效 non-danger 读数立即恢复准入。
2. `pressure-wiring-test-realtime-65s-ci-cost`：CI 组合根用短真实计时器、受控 I/O 验证生产创建/start/stop 与独立采样节拍，不能手工 tick 或 fake clock 冒充接线证明。30 秒生产节拍和约 65 秒真实长窗留给 QA。
3. `pressure-sampler-guard-tests-unlisted`：保留 kill-path inventory、child-process census，以及 test / QA / 非 macOS 的传感器开关检查；不靠全包测试寻找影响面。

## 待验证合同

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
