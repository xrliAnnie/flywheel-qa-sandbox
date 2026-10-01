# FLY-2109 切号后唤醒活体 — 设计评审记录
Issue: FLY-2109 (https://linear.app/geoforge3d/issue/FLY-2109/病根-切号后活着的-runner-不接新账号旧号周额度打满即全体静默只能人眼发现-8)
日期: 2026-10-01
基于: plan.md

## 结论

Codex design review **APPROVED**（第 5 轮）。reviewer `gpt-6-astra` / `xhigh`，线程 `01a0f6cb-aa9b-7c10-a075-c097b5268274`，
已评审 plan blob `d4deecc32d8ffe0e43df745ef221ef124474359a`（提交 `820c28b72`），Bridge requestId `27ad8fc8-8834-4db0-bf9c-ab9a2b16308f`。

| 轮次 | 结论 | 发现 | 处理 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 3 HIGH / 6 MEDIUM / 1 LOW | 全部采纳 → plan R2（`bdb852f93`） |
| R2 | CHANGES REQUESTED | 2 HIGH / 5 MEDIUM | 全部采纳 → plan R3（`7ceeecc2c` + `3b5868b3f`） |
| R3 | CHANGES REQUESTED | 3 MEDIUM | 全部采纳 → plan R4（`a5b4ad945` + `05d025ff9`） |
| R4 | CHANGES REQUESTED | 1 MEDIUM / 1 LOW | 全部采纳 → plan R5（`820c28b72`） |
| R5 | APPROVED | 1 LOW（不阻塞） | 见下「实施提醒」 |

超过 3 轮：已按安全阀向 Lead 非阻塞备案（question `e30d63cd-5b1e-44ed-b811-c04a252c2657`），未收到 override / 停止指示；每轮意见均成立且逐轮收敛，无 auto-approve。

## 各轮抓出的关键问题（按主题）

- **投递证据**（R1#1、R2#5）：CommDB 审计行存在 ≠ 已进信箱；`backend_commdb` 跳过不能写 delivered。
- **信箱写的两个坑**（R1#2、R2#7）：<60s pending sidecar 的假成功（漏投）；main 已写、sidecar pending 过期后的再追加（重投）→ 只读认回 + verified 写两个原语。
- **资格复核的位置**（R1#6、R2#1、R3#1、R3#2）：认回不看资格、先于任何 skipped / superseded；发新信的资格在写入边界上用同步读取读最新值。
- **身份绑定**（R4#1）：冻结的 runner 信箱身份必须就是实际写入地址。
- **Lead envelope 逐字可重放**（R3#3）：timestamp / sessionKey / payload 冻结落盘。
- **QA 隔离**（R1#3、R2#2）：两个路径重定向不够；需要完整隔离集 + 真正的 fake profile fixture；真凭证切换验收单列。
- **生产装配契约**（R1#4、R2#3、R2#4、R1#7）：`snapshot().projects` / `projectName`、同 CommDB 活性查询、`insertEvent` 必填列、`effectiveLeadBackend` 含 legacy。
- **其它**：D6 排除自动唤醒行（R1#5）；superseded 保留已发生结果与日志义务（R1#8）；`from` 恒为 null（R1#9、R2#6）；逐目标材料冻结（R4#2）。

## 实施提醒（R5 LOW，不阻塞，未改 plan 以保持已评审 blob）

`wakeRunnerMailbox` 的失败返回只有 `{ok:false, error: err.message}`（`packages/flywheel-comm/src/wake.ts:22-27,113-114`），不保留异常对象 / 类名 / code。
所以 consumer **不能**用 `instanceof IdentityChangedError` 识别 plan §3.1a 的身份拒绝。实现时二选一：

1. 目标级闭包显式记录本次身份拒绝（推荐：`factoryFor(frozen)` 返回的对象带一个 `identityRejected` 标志，wake 返回后读它）；或
2. 给该错误定义固定、可精确匹配的 message 标记（不要对任意错误文案做模糊匹配）。

并在 plan §4 #24(d) 的直接 wrapper 用例之外，补一条**走真实 `wakeRunnerMailbox`** 的 consumer 测试：制造其实际 write 参数与冻结地址不一致 →
断言零写入、`delivered_at` 未标、结果为终态 `skipped_identity_changed`、不落入普通 `failed` 的 20 次重试。处理完全留在新 consumer / 包装层，`wake.ts` 不变。
