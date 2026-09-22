# FLY-2655 语音收音恢复 — 设计交接
Issue: FLY-2655 (https://linear.app/geoforge3d/issue/FLY-2655/2598follow-up-raya-rg-语音会话-live-10-秒即-faileddiscord-audio)
日期: 2026-09-17
基于: plan.md

## 交付审计

| 要求 | 当前证据 | 状态 |
|---|---|---|
| TURN 内设计、禁止实施 | design epoch=1；本 issue 提交仅在本目录 | 已核 |
| 探索、调研、实施计划 | exploration.md / research.md / plan.md | 已提交推送 |
| 初始前提核对 | dependency-probe.json、research.md、Lead 确认 | 已否定“缺少 DAVE 依赖”作为当前根因 |
| 原场真实证据 | original-session-evidence.json，7条白名单事件 | 已核；不能证明真人收听或具体解密诱因 |
| 设计评审有效通过 | design-review-r3.json：42655ad9-f6c8-4780-925f-8ba2f3b64d9c，reviewVerdict=APPROVED | R3通过，包含§7.2；3项QA说明已补正，4项Follow-ups保留 |
| Founder HTML 与交互 | founder-design.html；html-verification.json | DOM/控制器检查通过；浏览器视觉检查未验证 |
| Mermaid 本地生成 | flow.mmd / model.mmd；diagram-render.json | 每图标准参数重试一次均被系统权限拒绝；按合同保留明确占位 |
| 托管发布及 CSP/source 校验 | publish-receipt.json / hosted-verification.json，HTTP200、nonce/CSP/source相符 | 已发布核验；publishOnly=true |
| DESIGN-HTML URL 报告 | f354fd81-975d-4308-8c98-64edf85cd56a；限制报告adcd0be1-194a-4ece-b64f-7477530aa361 | 已报告Lead |
| phase_design_complete 与 park | 此文件提交后执行；最终以Bridge完成/停驻收据为准 | 待命令确认，不以本文冒充完成 |

## 后继必须保留的边界

1. plan 的错误隔离与重订阅不等于原场协议根因已解决。持续 DAVE 失败时，即使播报和会话还活着，真人收音验收仍不通过。
2. 未 opt-in 的标准 v2 Lead 仍必须正常启动；三项 voice 操作不能被算作该 Lead 的 missingOperationIds。
3. 入口规则落在 dept bundle；实际模型工具是 lead_operation 的三个 oneOf 变体，不是三个独立工具。
4. codexVoiceActions 缺省关闭，凭据留在父进程。生产激活由 Lead 在 founder 批准后执行，不由实现上线隐式开启。
5. 合入前QA/529 founder真人说听为硬门禁，不得缺席PASS/出ship卡。验收组一为 RG 与 meeting 各自真人说听；组二为 Raya 割接后由 #raya 文字自主开场。Lead 已允许两组独立安排，但完整 issue 验收仍须两组证据。
6. 本节点没有实施、合并、部署、重启、生产配置写入或派后继。状态/连接/传输回执均不替代真实声音。

## 恢复入口

先核 TURN 与 inbox，再按 progress.md 的精确 questionId 查询 review。不得重新请求已登记的同一轮 review、重建已有文档或重复发布。收到新 verdict 后先保存原始结构化响应，只有有效 reviewVerdict=APPROVED 才执行发布和完成路线。

## 最终托管交付

https://fw-reports-42fba7.vercel.app/r/6533d5dd5b3e1abf270f885d74c45d7e/

最终HTML已随9ae8dd931提交推送。托管内容只发生预期nonce替换、CSP与noindex注入；没有外部资源。未声称浏览器视觉/CSP实际执行已通过。R3 advisories报告3aa4e351-e47f-4672-b9a0-f7622a79964e。设计完成不是实现或真人QA通过，后继须遵守§7.2硬门禁。


## 2026-09-18 重起交接（本节优先于上面的历史游标）

- 本轮exec：29871354-a261-4af5-9f63-cdbf0c59372e；run：19f65593-cb7e-40cd-aa12-5158532475ce；design TURN epoch=17。
- 继承头：b2656cae6f65f8d1ca2322bcac4f65e5f45588fd；增量设计头b642f0638；原R3作为沿革保留，本轮新gate/question为29c5e902-978d-497c-8878-96c1fd2fe193，request为3e7a6844-26c1-4acd-b503-a07b19025545。最终有效响应另存resumption-design-review.json；不存在该文件时不能声称本轮已通过。
- plan §9记录当前实现/QA阻断、advisory去向、未提交stash和精确恢复边界。implement恢复stash对象117e962e492a1f87d7ddf9df5fa8b7802b847170前先核TURN与基线；本设计未应用该stash，也未修改实现文件。
- §7.2命令已核对当前commandArgs：voice-room所有命令必须带--expected-head，start必须带--topic；test-deploy自身仍是--expect-head。真人验收必须含多句短话+停顿、live至少60秒。
- 更新后的HTML保留原设计结构，仅纠正当前返工状态和验收措辞。静态结构与VM控制器验证见resumption-html-verification.json；本轮两图各两次本地render失败见resumption-diagram-render.json，仍用明确占位，不声称浏览器视觉或真实CSP执行通过。
- 本轮发布与托管证据使用resumption-前缀，与旧报告收据分开。只在新有效APPROVED之后publish-only并报告Lead，再执行phase_design_complete。旧HTML URL及旧完成状态不冒充本轮交付。

本轮复审已于2026-09-18T16:57:01Z返回有效APPROVED（resumption-design-review.json）。七项非阻断建议完整记录于review-disposition.md并报告Lead；不以设计APPROVED代替代码复审、实际slot或真人QA。

本轮最终HTML：https://fw-reports-42fba7.vercel.app/r/7a88857d4f9f96bca111b88d6932902f/ 。已静默发布并报告实际Lead，HTTP200、nonce/CSP/source核验见resumption-hosted-verification.json；报告ID见resumption-delivery-receipts.json。提交推送交付证据后执行本轮phase_design_complete，最终状态以控制器回执为准。


## 2026-09-18 23Z 接续交接（当前事实；保留历史沿革）

当前exec 7c77328d-3a37-4a25-96ec-e873d9e968f2 / run b15740cb-ea84-47fb-82f1-587d33f2cb74，TURN epoch22。继承实现5/5、PR #1243不另开；plan §10核对备份已纳入、main同步、原CI失败与待验边界。没有重新设计或编辑实现代码。详细审计见continuation-audit.json。

本轮设计question 237a872c-918f-41cb-8fe7-86e6c2ed6e81 / request 6ea79df4-c7a1-48d7-9db0-a0a701c2cf8b；原设计APPROVED保留，本轮结论以continuation-design-review.json与当前check为准。没有该有效回执不能声称本轮通过。

HTML只纠正原始故障与当前进度说明，原交互与架构保持。DOM/controller校验见continuation-html-verification.json；两图每图本地尝试/标准参数重试均因MachPort权限失败，见continuation-diagram-render.json。仍保留明确占位与Mermaid源码，不声称浏览器视觉或CSP执行通过。

后继需要：最终候选头有效代码复审+完整CI；shell分片容量失败不能当偶发忽略；529真人RG/meeting（短句、停顿、live≥60秒、转写与镜像、真实听见）和割接后Raya自主入口。设计批准不抵扣这些门禁，不启动生产或派后继。


Lead于本轮报告bc47cef0-d034-41ff-bec4-b79e8e1ebab7、5e88629d-4ecd-4081-9bb9-b1869d305359的回复明确：本激活仅design交接；WIP/同步main/CI步骤原意给实现体，控制器在phase_design_complete后铸实现体并由Lead重发。此前已在TURN内完成的技术合并保留，不新增实现；scripts elapsed tripwire留给实现体最终头完整CI处理。已报告落实，receipt c0b6989b-fc92-44fb-83a8-79d545ff60f2。

本轮有效reviewVerdict=APPROVED，17项advisory完整保存并逐项登记。源码确认迁移后pretty JSON与env compact JSON在loadSlot被逐字比较，fixture digest仍绑定迁移前字节；该新增实际slot风险须实现优先复现/处置。阶段完成不宣称装房成功。当前Header已明确绑定本轮批准。


### 最新Lead处置（本轮答复优先；2026-09-18）

权威答复：6249efda-b616-43ff-9a55-8ca3b5124833、682a9bff-9f5b-409c-aad2-615e057cbe0b，原文含「托管仍停用：发布最多试一次，失败记publish-failed，照常phase_design_complete并park」「不再重试」。这不是设计节点自行豁免。

1. voice-room-loadslot-rejects-migrated-registry 纳入本单实现，最高优先，先用经过真实迁移器的slot复现，再修；它直接阻挡语音验收。
2. post-reserve误报rejected、DAVE启动版本证据缺失、生产路径改动未登记：若在本单改动面内随本单处理，否则PR Follow-ups。
3. 其余QA allowlist同源、dept运维规则、A组测试矩阵/D2清理等不新建issue，登记PR Follow-ups。保留既有FLY-2742关联；不自行认定已解决。
4. HTML已提交推送，唯一一次publish-only返回502 report publishing failed，url=null；已报告publish-failed。未执行托管HTTP/CSP/source验证，也不复用旧URL当本轮交付。按Lead最新明确授权完成design并park，后续托管恢复由Lead协调。


### 本轮完成审计

| 合同项 | 证据/结论 |
|---|---|
| 延续已有设计与实现，不重新实现 | plan §10、备份7文件比较、继承implement 5/5；本轮除已授权技术main merge外仅设计文档 |
| 完整文档与frontmatter | exploration.md / research.md / plan.md保留，plan Status现绑定本轮question/request |
| 有效设计review | continuation-design-review.json，reviewVerdict=APPROVED，17项非阻断发现全量保留 |
| HTML内容与评论层 | founder-design.html；continuation-html-verification.json，8节输入、path-scoped storage、汇总/分段/复制fallback通过 |
| Mermaid | 两图本地各两次失败；源码与continuation-diagram-render.json保留，明确占位，无远程渲染 |
| 发布/托管 | 单次502，continuation-publish-receipt.json；Lead明确授权publish-failed后继续。无本轮URL，无托管验证 |
| Lead报告与处置 | continuation-delivery-receipts.json及上方精确响应ID；PR Follow-ups同步 |
| 提交推送与progress | final commit/remote及progress 3/3由完成前命令验证 |
| phase_design_complete / park | 本文件之后执行，控制器回执是权威；本审计不冒充尚未产生的回执 |
| 实现与真人验收 | 不属于本节点已完成事实；最终头code review/CI、真实slot、RG+meeting与自主入口保持待验 |
