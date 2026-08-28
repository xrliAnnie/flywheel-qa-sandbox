# FLY-2111 重构 pane-SHA 接力证据 — 探索
Issue: FLY-2111 (https://linear.app/geoforge3d/issue/FLY-2111/返工2080-runner-patrol-rules-的-pane-sha-段落触发-fable-5-safeguardreasoning)
日期: 2026-08-27
基于: 无

## 问题与已知因果

FLY-2080 在 `runner-patrol-rules.md` 的 receipt/replacement 止血配方中加入了同一操作形状：修复前完整抓取目标 Runner pane 的全部 scrollback 并计算 SHA-256，修复后再次做同样操作，再把前后哈希差异作为 Bridge 已接力的替代证据。部署后，同一 204KB 提示词包在 Opus 上全天无拦截，而切到 Fable 5 后可触发 `Details: [reasoning_extraction]`；Founder 对 Honey Lemon 的单变量换模实验在首条请求即复现。因此本单把“提示词包常量 + Fable 5”视为已定的触发组合，不再把消息内容、个人历史或流量当主因。

分类器内部判据仍是黑盒。已知的是相关性和可复现的模型差异，不知道究竟是哪一个单词触发；所以不能用换词、改变量名或只删 `SHA` 字样冒充修复，必须替换整段证据取得方式。

## 必须保留的产品行为

FLY-2080 的目的不变：Lead 修复漏账后不能只以 SQL 成功为结论，必须留下可审计证据，证明 Bridge/dispatcher 已真正继续推进。新合同需要同时满足：

1. 优先使用 StateStore 已有的 `workflow_run_event` 单调 `seq` 与 `kind` 作为事务后接力证据，并排除所有 `patrol:%` repair receipt。
2. 没有新 engine event 时不得靠 repair event 假绿，也不得自动把“暂时没事件”解释成失败。
3. pane 在 FLY-2080 repair appendix 中只保留两个窄用途：事务前可参与证明 actor 已完成 rework 的反伪造 precondition；无新 event 时用于事务后诊断。两者都只读取所需的有界可见片段并记录稳定状态标记；不抓全 scrollback、不建立输出指纹、不做前后哈希比较。
4. `fixed|advanced` 仍要求真实接力；只有数据库行变化不得过门。

## 最小改动边界

按 Ponytail 决策梯，任务明确要求修复，不能跳过；Markdown 规则本身没有可复用的 runtime API 或依赖可替代这项编辑。最小正确范围是：

- 重构 `runner-patrol-rules.md` 中 FLY-2080 步骤 A 与两个附录共用的接力验证段落；
- 增加内容契约测试，禁止旧 pane-SHA 形状回流，并钉住 event-first 与有界 pane fallback；
- 不改 STEP 2 的整机巡检检测面、六步报告、修复事务、快照脚本、Bridge runtime 或 patrol cadence。

## 假设与待验证点

- 假设 `workflow_run_event` 在两个止血配方对应的正常 reconcile/dispatch/complete 路径上会推进；当前规则已用该表做 baseline，应从源码与既有测试确认其语义。
- 假设 pane fallback 只需证明一个可识别的当前状态变化，不需要保存原始输出；应选择不会把 secret 写入报告的稳定标记。
- 本 PR 无法完成部署后的概率验收；`Fable + Tadashi >=100 mailbox messages, reasoning_extraction=0` 与 CoS 阴性对照必须作为 post-deploy 验收明确保留，不能被静态测试替代。

## 会过期的结论

| 结论 | as-of | 失效条件 | 重核命令/证据 |
|---|---|---|---|
| 旧形状位于 FLY-2080 receipt/replacement 接力验证段 | 2026-08-27 `HEAD` | 规则文件再次重排或上游改写 | `rg -n "BEFORE_PANE_SHA|AFTER_PANE_SHA|pane hash|full-scrollback state hash" packages/teamlead/lead-rules-base/runner-patrol-rules.md` |
| 当前实现同时接受非 repair event 或 pane hash 变化 | 2026-08-27 `HEAD` | 接力 gate 被其他 PR 修改 | `git log -S 'AFTER_PANE_SHA' -- packages/teamlead/lead-rules-base/runner-patrol-rules.md` 后重读命中提交 |
| Fable 的 100-message 验收尚未发生 | 2026-08-27 pre-deploy | PR 部署且完成观测 | 以 Lead/Founder 留存的 mailbox 计数与 `reasoning_extraction` 错误记录为准 |
