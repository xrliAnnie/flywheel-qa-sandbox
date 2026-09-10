# FLY-2446 通用 voice 进程 — 实施补充
Issue: FLY-2446 (https://linear.app/geoforge3d/issue/FLY-2446/语音-通用-voice-进程会议模式所有-lead-可挂rg随身模式先-raya-用独立-codex-realtime-进程语音文字经)
日期: 2026-09-09
基于: plan.md

## Lead 裁定

2026-09-09,question `8f98818a-f9c0-4a16-8400-698273d68827`:

- `voice_sessions` 增加 nullable `topic`;旧行保持有效。
- thread 名由负责创建 thread 的 TeamLead provisioner 生成,不在 `voice-codex` 重复实现。
- provisioner 只用持久化行重建名称:meeting 为 `🎙️ <topic> · <YYYY-MM-DD>`,RG 为 `🎧 随身 · <YYYY-MM-DD HH:mm>`。
- `topic IS NULL` 时保留兼容回退 `voice-<snowflake>`。

以上是实施位置与 crash-safe 数据闭环的补充,不改动已钉住的 `plan.md`。

## Provisioning 与 ending 的固定时间锚

为落实 plan §3.1 / §3.4 的 nonce 恢复窗与 ending 超时，增量迁移仅为 `voice_sessions` 添加两个 nullable TEXT 列：`root_requested_at`、`ending_started_at`。前者在首次持久化 root intent 时固定，后者在进入 ending 时固定；renew、poller 与 provisioner 接管均不更新它们。旧的 root-unknown / ending 行从 `created_at` 保守回填，避免把无法证明的新鲜度当成新的重试窗。没有新表，也不删除旧列或证据。

根卡未知结果在固定 30 秒窗内最多立即尝试两次，始终复用同一 nonce；窗内仍未知则保留 provisioning，恢复时超过窗口即 `failed(provisioning_root_unknown)`，记录 nonce orphan candidate，禁止再次 POST。窗口与次数是 provisioner 的可注入内部参数，无新增生产环境开关。

取消发生在根卡或 thread 外部请求进行中时，正常推进 CAS 仍拒绝执行；同 epoch、同 step、仍为 provisioning 且已请求取消的行只允许补存成功回执 ID，供取消收尾使用，不推进状态或步骤。无 thread 时，取消状态实际发到 chat channel 并 reply 根卡；已有 thread 则发到该 thread 并尝试归档。清理失败以固定 `status_failed` / `archive_failed` 标记附在终态 reason，未知根卡保留 nonce orphan candidate，不声称没有外部副作用。

## 本地正常结束的 Bridge 收据

daemon 在 live 收到 founder 离房或退出语音口令后，直接提交 `ended(she-left|voice-stop)`；Bridge 在单个事务内接受这一等价终态映射、写 `ended_at` 并结算 outbound 行。仍要求当前匹配且未过期的 lease，拒绝未知 reason。`text-stop` 仍由 Bridge stop 先置 ending，再接受 daemon 的 ended 收据，不能从 live 直接跳过该步骤。
