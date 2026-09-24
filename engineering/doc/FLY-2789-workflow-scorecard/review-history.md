# FLY-2789 节点成绩记录 — 调研
Issue: FLY-2789 (https://linear.app/geoforge3d/issue/FLY-2789/2787-b成绩记录-每张单每个节点记下用的模型组别并记-qa-是否一次过founder-打回次数额度花费耗时按组汇总每张一次过-qa)
日期: 2026-09-22
基于: research.md

## R1 处置
question c6d857a2-98e4-45fb-a973-ed99213d9d92 / request da696fe5-5496-47ef-8472-2a727e6d300e / reviewVerdict=CHANGES_REQUESTED。以下全部修订，须新gate评审；未声称治理覆盖或自行批准。

- HIGH `assignment-contract-orphans-existing-readers`：已修订。§2.2a.1 A 同时迁移 replay/dispatch 两消费者；B 比较 assignment/runtime，异常单列。
- MEDIUM `usage-row-identity-vs-provisional-refinement`：已修订。§4.2 原始记录 offset 主键，requestId 单列；800→2400 保留两观测并计 delta。
- MEDIUM `claude-runner-cannot-import-teamlead`：已修订。§6 来源读取器移到 teamlead；adapter 仅回调，不反向 import。
- MEDIUM `hook-registration-surface-unspecified`：已修订。§4.2 指定 TmuxAdapter 每次 launch --settings，禁止全局 settings 变更。
- MEDIUM `cross-vendor-token-unit-bias-in-headline-metric`：已修订。§2.4 每组 vendor_mix + incomparable 标记，禁止据此跨供应商优胜排名。
- MEDIUM `no-runtime-killswitch-for-admission-coupled-write`：已修订。§4.1/8 采用 savepoint 隔离会计故障，LEFT JOIN 从权威记录推导 missing，不阻塞 dispatch。
- LOW `assigned-at-format-normalization`：已修订。§2.2a 严格 SQLite UTC 转 ISO，允许同秒；不用时间作唯一键。
- LOW `plan-cites-bare-filename`：已修订。§4.3 补完整文件路径。

## R2 增量范围
Lead 指令 fa066f60-0a86-46f4-99a0-1a14c956fe79：实现两组与设计、QA并列；额度降级单独列出。b4105797-3065-4798-b529-344d588bec94 确认 model_arm_degraded 服务端回执，已原形纳入 §2.2b；A-D 加实现组，E覆盖降级排除与重放。

## R2 处置
question 48f95a8d-e76b-4068-9eeb-f1aa4f16fcc7 / request f08d7b87-a4f4-46d9-b3c5-eb54d5feec71 / reviewVerdict=CHANGES_REQUESTED。
- HIGH `per-launch-settings-hooks-may-shadow-global-runner-hooks`：真CLI隔离实验，见hook-merge-evidence.md；只保留inline UserPromptSubmit，global StopFailure缺口如实列出且有baseline反证，不宣称覆盖所有hooks。失败用量由terminal/recovery独立补读。待新review/Lead治理，不自行判批准。
- MEDIUM `degraded-cohort-censors-codex-arms-invisibly`：每arm增加降级移出数/率与剔除前单数，E样例覆盖。
- MEDIUM `degraded-receipt-runid-vs-quota-recovery-new-run`：§2.2b.1 指定A在新run物化继承assignment，B验证sourceRunId闭包，E改成双run。
- LOW `degraded-assignment-uid-rejects-legacy-receipts`：A降级前将legacy同run规范化成canonical，保持Lead冻结的引用格式，B同语义去重。
- LOW `assignment-unassigned-mix-taxonomy-gap`：assigned+明确unassigned组合固定mixed，列组成。

Lead 44f4f015-0e68-4c66-8bd1-04e78ae474b7 同意以真实CLI最小候选收敛HIGH、baseline StopFailure按PR Follow-ups记录且不另开单；已请求Lead登记正式review-ruling。有效治理状态只读新review返回settled，不从prose推断。8fea824a-4289-4674-b51c-439998352c9f 同意新run继承/legacy规范化/每组降级移出数率。

## R3 有效通过
question e602258c-2f53-4466-a267-bc6a7ee91ccd / request 6712cb1d-fcd4-4b11-ae26-bbcb3c45778d / round 3 / reviewVerdict=APPROVED / reviewerVerdict=APPROVED。3项MEDIUM/LOW advisories非阻塞，保留于handoff.md Follow-ups；不新增review，不改已评审plan文本。服务器ruling d01ac9d3-e097-4dce-9a5d-d5260c4b5c73 已由Lead登记；本轮原始与有效票均为APPROVED，返回settled为空，不虚称某finding本轮被自动settled。

## Lead批准后的收尾指令
4aba8512-26c5-4b47-b66f-493cdd6ecdcb 要求三项advisory在本单实现里全部落实、不只进Follow-ups，且不重开评审。已直接修正plan：E唯一fixture R1=40/R2=80、node_work=1300/elapsed=2300；剔除前示例40=25normal+12degraded+2mixed+1异常；删除有效StopFailure入口旧措辞，失败走terminal/recovery。仅既有baseline StopFailure功能问题仍按前一裁定列PR Follow-ups，不另开单。
