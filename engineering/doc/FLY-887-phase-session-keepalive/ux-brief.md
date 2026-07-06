# FLY-887 R2 UX Brief — founder 可见变化
Issue: FLY-887 (https://linear.app/geoforge3d/issue/FLY-887/pipeline-三段式-phase-session-并存保活-designimplementqa-不跑完就关qaimplement)
日期: 2026-07-06
基于: plan.md R2 节(resume 后 Codex design review 重跑 2 轮 APPROVED,2026-07-06)

R2 三件事(rebase / per-phase model / channel 门控)对 Annie 直接可见的变化只有两点,且都是 Annie 本人已定的策略(经 Tadashi lead-instruction 34522575 传达):

1. **[FLY-XX] thread 里的 phase 消息标签跟随新模型表**:原 [设计·Fable]/[实现·Opus]/[QA·Sonnet] → 新 [设计·Fable]/[实现·Fable]/[QA·Opus]。全程无 Sonnet —— 这正是 Annie 定的 per-phase model 策略(核心痛点:QA 返工卡在 Sonnet)。
2. **三段式只在 #flywheel-engineer 频道生效**:其他 Lead(cos/product/codex-infra/anna)在各自频道 dispatch 的 flywheel issue 走回单 session 流程,founder 在那些频道看到的 thread 形态回到三段式之前的样子。其他项目本来就没开三段式,零变化。

无新增通知、无新命令、无版式变化。R1 的 status line(Annie 亲自要的)不动。
