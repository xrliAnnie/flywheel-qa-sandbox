# FLY-2788 节点模型分流 — 调研
Issue: FLY-2788 (https://linear.app/geoforge3d/issue/FLY-2788/2787-a分流引擎-每个节点按定稿选模型设计三组-astraopus-55fable-51-各-13实现-opus-55qa-gpt-6)
日期: 2026-09-22
基于: exploration.md

## 结论
当前代码有完整的不可变派发记录基础；扩展策略及其全部校验器，比新增存储/分流服务更小。最大的漏点是非菜单入口和重放消费，不是哈希公式。
本次只读基线 32df6c2ee；2026-09-22 PDT fetch 看到 origin/main beeaa7410。FLY-2766 PR #1286 OPEN；FLY-2775 本地分支实施中。实现合入前必须包含两者已合入提交，再处理同文件冲突；当前不能宣称新模型生产可用。

## 证据矩阵
| 位置 | 当前事实 | 设计动作 |
|---|---|---|
| packages/config/src/model-split.ts:1–103 | 仅 astra/fable；issueNumber-only SHA；版本来自内容 | 新增独立规则；旧算法逐字保留 |
| packages/config/src/model-config.ts:133–139,201–242 | 配置只读 models/bindings/tiers/modelSplit；无 phases；无效 split 有 invalid 状态 | 扩展 union 和边界验证；不恢复 phases 解析 |
| .flywheel/agents/registry.yaml:60 起 | code 设计/实现缺 opus；QA 缺 Sol；产品单节点已默认 opus | 补候选、改实现默认、QA 默认设 Sol，与新策略同源 |
| packages/teamlead/src/workflow-menu.ts:766–856 | scopedSplit 仅 code.eng_design 且依赖 node.modelSplit；选择后校验候选 | 新规则显式覆盖 design/qa；保留 legacy 分支 |
| workflow-menu.ts:872–883 | 同厂商 QA 必须显式 sanctioned | 两种入口实现 Lead 指定的 QA Opus 组窄豁免；不扩大通用开关 |
| workflow-template-selection.ts:95–107 | 非菜单自动入口会调用 resolveMenuOverrides，但没传同厂商开关 | 补节点组凭据与窄豁免，并合并全部节点默认/选组结果 |
| workflow-template-selection.ts:111–149 | reservation 重放仅认识旧规则与设计事件名 | 新规则加入重放；不读当前策略重算 |
| packages/teamlead/src/StateStore.ts:35384–35415 | materialization 再验证 assignment 身份/模型/规则 | 增加新规则验证；不能仅扩展 parser |
| StateStore.ts:35611–35621 | 同事务写 design_model_arm_assigned 事件 | 复用事件结构与 node_id；历史名称保留 |
| workflow-model-assignment.ts:8–41 | 旧百分比凭据按冻结 basis 复算 | 新凭据验证 identity、node、weights、bucket、arm、model |
| workflow-dispatch-resolution.ts:23–61,110–120 | launch 重放验证 assignment；dispatchPinned 优先 | 新规则被承认；所有目标节点自动选择都要 pin |
| workflow-run-snapshot.ts:510–520 | override 转为 frozen dispatch / dispatchPinned | 复用，不新增启动时覆盖层 |
| scripts/design-model-split.mjs | show/set 仅理解二臂，set 可以覆盖整段 modelSplit | 识别新格式；旧 set 遇新格式拒绝，避免擦掉 QA 策略 |

上述无前缀路径均在 packages/teamlead/src/。源码检索覆盖 packages 与 scripts 的非测试 TS/JS/MJS；phases 命中只有无关生命周期、测试保留未知键和清理过期 dist 的构建脚本。FLY-2769 产品定义对死键的观察与源码一致，FLY-2779 的“会盖掉两臂”在当前基线不成立。

## 外部决策与依赖
- FLY-2779 的厂商定价/能力比较已定稿，本单不重评价格、排行或新模型能力。
- FLY-2775 plan：opus 家族绑定到 claude-opus-5-5，并保留历史具体模型可重放。
- FLY-2766 当前分支新增 CODEX_SOL=gpt-6-sol；不得把旧 codex=gpt-5.6-sol 当成 GPT-6 Sol。本单提供 sol 家族入口映射到该已注册身份；不改变 codex 历史含义。
- FLY-2769 最新 founder-review（ccc7567bb）明确：人工选模型可超出自动候选，持续至撤销，家族名跟最新版；本单不实现该 UI/持久控制面。
- 项目内无找到独立 html-report-style 文件；采用明确指定的 Apple-light、系统字体、无外链。diagram-design 使用 Mermaid 本地 SVG，按本单强制格式优先。

## 验证边界
现在获得的是源码证据，不是生产验收。后续必须提交 ≥30 张隔离模拟单的计数、3 次重派/返工/拉起、设计×QA 列联表、真实隔离实现/QA pane 模型与 run/runtime 字段，以及移除候选的失败证据。

## Lead 决策同步
2026-09-22 PDT，Lead 答复禁止用全局 review_same_family_allowed 满足本任务；只给 QA Opus 臂节点级豁免，代码复审仍跨家族。成绩读取由 FLY-2789 负责，现有 receipt 扩展 runId/nodeId/policyVersion/arm/resolvedModel/assignedAt。详见 plan §3.3。

## 实现 75/25 修订的补充取证
- `bridge/codex-quota-store.ts:1416/1464`：recordPoolExhausted 写权威容量事实；hasCurrentCapacityGuard 复核最近未恢复事实。
- `codex-quota/candidate-selector.ts:81–166`：三个槽位观测必须新鲜、身份/认证/范围/窗口完整且全部耗尽；一般暂停不等于全灭。
- `StateStore.ts:44163/44182`：immutable runtime 与审计事件的同事务写入边界，可用于冻结实际降级模型。
- `workflow-engine-dispatcher.ts:2272/2828` 与 `run-dispatcher.ts:1527`：现有多种暂停不能一概靠改 vendor 绕过，只有容量原因可被有证据的降级解开。
- 最新策略为设计三组均分、实现 Opus75/Sol25、QA Sol75/Opus25。上文“QA Opus 唯一特例”是先前裁定，现被对称 QA Sol 特例扩展；正式实施合同以 plan §3.3/3.4 为准。

最新覆盖裁定：[lead-instruction cc848d61-245f-4dd0-a00b-1c2e317ec249]：QA 节点整体允许同家族，仍由服务端验证/审计；design/code review 按实际作者家族动态跨家族，不接受全局开关替代。此前逐臂特例已被取代，正式规则见 plan §3.3/Q11。
