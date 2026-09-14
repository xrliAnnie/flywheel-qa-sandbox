# FLY-2533 快照阶段协议 — 协议条款迁移
Issue: FLY-2533 (https://linear.app/geoforge3d/issue/FLY-2533/病根-非-work-kind-项目起-runner-不带-taskcategory-409-dag-entry-not)
日期: 2026-09-13
基于: plan.md

人工首次迁移；后续只维护 packages/teamlead/phase-protocols/*.md，生成器只替换精确配对托管块。下面逐项列出删除的旧平台条款及唯一源。未列出的原字节（包含 frontmatter、领域步骤、变体工作法和工具命令）完整保留。

| 原节点文件与条款 | 唯一来源 / 保留依据 |
| --- | --- |
| `.flywheel/agents/nodes/eng_design.md` — 3. Produce the DOC-FLOW | `packages/teamlead/phase-protocols/design.md` |
| `.flywheel/agents/nodes/eng_design.md` — 5. Run the required design-review | `packages/teamlead/phase-protocols/design.md` |
| `.flywheel/agents/nodes/eng_design.md` — 6. Commit and push | `packages/teamlead/phase-protocols/design.md` |
| `.flywheel/agents/nodes/eng_design.md` — - Do not write implementation | `packages/teamlead/phase-protocols/design.md` |
| `.flywheel/agents/nodes/eng_design.md` — - Do not dispatch implement | `packages/teamlead/phase-protocols/design.md` |
| `.flywheel/agents/nodes/implement.md` — 2. Use strict TDD | `packages/teamlead/phase-protocols/implement.md` |
| `.flywheel/agents/nodes/implement.md` — - Do not modify the approved plan | `packages/teamlead/phase-protocols/implement.md` |
| `.flywheel/agents/nodes/implement.md` — - Do not dispatch QA | `packages/teamlead/phase-protocols/implement.md` |
| `.flywheel/agents/nodes/qa.md` — Reporting: DAG credential, exact qa-result, accepted-verdict epilogue | `packages/teamlead/phase-protocols/qa.md` |
| `.flywheel/agents/nodes/qa.md` — Ordering: DAG ship-report before PASS and injected epilogue | `packages/teamlead/phase-protocols/qa.md` |
| `.flywheel/agents/nodes/general.md` — Reporting: Lead structured report transport | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.bare.md` — - Report your pipeline stage | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.bare.md` — - For code changes: TDD | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.bare.md` — - For plan / design files: trigger | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.bare.md` — - For PR creation: trigger | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.matt.md` — - Report your pipeline stage | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.matt.md` — - For code changes: TDD | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.matt.md` — - For plan / design files: trigger | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/general.matt.md` — - For PR creation: trigger | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/pm.md` — Reporting: exact Lead DONE transport and acknowledgement | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/product_design.md` — Reporting: exact Lead DONE transport and acknowledgement | `packages/teamlead/phase-protocols/generic.md` |
| `.flywheel/agents/nodes/proto.md` — Reporting: exact Lead DONE transport and acknowledgement | `packages/teamlead/phase-protocols/generic.md` |

原有 generic 变体把 bare stage change 写成自动 review；该平台段统一迁移为 injected explicit request flow，保留所有 review 要求，去除 vendor 假设。QA 的旧命令样例由精确动态 qa-result 接替，凭据、target 身份与 PASS ordering 保留。

保留清单：eng_design 的审计/输入安全/迁移回滚/技术同步；implement 的 pnpm 全仓验证、codex:rescue、milestone 最后一提交、禁止改 CLAUDE.md、安全与部署；qa 的 529 全文、浏览器方法、手动报告、ship HTML 模板/父 issue/发布检查/失败诚实报告；general 的职责选择与部署；bare 的 Flywheel Native、matt 的 Matt-Skills RPC 各自完整工作法；pm 的五步 PRD、product_design 的 mockup 与阶段上下文、proto 的可行性与 founder 决策循环均保持。

平台和领域仍可能提同一主题，但 canonical 正文只存在一个托管块，新快照只前置一次该正文。正文去重不是删除领域约束。新增 review 协议来自批准计划，现有九个兼容文件均不是 review 类型。

完整 prompt 配对检查发现 general/Claude 初稿超过 10%（5746 / 4781 UTF-16 units）。仅合并 generic 协议重复表达，不增加 padding、不删除领域文字：

| 精简后的句段 | 保留语义 |
| --- | --- |
| pinned scope, capabilities and output contract | 当前有界职责、服务器能力和输出合同 |
| acquire TURN before shared writes | 获得 TURN 后才改共享工作树 |
| execution/activation identities and credentials | 不丢执行/activation 身份或凭据 |
| exact injected commands: structured output then completion | 精确命令、先结构化交付再指定完成路线；口头不是回执 |
| report stage transitions; explicit design/code review requests | 阶段报告和显式评审请求；裸 stage change 不构成评审 |
| acknowledge Lead instructions via flywheel-comm ask --report DONE, never stock messages | Lead 指令确认和精确 DONE 报告渠道 |
| Code: TDD; PR only if required; no-code only if authorized conditions hold | 原 TDD；按当前执行合同选择 PR 或满足授权条件的 no-code 路线 |
| No QA/ship authority from this role; never dispatch successors | 通用角色不推导 QA/ship 授权，不自行派后继 |

该规范正文 574 ASCII 字节；最终完整 prompt 比率由配对 Blueprint/adapter 测试记录。

CI 兼容修复保留字面 `flywheel-comm ask --report` 报告通道；生成器将清单明示为 `{ role, type }` 记录，避免把正式 workflow type 误判成退役角色别名。固定映射和投影内容不变，不修改扫描器或豁免名单。
