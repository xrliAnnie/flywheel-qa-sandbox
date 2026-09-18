# FLY-2523 自动收尾与额度就绪 — 探索
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-17
基于: 无

## 目标与裁定

2026-09-18 05:53Z founder 裁定取代旧手工窗口方案：凭据迁移必须自己重试、每次留回执、逾期主动告警。日期头使用宿主本地 2026-09-17；裁定按 UTC 保留。当前节点只设计，不迁移 home、不登录、不翻 flag、不重启。

最终交付顺序：明确全部 approved home → 既有节律检查使用状态 → 空闲才备份迁移 → 全部满足回执及当场拓扑 → 生成 receipt 与有范围的注册home证明，同时完整展示global unknown。本单不开flag。Lead aa341d63已将桌面凭据权威、独立开关及动态恢复验收移出本单；后续开关仍须2729 QA、桌面正向证明和当场global ready。

## 当前证据

基线 ec5906b87。设计阶段仅 lstat/readlink 与计数，不读 auth 内容：

| Home | 2026-09-17 本轮观察 | 决策 |
|---|---|---|
| agents/flywheel/eng_design | symlink 到 ~/.codex/auth.json；无 pending | managed |
| agents/flywheel/implement | 普通文件；有 pending | managed，空闲迁移 |
| ~/.codex-infra-bot | symlink 到同一 truth；无 pending | managed，保留 flywheel/codex-infra-bot-lead 归属 |
| ~/.codex-mufasa | symlink 到同一 truth；无 pending | managed，保留 growth/mufasa-lead 归属 |

~/.flywheel/codex-quota/readiness-receipt.json 不存在。目录里 lease 数为零不能证明无进程。原 issue 的两个 Lead copy-pending 状态已经过时，不能为重做迁移而改坏它们。未刷新 flag 值，不把原 rev2/off 当本轮实测。

## 三种路径

1. **选定：既有小时 health 重试 + updater 每次唤醒兜底检查 + 实际 Lead 停机段调用同一操作。** keyed home 复用 admission 锁与租约；Lead 的变化只放进现有 controlled restart 的 quiescent 段。每次尝试有外置回执，逾期有固定工程路由。
2. 只在班车部署成功后迁移：拒绝。源码已是最新时 updater 提前返回，不发生停机；不能借时间点声称全舰队已静默，仍会忘。
3. 新 daemon/cron 或定时强杀等窗口：拒绝。违反 R4，也会扰动活跃任务。

## 关键定义

- “无写入”指目标 home 整棵树、原 auth、canonical auth、备份区均不变；尝试回执写入独立控制目录是用户明确要求的例外。
- done = 本轮空闲且发生迁移/残留标记清理，后置条件已验证；already-satisfied = 空闲检查后拓扑原本完整，不改 home；skipped = 忙、证据不足或未取得互斥；真实 I/O 错误另记 failed，绝不冒充 skipped 或成功。
- 每次调用都记录；幂等要求作用于 home，不要求审计日志不增长。
- “所有 home 已满足”不等于 readiness ready；后者还检查真实进程、CommDB、租约、Lead 注册与未批准 home。

## 边界

保留 R1–R5、账号池与独立 updater 部署职责。不改额度引擎恢复政策（包括 FLY-2676 manual fallback），不自动扩大 approved 清单，不创建调度器，不触碰 founder 登录态。不把设计审查通过称为生产已恢复。

Lead 非阻塞问题 e451c20d-d6d2-4d95-b601-358e30ac4c5a：四家 managed + N=1 天默认。当前生产拓扑支持该选择；若新归属裁定到来，更新设计并重新审查。

## 更新裁定（问题83649a39）

Lead明确把正式注册的raya/raya、.codex-raya纳入，当前共五家。清单改为两家Runner明确policy加注册Codex Lead派生，不硬编码数量；无法确认的live home立即告警且readiness失败。已满足的活跃home允许只读already-satisfied（不调用迁移），需要写入的活跃home仍skipped。原四家提案保留为探索历史，以plan最终合同为准。

## 2026-09-18 529 房返工增量

Lead 返工 `rework:0557b89044f3bbe04f3c8bc42c497efe19a90ca185a54d0165e872ea8bc388ef` 已明确批准所需形状：不重做既有 reconciliation，只补 slot 中可见的真实告警证据。当前失败链是三重叠加：cycle 把 `--project/--lead` 固定为生产 tuple；shell emitter 对该 kind 只接受生产 tuple；test-deploy 无条件关闭 rider，且 rider/cycle 默认根会回落到宿主 HOME。

采用窄的显式 slot 模式，而不是放宽生产路由：

1. slot 必须声明 `/tmp/flywheel-test-slot-N` 隔离根、`test-slot-N` project、绑定 Lead、slot projects 文件及 slot-local state/queue/claims/dead-letter；任一坐标越界即 `config_error`。
2. 告警频道只从该 projects 行的 Lead `alertChannel` 读取；再读取 canonical `${HOME}/.flywheel/projects.json` 的生产频道集合，任何碰撞都拒绝。生产模式继续只接受 `flywheel/flywheel-eng-lead`，不接受 slot override。
3. test-deploy 只在显式 `--codex-home-reconcile` 且同时 `--alerts` 时打开 rider，并预写当前 schedule 使 Bridge 启动不自动发测试噪音；默认 slot 行为仍关闭。
4. 提供 slot-local 驱动，分别构造 overdue obligation 和上游 policy failure，通过真实 cycle + shell emitter 发 severe、warning 两条；二者都不传 mention，Discord payload 的 `allowed_mentions.parse` 必须为空。

拒绝的方案：仅在 QA 脚本里直接 curl（绕过被测路由）；允许任意 env channel（无法证明生产频道拒绝）；让所有 `--alerts` slot 自动开 rider（会在无 fixture 时制造启动噪音）。
