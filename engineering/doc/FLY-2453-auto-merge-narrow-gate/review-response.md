# FLY-2453 自动合并窄口开关 — 调研（设计评审回应）
Issue: FLY-2453 (https://linear.app/geoforge3d/issue/FLY-2453/2309b45-自动合并窄口开关founder-一句现在放开-现在停止切换开着时同时过三道闸机器判纯文档-人声明-pure-docs)
日期: 2026-09-08
基于: plan.md

Review request: b8d80933-9ec5-452b-9853-737cd8bc638f / round 1
Effective verdict: CHANGES_REQUESTED；本回应不代表评审已通过，修订版必须新开gate和request-review。

## HIGH · gate2-is-lead-bot-not-human

已修正计划、HTML、Mermaid、探索与R1增补文本：Lead提交的代理声明不是独立人类检查。Lead c231bc31确认复用2398入口；治理是否settled由review-ruling系统决定，不由本文宣称。

## HIGH · open-phrase-strips-question-mark

已修正§4：不剥离全/半角问号，含问号两条短句均拒绝；C1列明确反例。

## MEDIUM · enum-codec-conflicts-flag-authoring-gate

已修正§4：点名project-scope与enum-codec两处分支；非法写抛错，reader专用wrapper捕获并降级。off fixture与只含两命令的审计事件分开。

## MEDIUM · verification-runs-full-suite-opens-terminal

已移除根pnpm test；§12只列目标包，并显式禁止递归触达真实Terminal.app测试。

## MEDIUM · off-mode-unreachable-no-mute-path

保留Lead5265bccc及c231bc31两次确认的范围：off仅维护/台架，本轮无生产聊天/Lead切换入口。页面明示停止后意见继续；若需生产静音另由founder给控制语义。作为非阻断取舍报Lead。

## MEDIUM · shadow-isolation-contract-silently-repealed

已修正C4：重命名测试及describe/CI引用，正式记录Lead declaration唯一窄口授权例外；观察/意见/统计无授权与通用land边界继续有精确负例。

## MEDIUM · nested-cross-db-write-lock

已修正§6/C2：两连接同步边界临时busy_timeout=0，finally恢复；任一busy释放锁且停止本轮，下tick重试；200ms轮预算，独立进程持锁验收，要求完整反向锁序审计。

## MEDIUM · rework-block-not-carried-to-next-head

保留issue明确的同仓同head粒度；§1/§7及HTML直接说明修正后的新head可重过三闸，明确未选择整PR永久退出。作为非阻断取舍报Lead。

## LOW · precision-metric-decays-once-auto-on

已增加样本日期范围、最近eligible人工对照时间/年龄；7天无新对照标历史样本，非近期验证。仅展示提示，不改指标/闸门。

## LOW · no-max-age-on-founder-control-message

已按Lead c231bc31确认设置stage/apply及最终锁内10分钟年龄检查，边界/过期/未来/旧receipt测试；已开启永不到期，不重放历史开启。

## LOW · existing-bot-reaction-helper-not-reused

已点名复用founder-ack.ts已有PUT @me低层能力，可抽到discord-utils让原调用者共用并补DELETE；保留原行为回归。


# Round 2 修订回应

Review request: 1ba3756a-df58-4385-a55a-928904678989 / round 2；有效结论CHANGES_REQUESTED。以下v4修订覆盖上文R1的双向时效说明，仍需新review通过。

- HIGH `stop-command-expires-after-ten-minutes`：按Lead b19c5f83明确取代旧裁定，只有auto限十分钟，dry_run无墙钟年龄检查，身份/原文/消息顺序不削减；C1钉住15分钟/数小时延迟停止成功与旧stop不覆盖新auto。
- MEDIUM `fly2396-authorship-contract-not-restated`：C4重命名B2边界测试，重写describe/it及CI引用，明确仅人工rework负向否决例外，authorship不能独立正向批准。
- LOW `zero-tolerance-future-timestamp`：auto允许5秒未来偏差，边界有测试；停止不依赖墙钟年龄。
- LOW `opinion-snapshot-columns-missing-from-schema-section`：样本时间三列已回写§5表定义与C0红测，首次migration即完整，不留C3 schema补丁。
- LOW `off-mode-unreachable-no-mute-path`：不改Lead授权范围；页面补明生产暂无关意见开关，静音须修改/回退代码并经updater上线。

# Round 3 有效通过

Review request: fdf2d72e-3e3a-48bb-9e05-ab32add89496 / round 3
Question: 6e04ef27-4ae4-46df-ae18-9f0ba93b83b6
Effective verdict: APPROVED；reviewer verdict: APPROVED；读取于2026-09-09T03:44Z。

以下均为LOW非阻断建议，已通过ask --report交Lead选择后续，未暗改已通过的技术方案：

- `snowflake-timestamp-equality-can-block-stop`：建议停止方向的Discord timestamp/snowflake毫秒差异只审计不拒绝；v4仍保持已评审约束。
- `founder-page-diagrams-unrendered`：可在具备渲染权限的环境补SVG；当前按任务明确的两次失败fallback交付，已报告限制。
- `off-mode-unreachable-no-mute-path`：生产无静音开关的已确认范围，页面已完全披露，评审不要求剩余修改。
