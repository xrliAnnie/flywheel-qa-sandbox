# FLY-1949 评审并发 — 实施计划
Issue: FLY-1949 (https://linear.app/geoforge3d/issue/FLY-1949/评审并发-review-全局并发写死-2-提高并做成可配置founder-直令)
日期: 2026-09-10
基于: research.md

## 范围裁定

Lead 在 question 47a5e0ee-7167-4710-810d-aaca4a5a3206 明确：FLY-2037 已交付提高并发部分；禁止恢复默认上限。仅实现可选账号保护 cap：FLYWHEEL_REVIEW_MAX_CONCURRENT，未设置或 0 = 无限；N>0 = 全局最多 N 个 reviewer session，排队不丢失。构造时读取，热更新不在范围内。

## 实现

- coordinator 构造时读取环境变量并保存，不增加 models.json 配置或动态 reload。
- 严格接受去空白后的非负十进制安全整数；空值/未设置/0 使用无限。非法输入记录明确 warning 并采用默认无限，避免阻止 Bridge 启动；文档说明这一行为。
- 可选 semaphore 放在现有 per-execution chain 内、runJob 前；未配置时保持现有无限并发。
- 获得 slot 后重新检查 stopped；runJob 的成功、失败、异常路径都在 finally 释放 slot。释放时将 slot 直接交给 FIFO waiter，避免新请求抢占造成超额。
- stop 清空/唤醒尚未执行的 slot waiter，但不启动 reviewer；数据库中的 pending job 保留供 boot redrive。已有 retry timer 清理保持不变。
- 所有 execution 共用 coordinator 的 slot 计数；每个 execution 继续串行。持有 slot 覆盖一次 runJob 生命周期，含 reviewer 多轮，不修改 job/gate/timeout/额度恢复协议。
- 只在 plugin.ts 现有 unlimited wiring 注释旁集中说明 knob、默认、非法值、构造时生效及同 execution 串行语义。

## TDD / 验证

每次先添加测试并验证预期 RED，再最小实现并验证 GREEN：

1. env=1 时不同 execution 的两个未完成 round 只启动一个；释放后第二个启动且两 job 都完成。
2. 未设置/0 仍允许十个 execution 同时启动；构造后改变 env 不改变已创建实例。
3. 非法值（负数、小数、文本、非安全整数）发 warning 并保持无限默认。
4. cap 下 reviewer 异常释放 slot；stop 不启动 queued job，boot redrive 可恢复 pending job；已有同 execution serial 测试保持。

不新增 schema、迁移或 shell 测试。回滚为删除环境变量并在下次构造生效；无限默认与 FLY-2037 相同。本节点不执行生产重启。

完整 coordinator suite + pnpm lint + pnpm -r build + pnpm test:packages:run。如有失败精确披露，不能把 focused green 代替全仓 green。

## 交付

冻结本计划后请求 design review，APPROVED 才改产品代码。小提交与 progress cursor；实现后注册 code review，按有效 reviewVerdict 处理。创建 PR 前最后提交 engineering/doc/milestones/FLY-1949.md；不修改 CLAUDE.md。报告 Lead，complete --route needs_review --pr NUMBER，按 phase keep-alive park。不得 merge、部署或 dispatch QA。
