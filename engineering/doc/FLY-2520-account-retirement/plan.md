# FLY-2520 账号到期排序 — 实施计划
Issue: FLY-2520 (https://linear.app/geoforge3d/issue/FLY-2520/切号器-claude-账号候选排序加账号到期日维度retiresat-早于下次-reset-的号优先用光founder-2026-09-11)
日期: 2026-09-11
基于: research.md

## 锁定范围

1. AccountEntry 新增可选 retiresAt，带时区的 ISO 时间；未配置保持旧行为。共享纯校验/读取方法：缺失返回 Infinity，有效返回毫秒，无效安全拒绝。校验必须要求 ISO 日期时间及显式 Z 或 ±HH:MM 时区并检查有效日历时间；date-only、offset-less 和无效日期只使该账户不可选，不拒绝整个 store，其他账号观测与切换照常。
2. verifyAndRankCandidates 在 auth 排除路径检查退休状态，到期（<= now）excludedBy=auth，status=account_retired；无效配置 excludedBy=unverifiable。排序使用 min(resetMs, retiresAtMs)，保留 headroom 分组、cooldown、额度判定和姓名平局规则。panorama 附带规范化 retiresAt。
3. selectNextAccount 两条选择路径均增加退休负向守卫；原有 reset 排序路径使用相同 min，保持 ambiguous scope 的原有规则。
4. capacity snapshot 透传可选退休日期，patrol 额度行及 quota monitor panorama 显示 PT 日期，例如 business(9-14 到期)。保持原有容量行顺序语义，候选实际顺序以 selector 排名为证。
5. TDD 按小批次：未配置兼容；school reset < business retirement < shopping reset < business reset 排名 school/business/shopping；字面周日退休先于周一 reset 则 business 第一；过去/恰好到期排除、无效输入、无 reset、较晚退休、平局；最终选择的跨边界守卫；文件读写/observation 保存日期；panorama、capacity/patrol 文本。先 RED 再最小实现再 GREEN。
6. 无 DB migration，文件可选字段向后兼容；用临时文件读写重读证明重启持久性，移除字段恢复旧排序证明回滚。执行 pnpm lint、pnpm -r build、pnpm test:packages:run 及新增 shell 测试；记录全部失败真实范围，不扩展修复无关问题。
7. 通过注入的 gate review_code + request-review 注册跨模型评审，修复 blocking finding 后重新评审。进度持久化；里程碑 engineering/doc/milestones/FLY-2520.md 为 PR 创建前最后一个提交，开 PR 后 complete --route needs_review。

## 真机验收与待确认

Lead 问题 6c8bb71f-c76d-478d-8024-c5fbf26f95a4 待答：日历示例与 min 规则矛盾，以明确公式为实现基线，具体业务时间须确认。business 配置目标默认 2026-09-14T00:00:00-07:00。生产配置写入、monitor 重启和实时排序/到期后的真实验证由 QA/Lead 在有授权的 host 轮完成，implementation 不重启服务、不部署。提交交接应明确这些仍非已验证。


## R2 范围修订（Lead 明确授权）

权威答复：9e2f53f0-a27b-4d5f-b3d7-7abc71d4d601（2026-09-11）。Lead 采纳 HIGH active-seat-retirement-unhandled，并明确授权更新原评审计划。

- 原「不改切号触发条件」仅增加一个例外：当前活动号 retiresAt <= now 时不可继续使用，复用现有 account_dead trigger 的切号/失败/无候选路径，选择 min-deadline 候选。不得新增其他触发或改变额度阈值。
- 在既有 quota monitor pass 中，在活动号到期前 60 分钟窗口内通过现有告警面写 warning。无需新 daemon/timer，不发 founder 私信。使用持久化的账号+到期时间去重标记，覆盖多 pass 以及状态重读，成功/已入投递队列后不重复，失败沿现有投递语义处理。
- 退休判定不能受 usage API unauthorized/blind 提前 return 阻断。保留机器账号权威及切换安全守卫；取得可信 snapshot 并检查机器账号权威后，必须在 nextUsageDueAt/backoff/credential/usage 的提前 return 前检查到期。复用 account_dead 执行流程，不伪造或持久化 100% 额度观测，也不生成 quota scope/resetAt。
- 测试：活动 business 跨退休边界后切到 school（包括 usage API 不可读）；到期前 59 分钟发一次 warning，连续 pass 和状态重读不重复；60 分钟外不告警；无候选保留既有 no-target 行为。退役优先级不能绕过 auth、model、cooldown 等安全排除。
- 时区校验按上文采纳；无效 retiresAt 仅排除该号，不使全 store 不可读。
- 显示日期明确采用 America/Los_Angeles，与 Lead 确认的业务时区一致；测试固定 Z/offset 输入并覆盖 DST 日期，不能依赖宿主时区。
- 日历真值以 calendar-ruling.md 为准：business 2026-09-14T00:00:00-07:00 到期；school 同日 09:00 reset 时 business 第一；school reset 更早时 school 第一；同刻按名字。
- 生产配置修改与 monitor 重启仍由 Lead/QA 在交付后执行。
- Lead 要求重新注册设计评审，最多 R3。

## R3 技术修订（仅 R2 HIGH，Lead 明确授权）

权威答复：f3791d2b-87f6-40e6-a30c-33a51d8bed7a（2026-09-11）。采纳唯一 HIGH retirement-reuses-quota-trigger-fabricates-resetat，授权修改 pinned plan 并注册 R3。

- 使用既有 account_dead trigger 承载到期切换；显式标记 reason=retirement，贯穿决策日志、不可用标记、成功回执以及失败/无候选说明，使 scheduled retirement 与 reactive account death 可区分。只增加原因信息，不新增 trigger kind。
- 复用 handleAccountDead 的 candidate 验证、CAS/机器权威、安全排除、成功去重与失败/no-target 路径；不把退休时间写入 quotaExhaustedUntil、switchCooldownUntil、weeklyResetAt，不捏造 quota reset。
- 遵循 Lead 的 revive 裁定：revive 窗口仅在 retiresAt 之前有效；到期切换沿 account_dead 既有行为清空 reviveEpoch，不创建过去的或伪造 reset 的 epoch。对来源账号设置了 retiresAt 的既有 revive 窗口，将有效期限限制在该退休时刻内。
- 测试需证明退休切换使用 account_dead + reason=retirement，原始 weeklyResetAt/额度观测不被退休时刻覆盖、无伪造 quota scope/resetAt，过期后没有有效 revive epoch。
- R2 MEDIUM/LOW advisory 保存在 design-review-r2.json，不作为本轮扩展范围。宿主验证范围遵循 Lead 交接指令：定向测试 + lint/build，全量由精确头 CI 验证。

## Follow-ups（Lead 指定不在本任务实现、不开新单）

- earliestReset 对 retired 账号的建议文案。
- lock-respecting 配置 setter/脚本配方。
- retired sweep 跳过。
- scheduled retirement 与 reactive canceled 的优先级说明扩展。

以上不扩展本轮实现；现有排除守卫继续独立生效。

## R4 技术修订（仅 R3 HIGH，Lead 明确授权）

权威答复：1627fcd3-7344-4934-973c-f29ac816d568（2026-09-11）。Lead 授权针对 findingKey=retirement-recheck-loop-unthrottled 修订 pinned plan，并准许 R4 最终确认轮；R4 后不再注册 R5，新 LOW/MEDIUM 留作 follow-up，新 BLOCKER 原文报 Lead。

- 首次可信 expired 观测立即尝试 account_dead + reason=retirement，绕过 usage due/backoff，不等待下一次 usage 轮询。
- 已持久化的同一活动账号退休 deadAccountEpisode（实际状态值 no_account/failed，对应 no-target/switch_failed）只在现有 nextUsageDueAt 到期时再次调用候选扫描及切换；每次尝试用现有 pollIntervalMs 推进 nextUsageDueAt。不能因每分钟的 pane pass 再次全池扫描。
- retry 复用首次退休 unavailable 标记，保留原 markedAt；不新增 monitor state 字段或 schema，不把 retirement 写入 quota reset/cooldown 字段。
- early snapshot 放在 local_scan 提前返回之前；未决 authority 在非 usage pass 继续现有 local_scan 路径，不执行退休切号；usage due 时保留现有 authority 冲突处理。退休首次检查仍在 credential/usage/backoff 提前返回之前。
- warning 不路由 founder；通过既有 alert 收据以账号+retirement signature 去重，不新增 QuotaMonitorState schema。
- TDD 必须覆盖：首次到期即使 nextUsageDueAt/backoff 在未来也尝试；连续 +60 秒 pass 不重复候选 probe/observation/切换写入；持久化状态重读后同样节流；nextUsageDueAt 到期后恢复重试；retry 保留首次 unavailable.markedAt。

此修订只解决新暴露的 HIGH，不扩展原有 advisory 范围；其他锁定需求继续有效。
