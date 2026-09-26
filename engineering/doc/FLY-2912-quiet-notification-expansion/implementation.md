# FLY-2912 纯通知只记账 — 实施记录
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912)
日期: 2026-09-25
基于: plan.md

## 已核对的入口

Implement TURN epoch=3，activation=activation:888b3a31-e7f0-4ec4-a24c-f747b21b2468:eba38f61-a0b9-438f-b455-c8016f5f421c:implement:1。
继承设计 HEAD 7b5dccc06；设计 R2 question aaceefb4-073f-4544-a93f-12c52fda24c4 实时 check effective APPROVED。批准 plan 字节不改。

## T2 分类核心（producer 接入尚未完成）

新增内部 v2 binding/proof 类型，校验项目、Lead、event、execution、issue 完全相同；双 payload 使用字段 schema 守卫，自由正文/未知结构/问题/founder/失败/待办保持 model。关闭开关回 model，旧 v1 签名继续兼容。四类静默均须专属证明，继承 decision 只接受匹配路由的解决收据。

红灯：EventFilter.test.ts 5 failed / 31 passed（四类新静默与精确解决收据缺失）。最小实现后同文件 36 passed。日志 /tmp/fly2912-t2-{red,green}.log。pnpm install --frozen-lockfile 成功；pnpm --filter "flywheel-teamlead..." build 成功，仅构建依赖与受影响包，未跑全包测试。

后续必须继续：T1 完整脱敏 fixture；T3 真实 producer 证据与持久化；T4 摘要与恢复收据；T5 双载体/查询入口；T6 完整序列回放；相关消费者 sweep / related tests / lint / build / dependent typecheck；PR、有效 code review、needs_review 交卷。当前不构成行为上线或验收完成。
