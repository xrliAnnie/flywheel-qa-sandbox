# FLY-2912 纯通知只记账 — 实施记录
Issue: FLY-2912 (https://linear.app/geoforge3d/issue/FLY-2912)
日期: 2026-09-25
基于: plan.md

## 已核对的入口

Implement TURN epoch=3，activation=activation:888b3a31-e7f0-4ec4-a24c-f747b21b2468:eba38f61-a0b9-438f-b455-c8016f5f421c:implement:1。
继承设计 HEAD 7b5dccc06；设计 R2 question aaceefb4-073f-4544-a93f-12c52fda24c4 实时 check effective APPROVED。批准 plan 字节不改。

## 已实现的行为（交卷验证仍在进行）

新增内部 v2 binding/proof 类型，校验项目、Lead、event、execution、issue 完全相同；双 payload 使用字段 schema 守卫，自由正文/未知结构/问题/founder/失败/待办保持 model。关闭开关回 model，旧 v1 签名继续兼容。四类静默均须专属证明，继承 decision 只接受匹配路由的解决收据。

红灯：EventFilter.test.ts 5 failed / 31 passed（四类新静默与精确解决收据缺失）。最小实现后同文件 36 passed。日志 /tmp/fly2912-t2-{red,green}.log。pnpm install --frozen-lockfile 成功；pnpm --filter "flywheel-teamlead..." build 成功，仅构建依赖与受影响包，未跑全包测试。

T1 已冻结全部 798 行（257 Lead 事件、80 stage 原始事件、206 mailbox、21 direct、21 dispatch、22 binding、191 workflow event），保留原顺序/ID/时间与缺证项。T3 接入真实 HTTP stage、DirectEventSink startup、Heartbeat 本轮 probe/episode、StateStore replacement producer；证明与 delivery decision 同事务持久化。外部 HTTP 无权写内部 proof 类型；已有 proof 冲突时保留即时 model。开关 OFF 恢复新事件原路径，旧 audit 不重放。ON 时 registry 暂缺的 actionable startup 留在可靠 pending 账中。

T4/T5 新增单行 StateStore generation/start anchor、CommDB 冻结 offer/cursor/receipt；现有 model/discord batch 最后附只读概览，不增加成员或单独唤醒。坏收据、失去 owner、传输异常不推进 cursor。摘要包含真计数、最多 8 个代表项、2000 code points 上限、精确 execution ID、转义与完整范围链接。StateStore 恢复/锚点漂移换 epoch 并提示可能重复；CommDB 重建从持久 start 重放。固定 JSON 入口仍 master-only，新增精确 project+lead+seq 范围与 epoch 校验。证明记录已登记 archive 与 activity-noise，新增表已登记 retention。

## 定向验证

每个新增行为先记录红灯，再最小实现；无本地全包测试。当前证据是分批定向验证，不能冒充最终 HEAD CI：

| 范围 | 已读日志结果 |
|---|---|
| v2 classifier | 37 passed |
| 新 stage/HTTP 证明边界 | 32 passed |
| Heartbeat 新20 + 既有23 + golden6 + startup12 | 61 passed；早先并发导致的 5s 初始化超时在原 timeout 不变的单通道重跑消失 |
| startup 新增 pending 边界后 + summary provider/store | 23 passed（13 + 4 + 6） |
| replacement + downstream no-enqueue | 7 passed，25 无关用例未选中 |
| Loop 新8 + 既有29 | 37 passed |
| Runtime scoped provider/真实 CommDB 接线 | 1 passed |
| CommDB frozen receipt | 16 passed |
| bootstrap route | 7 passed |
| proof archive/activity 两个新增用例 | 2 passed |
| TypeScript | flywheel-teamlead typecheck passed |

日志保存于 `/tmp/fly2912-*.log`；最终 consumer/related/lint/build/dependent typecheck、review 和 CI 结果将在交卷记录补齐。`pnpm lint` 已执行，当前报告 2 errors，正在定位；不隐藏红灯。

## 回放证据与未决项

Lead 回答 question `aa046fc1-d883-44ff-8510-8eb27eedb337` 提供只读原始日志/转录/历史备份路径，要求未恢复样本保守建模、不缩分母、不默认补证，推送后照协议交卷。

`evidence/carrier-observation.json` 是原 Claude Lead 转录的派生观察：窗口内 99 个 user-string 输入；87 个含精确已知 batch/Event 编号，86 个有模型请求后代，150 条源 seq 可精确匹配。94 个 `turn_duration` 是整个 Lead 的完成标记；553 个模型 API request 也不是 553 次从空闲叫醒。这些均不替代改后模型消费证明。

T6 完整 257 输入 A/B/C 台架仍在执行。历史 startup raw payload 21 条均缺失，时态 gate/dispatch purpose/alert 证明不全；无法恢复的事件按 model 处理并标 unresolved，不凭脱敏文本或默认 session 伪造节省。新的两种真实隔离载体消费探针尚未执行：已核对可复用组件，但受管认证 provisioner 要求已保留的 QA slot；本 implement 不冒用该 slot、不运行生产 Lead/频道。运输回执和 payload 单测只证明提交/接线，最终模型消费与完整节省验收仍需独立证据。

后续：完整回放、所有保留消费者的 related 验证、lint/build/typecheck、PR 与有效 code review、needs_review 交卷。未请求全 CI，未 dispatch QA，未 merge/deploy。
