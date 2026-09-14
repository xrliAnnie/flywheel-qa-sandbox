# FLY-2399 自动审批判断与学习 — 调研
Issue: FLY-2399 (https://linear.app/geoforge3d/issue/FLY-2399/2309b5-自动合并放手前要改的三条规矩提案交-founder-拍p2-文档单-依赖-b4-结果)
日期: 2026-09-10
基于: exploration.md

## 结论与证据边界

以 `92532e22a` 为本轮代码审计基线。语义意见必须是新协议，不能把旧 `auto_narrow_opinion_snapshot.eligible` 换成模型输出；后者与既有窄口执行器相邻且含历史三闸含义。建议新增独立的判断/学习模块，只在 dry_run 替换可见机器意见，auto 的旧三闸授权路径保持不变。模型失败显示「不可判定」。全部事实输入在 founder 决定前冻结，决定后只追加配对和澄清。

依据：完整派单及 Lead 答复 `732273a7-c56c-43d6-9d1a-ba62f35b1bea`。研究按用户授权自动推进，不把技能通用人工研究确认另开硬门。当前独立 review 尚待注册。相关角色只读并行检查定位、模式与约束；本节点没有运行产品逻辑或改生产状态。

## 当前源代码与拟改消费者

| 入口/消费者 | 当前事实 | 本设计处理 |
|---|---|---|
| `packages/teamlead/src/bridge/auto-narrow-gate.ts:191,222,228` | 刷新意见后，非 auto 返回；auto 才调用 source writer | dry_run 展示交新 reconciler；auto source 逻辑不改 |
| `packages/teamlead/src/StateStore.ts:53446,53586` | 版本化旧意见；候选是已出卡 awaiting_review 的 founder 门 | 新判断从同一有效 holder 源枚举，不把旧意见当三点结果 |
| `StateStore.ts:53505,53542,53546` | `questionId:ordinal` 快照，correlation marker 与投递状态同事务 | 复用事务/序号模式，新表独立命名 |
| `bridge/auto-narrow-opinion-delivery.ts:115,133,202,222,244` | uncertain先找回、generation保护、已有消息编辑 | 新意见/澄清沿用相同发送恢复协议，独立目的与键 |
| `StateStore.ts:53680` | 最终写批准再次检查有效 auto/控制revision | 禁止新模块调用此批准写入方法 |
| `StateStore.ts:4103,4107,4121,57511` | B2只含approved/rework、原作者与source id、精确版本 | 引用原 verdict_id；cancel另存观测，不能伪造B2 |
| `StateStore.ts:57598` | B4在判决事务里写观察，SAVEPOINT隔离失败 | 不用作前瞻预测；失败不挡 founder 决定 |
| `StateStore.ts:53066,53131` | 旧统计按founder_authored与判决前最后快照，不核首次可见时间 | 新统计独立核 visible_at、封存时间和全仓版本 |
| `bridge/approval-signal/subscription-claude-classifier-runner.ts:94` | 订阅Claude子进程，execFile无shell，JSON envelope，默认Haiku，可注入model | 新适配器借鉴进程方式；不直接用Haiku审批分类器判断设计/QA |
| `packages/claude-runner/src/AnthropicLLMClient.ts:7` | 付费API客户端，当前chat无AbortSignal参数 | 不为本单引入API凭据或调用 consent evaluator |
| `packages/config/src/model-config.ts:462` | 中央bindings解析与模型白名单 | 从bindings.opus冻结模型，不新增镜像模型表 |
| `packages/teamlead/src/bridge/founder-consent/evaluator.ts:39` | 现有语义器判断的是是否授权，不是交付质量 | 不共享prompt、缓存、阈值或审核结果 |
| `packages/teamlead/src/epic-page/lead-note.ts:1` | Lead手写判断是另外的展示槽且会变旧 | 三点机器记录放机器事实区，不写入/覆盖Lead note |
| `packages/teamlead/lead-rules-base/founder-only-authority.md:144` | FLY-2453现行窄口是纯文档三闸；语义判断不授权 | 此文件本单零修改；旧auto不因新「可」放宽 |

## 输入与外部边界

1. 有效ship holder给project/run/question/card/thread；显式PR清单给每个repo、PR编号、head完整40位、base。以真实卡和版本为键，不以issue标题、短head、展示标签为键。
2. 读取issue正文、当前被接受的PRD/design及修订、同版本QA报告、全部PR文件清单及diff摘要。链接只是定位符，必须取得内容并哈希；缺失、截断、不可访问应公开为unknown。
3. 无冲突：各仓隔离临时Git对象目录中对当前main执行只读merge-tree；另比同项目在飞PR改动文件（包括改名前后名）。不在共享工作区checkout/reset，不对真实服务运行测试。Git无文本冲突不证明运行语义兼容；同文件交集必须公开。
4. CLI实际 `--help` 本轮核到 `--tools`、`--strict-mcp-config`、`--setting-sources`、`--no-session-persistence`、`--max-budget-usd`。禁插件配置不等于禁工具，新适配器还需显式空工具/MCP、固定系统提示、隔离cwd、最小env与超时kill；QA须用诱导输入证明无工具调用。
5. 所有SQL参数化；库列/排序键只用固定枚举。repo slug、完整SHA、整数PR、路径、消息ID、输入大小在边界校验。仅经现有配置的GitHub/Linear/report artifact源取内容；不fetch模型吐出的URL，不读取任意本地路径。

## 资料与统计

Lead提供：9-09起32次 B4 observation均ship_relevant，s2 satisfied 1/32；9-04起 founder_gate node_completed 102 approved/1 kickback；22个PR为1docs/15普通code/6保护路径code。口径不同（观测、卡动作、PR），不相加、不互作分母，不由批准率推导代码质量。

本轮读取手工JSONL的6条均retro；5approved/1canceled。缺少完整SHA、question、预测时点、可信founder来源。保留为学习例子/导入隔离区，不补造精确字段，不记入前瞻正确率。2107取消暂按产品方向否决，原因为未确认；founder的新回答才可更新澄清层。

受管快照命令 `node /Users/xiaorongli/Dev/flywheel/scripts/flywheel-snapshot-control.mjs runner --source /Users/xiaorongli/.flywheel/teamlead.db --kind teamlead` 返回 `snapshot_owner_unavailable`；未拷活库，也未声称独立重算。Lead确认B4两周表不存在，本单无需等待。

## 外部核实：撤销的准确含义

GitHub 的 revert 操作创建反向PR；冲突可能需要人工处理，不会凭按钮恢复线上运行。[GitHub 官方说明](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/reverting-a-pull-request)。Git revert写新增反向提交，不改写既有历史。[Git 官方文档](https://git-scm.com/docs/git-revert)。推论：Flywheel合并与updater部署分开，反向PR合入仍不等于数据库、已发送消息、外部效果恢复。

按Lead裁定M2本轮不建一键撤销。M3合前继续founder既有批准/打回/取消入口，合后保留反馈出处和现有revert PR后续路径，不假装能取消已合并代码。

## 建议验证重点

- 同一份代码，需求对齐/用例覆盖为pass可给「可」；保护路径不是自动否决条件。
- 缺资料、CLI失败、语义输出伪造引用→不可判定；已知阻碍→不可；已证实偏离/关键失败→建议拒。
- 正面和反面fixture要同时证明，删掉PRD/QA/冲突检查分别让测试失败；禁止全判unknown骗过安全测试。
- founder先决定/意见晚投递、换head、多仓、取消、自动批准、重复消息、重启、不确定投递、私有报告失效、澄清回复不得制造批准均须覆盖。
- 设计阶段只验证文档与HTML；真正模型质量、隔离链路和QA证据由后续阶段执行。


## R2：独立审查补充的当前消费者证据

- `fly2396-authorship-boundary.test.ts`扫描精确五路径，且仅跳过__tests__目录；新增只读outcomes.ts需显式纳入第六路径，禁止改名绕过。测试均改放__tests__。
- `fly-2006-database-retention-sweep.test.ts:542,598`固定143/204（去retired201）；新七表计划改为150/211/208并同步production-tables.json，迁移receipt沿用现表。
- `epic-page-publisher.ts:16,76,97`在渲染前后限512KiB；`founder-budget.test.ts`原60-child限491520B。完整历史改独立普通报告分页，主HTML保留有界预览，不新增CSP读库能力。
- `StateStore.refreshAutoNarrowOpinion`快照与delivery原本同事务；R2明确capture-only保留旧统计样本，新旧sender各用自己消息，不共享message_id。
- 语义模型与机械冲突输入分键，新增独立evaluation表缓存模型结果；main/在飞变化不重烧每卡3次额度。根澄清与答复采用不同id命名空间。

## R3：刷新频率与迁移证据

- R2 gate dc570ade-5cba-43d7-8a21-cf5bc4f5acdf有效CHANGES_REQUESTED。StateStore.ts:53478–53504既有same比较会避免无内容变化的快照/投递，新设计采用相同语义并增加每卡6意见/6 PATCH每滚动小时的硬界限。项目共享快照与请求配额独立于模型额度。
- auto_narrow_opinion_delivery（StateStore.ts:4438）的CHECK只有pending/posting/uncertain/delivered/gone；row mapper在53149附近。R3只增加两个nullable冻结时间列，明确更新row/claim/完成CAS，保留枚举及FK；auto恢复先清冻结再capture，不伪装gone。
- report-registry.stagePublish每次铸新token，Epic仅5秒去抖。R3历史发布独立30分钟限频、内容digest短路、12天TTL续期，主进度页只读上次manifest。
- 为持久化项目共享快照/请求配额/历史轮次，新增第八张project_state表；R3取代上节R2七表计数：基线143/204/201改151/212/209，迁移receipt沿用既有表。
