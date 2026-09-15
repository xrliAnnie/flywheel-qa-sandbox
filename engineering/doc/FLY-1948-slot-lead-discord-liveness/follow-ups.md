# FLY-1948 通道活连接 — 评审后续事项
Issue: FLY-1948 (https://linear.app/geoforge3d/issue/FLY-1948)
日期: 2026-09-14
基于: plan.md

有效代码评审 APPROVED：request `c11dde49-3042-471b-a14c-3b60c4c5186f`，round 3，head `a996d94d3fadf46dd72a855782c5eb15edee991a`。
Lead handoff `115a2126-98e6-475d-9bf0-9eb17da84ff0` 要求仅记录以下非阻塞建议，不为它们追加实现或新评审轮次。

| 级别 | findingKey | 后续事项 |
| --- | --- | --- |
| MEDIUM | redact-over-matches-filesystem-paths | 脱敏规则会清空含真实路径的 adapter argv，降低故障形状证据可读性。 |
| MEDIUM | candidate-cap-counts-host-wide-adapters | 32 候选上限在 state-dir 过滤前统计全机 adapter，繁忙主机可能返回 probe_unavailable。 |
| MEDIUM | roundtrip-t2-t3-lower-bound-clock-skew | Discord 与主机时钟偏差可能被 T2/T3 下界校验报告为超时。 |
| LOW | liveness-precheck-conflates-unavailable-with-dead | roundtrip 将 census 所有非零状态归为 channel_not_live。 |
| LOW | channel-invalid-detail-is-constant | 证据来源校验拒绝只有固定 validation_failed，缺少具体原因。 |
| LOW | probe-skips-artifact-on-path-reject | 非法输出位置直接退出，可能留下旧 liveness 文件。 |
| LOW | stale-channel-failure-shadows-earlier-phase | 复用未清理房间时，旧 channel-failure 可能遮蔽本次更早阶段失败。 |

本轮验证：上述代码 HEAD 的 GitHub CI run `34913759864` 共 15/15 SUCCESS；完整 hermetic 部署夹具 24 passed / 0 failed。旧本地 package gate 有真实失败且未形成完整可接受回执，保留红色结论；Lead 指定以 exact-head CI 为本次交接依据，并停止主机全量套件。真实 529 founder 消息及回复、重启恢复与负对照仍由 QA 节点执行。
