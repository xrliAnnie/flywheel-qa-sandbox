# FLY-2914 病根排修闭环 — 调研
Issue: FLY-2914 (https://linear.app/geoforge3d/issue/FLY-2914/巡检闭环-6-巡检每轮自动列出病根类别出现-3-次且没有修复单在跑-lead-必须呈报-founder-排修让巡检发现的问题变成自动机制)
日期: 2026-09-25
基于: exploration.md

## 结论
已有快照和 FINDING 门可以承载本功能，但必须同时覆盖传统 shell Lead 和 Codex 的 Bridge helper。不能只改 runbook，不能直接调用 active-scope 的显示投影，也不能用 node_dwell_review 假造一个 run。新增路径只读 Linear，排修处置不计为新病根发生事件。

## 只读现状盘点
`live-census.json` 保存此次完整筛选事实。Linear 观测为 2026-09-26T05:32:26Z（本地 9-25）；3 页共 210 张直接子单。标题尾部或独立正文计数 ≥3 且非 completed/canceled 的 60 张，扣除 active run 的 3 张后为 57 张。

- FLY-2373 已有 run `110e738b-87ff-4332-91a4-a29be96018be`，状态 active；标题 34，正文 31。因此当前 live 验收应显示“因 active run 排除”，保留无 run 的 fixture 验证入选，不能为了迎合旧例子强行列入。
- 另外排除 FLY-2891、FLY-2906；库中 `workflow_run.issue_id` 当前保存 identifier（例如 FLY-2373），不是 Linear UUID。
- 入选计数差异：FLY-2371 14/13，FLY-2344 8/7，FLY-2098 3/2。
- FLY-2120、FLY-2613 入选但缺 class_key；必须显示结构异常并以原 issue UUID 暂时保持精确身份，不能丢项或猜同类。
- 此为只读设计盘点，不是新快照实现或生产功能验收。Linear 原始数据临时存 `/tmp/FLY-2914-linear-children.json`，提交产物仅含所需投影、不含凭据。
- worktree 的 snapshot helper 缺编译产物；生产 checkout helper 返回 snapshot_owner_unavailable。未复制数据库。改用 Python SQLite `mode=ro` 的限定 SELECT 读取 active run，随后关闭连接；没有更新生产数据。

## 实际消费者与接点
| 路径 | 已确认行为 / 对设计的影响 |
|---|---|
| scripts/converge-flywheel-bin.sh:386 | 安装 flywheel-patrol-snapshot 为 shell 脚本入口；新增编译 helper 需被安装/发布包含 |
| scripts/lead-patrol-snapshot.sh:1906 | 单份报告六个 numeric STEP + DWELL；放 STEP 6 子段，不加 STEP 7 |
| packages/teamlead/src/lead-capabilities/handlers/bridge-read.ts:171 | Codex broker 调用 Bridge；模型输入不得提供候选事实 |
| packages/teamlead/src/bridge/lead-capability-read.ts:375 | 同一 snapshot/judgment 路由；已持有 StateStore、linearClient、receipt store |
| packages/teamlead/src/bridge/lead-patrol-registration.ts:56 | 先查同 requestId receipt，重放读取已注册报告；不能重放时先读新 Linear |
| packages/teamlead/src/bridge/lead-patrol-snapshot.ts:168 | Bridge 固定 helper pin、私有 scratch，child env 没有 Linear credential；新增事实由可信父进程采集 |
| packages/teamlead/src/bridge/linear-query.ts:44 | 通用 list 无 parent/cursor；不可用首 250 张冒充全量 |
| packages/teamlead/src/bridge/linear-epic-query.ts:137,250,582 | 可借固定 children GraphQL、已有 SDK 和有界分页；整函数只选 started Epic 并递归，不可直接复用 |
| packages/teamlead/src/StateStore.ts:72715 | getActiveWorkflowRun 使用 project_name + issue_id + status='active'；不看 session/PID/是否有当前节点 |
| packages/teamlead/src/lead-capabilities/patrol-judgment.ts:117 | 判断合并只替换指定 STEP 的 FINDING；保留机器事实，再写原子文件并执行门 |
| packages/teamlead/src/patrol-report.ts:114 | 纯函数验证 FINDING 与声明/处置闭合；不能自己验证 Discord 投递真伪 |
| packages/teamlead/src/lead-capabilities/patrol-completion-gates.ts:42 | 运行三个固定门，第 3 门再调用 validatePatrolReport；receipt 格式固定三位，不加第四个 gate |
| packages/teamlead/src/patrol-continuity-cli.ts:82 | 传统路径同样调用 validatePatrolReport；必须与 Bridge 路径同步覆盖 |
| packages/teamlead/lead-rules-base/runbooks/patrol-v1.md:428,445,496 | schema=2 + FINDING；mechanism_defect 的 existing/created 分支需写 Linear，本任务不能套用该语义 |

## 等待与消息证据
`StateStore.ts:33138` 的 node_dwell_review 主键是 run/node/attempt/cycle；`node-dwell-control.ts:239` 强制 episodeStartedAt。待排修类别恰好无 active run，不具备这些身份，借表会创造虚假运行数据。

`lead-capabilities/handlers/discord.ts:530` 的发送成功记录 messageId 与 `discord-message:<id>`；`:569` 通过已有 sender 状态恢复不确定发送。消息回执只证明真实投递，不赋予派单或 ship 权限。

`bridge/chat-thread-utils.ts:1220` 可借鉴 exact message read 和 author/channel 校验，但该函数不返回正文，不能单独证明消息提及具体类别。`:906` 的旧 thread reopener 只读一页、满页判 unknown，且任何 human 都算；本任务必须依据 configured founder ID、完整分页和精确 replyTo 判断，不能原样当 founder 回复验证器。

## 技术选择与最小性
只增加一个窄 collector、一个共享处置验证器；持久等待复用已有 founder_ask，加 nullable patrol_schedule_key 绑定列；沿现有 snapshot、judgment、FINDING、receipt 使用，不建设调度器、创建新 Linear issue 或消息通道。首次呈报仍由 Lead 通过现有 thread reply 做；机制只检查证据、记住等待状态。完整清单不受页面 top-N 显示限制。

## 本地验证范围
设计阶段验证真实只读数据、文档和 HTML；行为用例在计划中明确交给实现/QA，不把纯设计检查包装成完成门功能通过。后续仅运行本次 collector / patrol report / judgment / snapshot / rule 合同的相关测试，不跑全仓测试。

补充核验：StateStore.ts:12653 的 founder_ask 已持久化项目、issue identifier、thread/message 和真实 founder 回复结算，最小方案不新建等待表。tools.ts:768 当前 founderAsk 仅接受 questionId，Codex discord.thread.reply 尚无对应字段；两个入口都需要显式增量接线，不能把现有表误称为已具备完整能力。
