# FLY-1436 design 放行口径 — 设计修正附录
Issue: FLY-1436 (https://linear.app/geoforge3d/issue/FLY-1436/解冻1418-work-kind-binding-cutover-分档路由上线解锁-honey-lemon接替-fly-1418)
日期: 2026-07-22
基于: plan.md

## 放行记录

review_design gate `e8642e9f-6e25-4b14-8932-3b9bdb638c30` 由 Tadashi(flywheel-eng-lead)放行(2026-07-23Z)。理由原文:codex design review 5 轮 R5 APPROVED、1418 冻结设计四条重开门逐条兑现、Bridge request-review 409 → legacy codex lane 是既定 fallback(不是绕过)。design HTML 已由 Tadashi 投进本单 thread 给 Annie(founder 可见性,非审批门,implement 不等她)。

## 四条 implement 验收口径(Lead 放行时钉死;implement 节点必须遵守)

1. **红线不许软化**:两个 flag(`FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` + `pipeline.work_kind`)的翻转只能在 G-GO 之后的受控序列内。任何「先翻一个试试」都是违约。plan C3′(codex R1-1)已无提前翻转步 —— 保持,不得回退。

2. **重启口径覆盖(Annie 新指令,晚于本 plan)**:**没有 bridge-only、没有分档重启**。P2 的 Lead 重启、P4 的 deploy,凡是重启一律走**那一个统一全量重启脚本**,且重启自带通告。plan 中任何暗示部分重启 / 分档重启的措辞(如「精准杀 run-bridge 树」「重启半径只剩 Lead 面」),implement 时一律按本条覆盖执行。

3. **完成 ≠ PR-A 合了**:本单验收 = **能力真的可用** —— flag 真翻、六行真写、**Honey Lemon 真的被解锁并跑通 P5 valid 正样本**。PR-A merge 只是中途。plan P6a 的两个具名 follow-up(retire / docs PR)是显式声明的分期,Lead 认;**除此之外不许再新增「留给后续单」** —— 要减范围必须回来找 Lead 明说,不许静默。

4. **review record 绑定纪律(FLY-1435 实坑)**:emit `codex-review-result` 之前先把该提交的全部提交完,**在最后一个 head 上才 emit**;emit 之后不要再调 `flywheel-comm progress`(它会 path-limited 自动提交 progress.md、推走 head,把 approved 记录作废)。
