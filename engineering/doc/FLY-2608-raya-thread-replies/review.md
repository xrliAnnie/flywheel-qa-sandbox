# FLY-2608 Raya 线程双向对话 — 调研
Issue: FLY-2608 (https://linear.app/geoforge3d/issue/FLY-2608/raya工程修复-discord-thread-中的-founder-提问必须送达-raya并在原线程回复)
日期: 2026-09-15
基于: plan.md

## R1
questionId b7c7776e-59e3-429e-901a-99c43bba0dbf；requestId c96e6098-91ed-4370-b1f9-692002fa55a4；有效与原始verdict均CHANGES_REQUESTED。未使用Lead ruling覆盖发现。

| findingKey | 级别 | R2前处置 |
|---|---|---|
| unbounded-first-scan-backfill | HIGH | T2固定上线边界文件，只读消费、缺失损坏关闭新增覆盖、重启不重置；max创建/上线/游标；T5逐线程dry-run且上线前自动回放=0；两旧消息定点恢复 |
| registry-merge-misses-pending-question-threads | MEDIUM | T1先合并三源byThread；pending-question重复用例确保只一个非ingestOnly task |
| dual-producer-deliveryid-route-race | MEDIUM | T3父频道互斥准入+既有owner socket订阅排除；不能将请求失败当空集；跨producer用例与入订阅parent guard |
| archived-thread-coverage-gap | MEDIUM | T1b复用guild active threads与不滤archived的登记反查，纯发现并纳入；新增真实归档后提问硬验收 |
| scan-budget-latency-unbudgeted | MEDIUM | 保留既有25/约60s的明确延迟取舍，验收至多75候选，入队240秒、回答360秒；新增nudge不改计时器，超限不能报通过 |
| recovery-ignores-discord-lane-verdict | MEDIUM | T2b逐lane游标/恢复处置；T4恢复必须有batch、实际消费和同线程回答；归档不报新投递成功 |
| no-global-bot-token-fallback-silent-skip | LOW | T1缺owner token显式诊断，不借用全局bot |
| get-limit-is-50-not-100 | LOW | T2跨页测试改为>2×GET_LIMIT，保留真实API分页核对 |

R2要求复核阻塞项及以上设计增补。所有生产修改和验收仍由实施/QA承担，作者未实施这些机制。

## R2 评审基础设施状态
questionId 85f2ac75-73dc-4ca4-b1d1-04ecad287be4；requestId c38233ab-b61e-49d8-8037-7f2708d4f9e5。
首次执行在2026-09-16 03:52:26Z记录failed/no_verdict，gate仍pending；未将原始转义输出当作有效结论。03:55:37Z以相同requestId重试并获accepted/duplicate=true，权威job恢复running。继续等待有效结构化verdict；不另造请求抢占结果。


## R2有效结论与R3处置
同一request在两次no_verdict之后，以新reviewer会话136ff608-f8d2-4b00-a193-a7a75a97da5a产出有效CHANGES_REQUESTED（round2）；此前原始无效文本不构成批准。

| findingKey | 级别 | R3前处置 |
|---|---|---|
| rollout-marker-path-ignores-state-dir | HIGH | 与既有cursor一样用getStateDir；marker绑定实际state/DB/comm根路径及owner；初次15分钟新鲜度；hash绑定一次采纳回执区分正常重启；QA/生产隔离及互拷拒绝用例 |
| global-activation-scope-unflagged | MEDIUM | 新覆盖与replyChannelId变更限本单raya/raya；其余Lead扩面列为独立后续，不改变Raya验收 |
| t1b-guild-id-source-unspecified | MEDIUM | 明确config.discordGuildId+lead.botToken；缺失禁止声称归档场景验收通过；本单每轮一次guild读取 |
| scan-budget-latency-unbudgeted | MEDIUM | 新Raya/既有session分组测量；既有同负载基线增加不超过一轮，超限不可通过 |
| ship-judgment-scan-cursor-shared | LOW | 明示游标双重用途并加有限轮数完整覆盖测试 |
| nudge-lead-inbox-arg-order | LOW | 改为leadId,projectName，闭包依赖及spy检查实际顺序 |

R3只复核这些具体修订及原Raya目标，没有新增生产动作。
