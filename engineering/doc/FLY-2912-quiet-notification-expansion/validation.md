# FLY-2912 设计交付核验 — 调研
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912)
日期: 2026-09-25
基于: plan.md

- 只完成设计；未修改 packages 或 scripts 的生产实现、未启动/重启服务、未执行实现测试。
- 基线 801ac86cb；FLY-2904 PR #1340 的 d4410e7e1 recommendations.json 已读取：r9 obs=1219587447，明确“其中一部分带着真实待办，不能吞”。本单不拿此估算当节省验收。
- Lead 指定窗口已冻结：257 lead_events、80匹配 session_events、206 mailbox；清单与 SHA 在 evidence/evening-manifest-v2.json。原始私有数据保存在 /Users/xiaorongli/.flywheel/artifacts/FLY-2912，非 memory；没有 live DB 拷贝或持有未关闭连接。
- 两张 Mermaid 本地渲染均失败，均已按标准 flags 重试；错误见 evidence/diagram-render.json。HTML 使用指定 DIAGRAM PENDING LOCAL RENDER，源文件保留，没有远程渲染和伪造图。
- verify-founder-html.mjs：7节均有评论输入，自动保存以 pathname 隔离；长意见4段均带精确首行标记；clipboard成功/缺失/Promise拒绝均验证；storage异常安全；输入HTML不执行。零外部依赖，单一 nonce placeholder script、无 inline handlers、无作者 CSP。
- Chrome DevTools list_pages 可读，但 new_page 被工具策略拒绝：MCP tool call requires approval, but approval policy is never。因此视觉浏览器与真实 CSP 下 JS 执行未验证，happy-dom controller检查不能冒充 browser QA。
- 设计评审已显式注册：question cf1b3c2f-9d24-47a0-90c1-d2731ed7643f / request 163c3b8a-a446-4612-8b25-84c665d14e5f。pending 不是批准。
- 发布尚未执行：等待有效 APPROVED 后静默发布与 hosted fetch/CSP 核验。

## 冻结样本复核
全部3份私有输入SHA和行数吻合。257条Lead事件的项目范围已核对；7条不含project_name的升级事件通过exact workflow run绑定确认属于flywheel。18条model阶段分布为code_review 8、design_review 3、pr_created 7；12条model监控恢复全部为ship_parked。它们仍须按历史待办凭证分类，不能把park状态当作无待办证明。细目见evidence/baseline-classification.json。

## R1 修订与R2审查
R1有效verdict=CHANGES_REQUESTED，唯一HIGH为生产DirectEventSink入口漏查。计划revision2在§11.1/T3/T6补齐，并处理关联MEDIUM证据/时序问题；未实现生产代码。R1完整收据在evidence/review-round1.json。新请求52e0e9a4-a162-442d-a558-705bd631eef4 / question aaceefb4-073f-4544-a93f-12c52fda24c4已accepted，尚无批准。

补充证据manifest v3保留21条DirectEventSink原启动事件（它们的random source ID不同于direct通知ID）、21条派发账、22条execution binding、191条带时间的workflow事件。本机当前派发账无purpose列，checkout源码有该列及历史backfill；不能从listWorkflowSideEffects的缺省initial或升级默认值反推9-25事件的来源。mutable当前ledger状态不作历史发生时的状态。回放须锁实际部署build，不能把本分支base SHA冒充当晚生产carrier；证据缺项如实保留，不缩样本。这是实施回放仍需解决的证据约束，不是已得改后对比。
