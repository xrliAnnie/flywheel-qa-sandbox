# FLY-2654 Lead 有条件自决 — 探索
Issue: FLY-2654 (https://linear.app/geoforge3d/issue/FLY-2654/规则放权-founder-2026-09-16-2249z以后怎么样可以避免我来授权你就自己做决定把raya)
日期: 2026-09-20
基于: 无

## 2026-09-20 当前有效结论

最新 Lead 回复（问题 5ac555cf-0161-4373-a403-2d7a35238017）要求保留 founder“不再逐次授权”目标：禁用条件消息授权解析，但以两项带 a/b/c、审计和独立 activation 的 standing carve-out 替代，只有前提缺失才回原授权路径。Raya 正常合入后下一班车自动带上，不解析任何消息。当前精确方案见 plan.md；旧 Part B 关闭和现有代码保留。

本轮源码确认 R1 仍保留逐 SHA canonical_line，R4 当前仅接受当下指令，updater 已有成功 urgent 后 Raya pass；这些是待增量对齐的实际消费者。Codex lead-turn-evidence 仅 model/effort 证据，不能冒称已证明规则加载。新 activation verifier/独立确认/不可变执行包尚未存在，本计划明确列为实施任务，不能以静态设计替代上线证据。

下方探索/调研已被后续裁定替代，整体保留为历史，不是当前设计规范。

`````text

最新状态：Lead 指令 ec106d4d-6c4b-4507-a164-73bcef60a2e3 确认 founder 20:29Z 拍板 FLY-2679 迁仓；Part B 已关闭并由该 Epic 取代，历史原文保留。

## 当前范围更正（优先于下方历史探索/研究）
Lead 于问题 3262d907-45d1-446c-9fcf-7edc13d3073b、4c50f935-1aec-489b-868f-ee050a68ceab 连续裁定：本次 Part A 仅做 R4 条件式 founder per-instance 指令的 reading guide + 真实 Lead 归因与审计，不新增 standing 权限或 activation。原 Raya 与三条件收尾 standing 方案完整保留在 plan.md Part B，暂停等待 founder 架构决定。下方技术审计为历史证据，不是当前启用范围。


## 目标与已选方向
让 founder 不再因为 Raya main 前进重复发逐 SHA 授权行，也不再为符合既定收尾意图的紧急重启逐票确认。Lead 在两个明确例外内自行判断、事前留证、事后对账；生产部署仍由独立 updater 完成。

本节点仅设计；当前 TURN 为 design epoch=1，execution `5dfe3ccb-3e4e-49c2-8dcf-36d31705bc98`，workflow run `8bc20a0d-345f-431a-b686-eeb058d4dd6e`。不修改生效规则、不执行切换或重启、不派发后继、不申请 ship。

## 原始输入与证据等级
- 本次派发给出 2026-09-16 22:49Z founder 原话：“以后怎么样可以避免我来授权呢？你就自己做决定就好了，不要再等我授权了。怎么样，这样做？”以及“那你现在马上紧急重启可以吗？”。这是修订动机，并非已经满足 AUTH-CANON 的新条目生效证明。
- 派发称 9-15/9-16 两次已授权 Raya 切换；未附原始消息 id、认证作者、内容摘要。设计不得编造这些值，也不得自动把历史 per-instance 许可升格为 standing 权限。
- 2026-09-16 17:30Z “不开新活 / 只记账等派”已被后来指令撤销。已实时重读 Linear（updatedAt=2026-09-17T19:45:34.231Z），目标为“Raya 仓代码合入 main → 下一班车自动带上，与其他项目一样，不再有任何逐次授权步骤”。Lead 在问题 `85a1da6b-fd36-4aff-ba1e-2178bb7b0e73` 确认本次正式派发、最小消费者适配，并提供 2026-09-17 19:42:16Z 消息 `1550230431658541137`（频道 `1516209714097291335`）。9-16 精确消息 id 仍待 Lead 从 Discord 取回，不编造。

## 范围
1. R1 中 Raya carrier 切换段：一次 standing carve-out，目标由工具从合入后的真实 origin/main 选择；quiet15m 与停机窗口人类消息逐条对账保留。
2. R4：当日明确重启意图 + 全部受影响在飞体可重铸（或 founder 明确接受重铸损失）+ 发票前 #engineer 播报，Lead 可发既有紧急票。
3. AUTH-CANON(B) 加两个精确定义的候选例外、统一 activation manifest。只有证据齐全且独立确认才激活；R3 祖父条款不可借用。
4. 为实际消费者列出最小配套改动，避免只改文案而工具仍拒绝，或以 founder 名义记录 Lead 判断。

## 不变边界
R1 merge/ship 主体、读收据例外、R2、R3、R5 registry 与授权原则均不改。merge 不触发 deploy；禁止 launchctl submit、直接 restart-services、新 wrapper/调度器。操作系统重启不由 request-restart.sh 执行；“重启电脑”仅可作为收尾重启意图来源，绝不新增关机或 reboot 权限。

## 方案比较
| 方案 | 结果 | 决定 |
|---|---|---|
| 只删规则中的 founder 字样 | 初始化和班车仍核对旧授权行；紧急票仍虚记 founder | 拒绝 |
| 所有 merge 自动重启、所有 main 更新可随时改进行中账本 | 扩大权限，可能混用旧构建/新 SHA，破坏停机证据 | 拒绝 |
| 两个有条件例外 + 精确激活 + 现有消费者适配 | 达到少打扰目标，保留部署/身份/审计边界 | 选定 |
| 建通用授权平台并重做 R5 | 超出本单；没有必要 | 拒绝 |

## 必须在计划中说清
- entryId / entryDigest 是永久条目身份，不用中文显示名当主键。
- policy activation、Raya 运行 activation、一次 restart wave 是三种不同身份，不能混用。
- origin/main 自动刷新只发生在尚未停旧体的安全边界；已开始停机后冻结目标并完成/回滚本轮，下一轮再追 main。
- “当日”使用 founder-local-time.md 与 resolveFounderTimezone() 的当前权威时区日历日，不写死 LA；到午夜、时区或范围变更重新检查。
- 可重铸以 pushed head 与持久化复审/QA 判决及保存位置证明；排除仅模型自述、进程状态、运输 ACK。
- 设计评审 APPROVED 不是生产 activation APPROVED；真实落地 commit 和运行加载回执只能在实施/部署后取得。

## Lead 已裁定的批准面
精确条目批准来自 founder 对包含逐字条款的 PR 精确头按 ship 卡，manifest 绑定条目 digest、该 gate/消息、合同落地 commit、执行代码部署 commit 和 live bundle 回执。独立 confirmer 提名 flywheel-cos-lead（Aunt Cass），不是实现者或本单 Engineering Lead；最终身份以 founder 在卡上的批准为准。方向性消息和设计评审均不替代 activation。
`````
