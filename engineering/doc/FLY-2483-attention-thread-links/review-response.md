# FLY-2483 现在要你看 — 调研
Issue: FLY-2483 (https://linear.app/geoforge3d/issue/FLY-2483/进度页e2-现在要你看attention-三路合并-固定四段格式-跳-discord-threaddiscordguild-id)
日期: 2026-09-09
基于: plan.md

## R1 有效结论与处置

reviewVerdict=CHANGES_REQUESTED；reviewerVerdict=CHANGES_REQUESTED。request f40d1d08-c88d-4e53-891b-7afdb2b061d7，question 4b10142c-f64a-44b5-bbd2-4e4d82543554，round 1。

唯一 HIGH dependency-show-breaks-on-null-scope 已采用 reviewer 选项(b)：页面200保留 attention，dependency CLI显式返回 active_scope_not_found，文件与真实文档接线RED/GREEN回归加入C3和目标命令。

MEDIUM/LOW 一并收紧：字节级完整行预算与非假空降级；SQL UTC归一+since.value严格校验；固定动作之后补收件角色；内部身份不泄漏到公开HTML/Markdown；身份补齐失败的临时重复与恢复；refresh outcome明确只表示页面发布；Linear nin官方核对；指名model.RULE_IDS；全项目候选频道查找；blocked-only不新增来源但独立label仍有效；旧年龄语义差异和图形降级显式保留。未修改产品固定词表、没有创造新授权、没有把图/QA未验证写成已完成。

## 服务器 findingKey 清单

- HIGH `dependency-show-breaks-on-null-scope`：snapshot=null 让 `flywheel-comm dependency show` 从可诊断 422 退化成 invalid_response，且计划未把该消费者纳入范围
- MEDIUM `attention-cap-exceeds-document-byte-budget`：三路各 1000 条的上限比文档字节上限高数倍,超限时没有定义降级路径,后果是整页(含现有 Epic 视图)停更
- MEDIUM `node-started-at-not-rfc3339`：`workflow_run_node.started_at` 是 SQLite datetime 格式,直接当 since 会被 JS 按本地时区解析,静默把「已等 N 小时」算错
- MEDIUM `question-source-unscoped-by-recipient`：question 源不按收件人过滤,却给每行贴上「去 thread 里回答它的问题」的 founder 固定文案
- MEDIUM `full-internal-ids-on-hosted-page`：把完整 question/run/node/execution UUID 放进托管文档与 DOM,反转了本 schema 现有的 id8 不透明约定,计划未论证
- MEDIUM `identity-enrichment-failure-splits-rows`：canonical key 依赖 Linear UUID,但 gate/question 侧只有可能是 identifier 的 issue 别名;补齐查询失败时同一单会裂成两行,计划无降级
- MEDIUM `refresh-ledger-loses-scope-missing-signal`：缺范围时 epic_page_refresh 的 outcome 从 structural 令牌翻成 ok:<v>,计划只覆盖了 residual-scan 一个下游
- LOW `linear-comparator-nin-not-notin`：§3.3 写的 `state.type notIn`,Linear StringComparator 的字段名是 `nin`
- LOW `rule-ids-two-symbols`：「扩展 RULE_IDS 加 attention.v1」有歧义:仓里有两个同名符号
- LOW `lead-channel-general-fallback-masks-reason`：§6 说「不能挑第一行」,但要复用的 `resolveLeadForIssue` 在无标签命中时正是静默取第一个 Lead
- LOW `declared-blocked-still-enters-via-label-path`：「排除 declared_blocked/run_held」写在 CommDB reader 上是空操作;真正的入口是 founder-review 标签路
- LOW `age-clamp-semantics-diverge`：同一页上两套年龄语义:attention 禁止把负数夹成 0,现有 relativeTime 却夹
- LOW `founder-html-diagrams-unrendered`：founder 面向的 HTML 带着两处 DIAGRAM PENDING LOCAL RENDER 交付,而 §2 把这两张图定为数据流/模型的图源

以上处置须经新门的新review重新判断；此文件不是自批记录。

## R2 有效 APPROVED 与三项精度修订

request 6a6d9c11-18bd-4eb4-97e2-5f5dfd681c9a，question c6cef5ae-bcff-42ae-b1e4-93e44eee6b59，round 2；effective/reviewer 均 APPROVED，HIGH=0。已向实际Lead relay三项advisories。

- recipient-kind-not-in-projection-view：本轮已改plan SQL为mailbox基表、response.ref_id；明确不改projection版本或重跑一次性迁移。
- derived-cells-not-in-receipt-walker：收件角色是mailbox原始Cell，仅mailbox来源必填；来源回执只收原始叶子，budget等derived格不保存为source。
- scope-missing-reason-unspecified：生成端整组统一epic_scope_unavailable；CLI明确比较该literal。

这三处仅修正已批准范围内的查询/出处/缺失值合同；仍会注册R3以固定最终计划评审结果。HTML用户含义未改变，无需重生成或重复评论测试。

## 最终 R3 有效 APPROVED

- question：8e271f35-aefc-4aeb-8424-cb6e3688eb9c。
- request：8b2d8942-505b-427f-9d16-5078bc3bf48b；round 3。
- reviewVerdict=APPROVED；reviewerVerdict=APPROVED；HIGH=0。
- 最终受评计划提交：721697088；计划正文在此结果后不再修改。
- 剩余一条 MEDIUM advisory `identity-cell-null-on-normal-orphan-rows`：当前identity规则会把普通无绑定orphan与补齐查询故障一起标source_unavailable。建议查询成功但仍未知时保留resolved/unresolved计数，仅真正查询失败使用missing。已通过ask --report转交实际Lead选择后续处置；未把非阻断finding称为已修复，也没有使用作者自批替代治理。
- 有效硬门已通过，按合同继续HTML发布与phase_design_complete；上述advisory仍可作为实现阶段输入。
