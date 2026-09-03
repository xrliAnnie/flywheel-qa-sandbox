# FLY-2291 审查输出修复与会话恢复 — 实施计划
Issue: FLY-2291 (https://linear.app/geoforge3d/issue/FLY-2291/审查no-verdict-续写审查员会话连续输出缺尾括号的-json-parser-判-no-verdict且坏会话被新一轮继承粘住2269)
日期: 2026-09-03
基于: research.md

## 1. 锁定目标

在不放宽现有 envelope/verdict/gate 安全边界的前提下：

1. 恢复只差最外层一个 `}`、且已经以 `]` 闭合完整 `findings` 数组的 bare verdict JSON；在后续 gate/head guard 前把 `repaired_trailing_brace=true` 持久化到 review job。
2. 同 execution + type 连续两次 reviewer session-integrity failure（`no_verdict` 或 `reviewed_wrong_head`）后立即切换 session generation；下一个新 request 或同 request retry 不继承旧 reviewer UUID，fresh prompt 恢复可依赖 findings 上下文。
3. 让现有 failure alert 按失败形状给出正确建议，不再让 no-verdict 连败继续粘着旧 session。

不增加配置开关、alert kind/sink、重试队列或旁路；新行为写死且 fail-closed。

## 2. 变更清单

### 2.1 `claude-review-runner.ts`

- 把 `extractVerdictObject` 的内部返回值扩为 `{ json, repairedTrailingBrace }`；正常 balanced candidate 标记 false。
- 仅在没有 balanced verdict candidate 时 repair：
  - bare text `trim()` 后必须 `startsWith('{"verdict"')`；
  - 末字符必须为已经闭合 findings 数组的 `]`；
  - 仅追加一个 `}`；末字符为引号、数字、逗号、冒号或需要 `]}` 时不修复；
  - 补全对象必须完整 `JSON.parse`、verdict 合法、own `findings` property 为数组。完整未修复对象维持既有兼容行为。
- `parseClaudeReviewOutput` 与 verdict outcome 携带 `repairedTrailingBrace`。
- 错误 envelope、未知 verdict、未闭字符串、缺 findings、缺一半文本继续返回 null / `failed/no_verdict`。

### 2.2 `StateStore.ts`

- `CodexReviewJob`、fresh schema、显式旧库迁移、row mapper 增加：
  - `repaired_trailing_brace: boolean` / `INTEGER NOT NULL DEFAULT 0`；
  - `reviewer_session_generation: number` / `INTEGER NOT NULL DEFAULT 0`；
  - `reviewer_session_failure_streak: number` / `INTEGER NOT NULL DEFAULT 0`。
- 新增幂等 `markCodexReviewJobTrailingBraceRepaired(requestId)`。
- insert 新 job 时继承同 execution + type 最新的 generation、该 generation 的 UUID 和 failure streak；requestId 不重置连续性。
- `recordCodexReviewJobFailure` 对 `no_verdict` / `reviewed_wrong_head` streak 加一，其他 reason 清零。达到 2 时在同一持久化动作内 generation 加一、清待启动 UUID、streak 清零，并返回 `reviewerSessionRotated=true`；terminal job 仍不可降级。
- `completeCodexReviewJob` 清零 streak。
- `latestCodexReviewerSessionUuid` 先读最新 generation，再只查同 generation 的 UUID；generation 是持久隔离边界，不以 NULL 作为“不继承”策略标记。

### 2.3 `review-request-coordinator.ts`

- `accept` 从同 execution + type 最新状态继承 generation/streak，并只在该 generation 中查 UUID。
- 第二次 session-integrity failure 持久化时 generation 已经切换；同 request retry 与新 request 因新 generation 内没有 UUID，都在 preflight 后生成/持久化新 UUID、`resume=false`。之后正常 retry resume 新 UUID；新会话又连败两次才再次切代。
- fresh prompt 注入最近 DONE job 的 `findings_json`，标明来源 round；自动 reset 与 session-not-found 使用不同原因文案，无可靠 findings 时诚实 fallback。
- 得到 repaired verdict 后立即写 marker，再进行 gate/head/policy 校验。
- policy/legacy canonical response 在 repaired 时加入 `repairedTrailingBrace: true` 与 `reviewAudit: "verdict parsed after trailing-brace repair"`；该文本随 review 判决投递给 Lead。
- 两个既有 failure surface 共用 recovery helper：
  - 第一次 no_verdict 可建议一次原 session retry；
  - 第二次 no_verdict 或 reviewed_wrong_head 说明“reviewer session 已换代；重试同 requestId 会 fresh”；scheduled retry 同时给时间；
  - repaired verdict 后续被 guard 拒绝时显示 marker；
  - 其他 failure 保持现有建议。

### 2.4 真机 fixtures

- 逐字加入 `fly2269-r1..r5-reviewer-raw.txt`，校验 research.md 中的 bytes/SHA-256。
- 文件是 Claude success envelope 内的 reviewer `result` 字符串；测试用生产 envelope 包装 raw，再调用 `parseClaudeReviewOutput`。
- R1 是完整 control；R2–R5 缺最终 `}`；R5 短输出证明行为与长度无关。

## 3. TDD 执行顺序

用户要求四形状先整体 RED，因此 parser 第一批遵循这一例外；随后恢复一测试一最小实现的竖切循环。

### Slice A — 四形状 parser RED → GREEN

先在 `claude-review-runner.test.ts` 同批加入并运行：

1. 完整 verdict → 成功，`repairedTrailingBrace=false`。
2. 缺 `}`：`{"verdict":"APPROVED","findings":[]` → 成功，true。
3. 缺 `]}`：`{"verdict":"APPROVED","findings":[` → null / `failed/no_verdict`，不补 `]}`。
4. 真截断：`{"verdict":"APPROVED","findings":[{"title":"half` → null；runner seam 为 `failed/no_verdict`。

保存预期 RED，再做最小 parser 实现并 GREEN。之后逐一加入未知 verdict、错误 envelope、fenced truncated，以及尾部为引号/数字/逗号/冒号的边界负向守卫。

### Slice B — 真机 fixtures

1. 复制 R1–R5 raw，先校验 bytes/SHA。
2. fixture test 用真实 success envelope 包装每份：R1 当前 control 应绿，R2–R5 在修复前应红。
3. 实现后断言 R1=`CHANGES_REQUESTED`/false，R2–R4=`CHANGES_REQUESTED`/true，R5=`APPROVED`/true。

### Slice C — repair job 审计

1. StateStore test 先断言默认 false、mark true 与幂等 round-trip，RED；加 schema、迁移、mapper、update 后 GREEN。
2. 扩 migration test：旧表双开后列存在、默认 0，GREEN。
3. coordinator test 传入 repaired outcome，断言 marker 在后续 guard 前已写。成功路径 canonical response 显示 true；gate/head guard 失败路径 job 与既有 alert 仍显示 true。

### Slice D — 连败换 fresh session

1. 三个 open gate/new request：前两个各 `failed/no_verdict`；RED 断言第二次失败后 generation 已加一，第三个 invocation `resume=false`、UUID 全新且等于 job 行。
2. 同 request 连跑两个 no_verdict，再触发第三 attempt；RED 断言也 fresh。实现 inherited streak、transactional generation rotation 与 generation-scoped UUID lookup，GREEN。
3. 混合 `no_verdict` + `reviewed_wrong_head` 也触发；其他 failure 或 done 清 streak。
4. fresh 后一次失败/重试仍在新 generation；同一新会话再连续 integrity failure 两次才再次切代。
5. 控制组：一次失败仍继承；execution/type 隔离；lookup 不跨 generation 复活旧 UUID。
6. 更早 DONE finding + 连败 + fresh round：只取最近一轮 durable findings，prompt 标明来源 round 且不声称 `THIS session`。

### Slice E — failure-shaped alert

1. 在 Slice D coordinator seam 断言第二次 no_verdict / reviewed_wrong_head 的 structured/legacy alert 均写明“已换新会话，重试同 requestId 即可”，RED。
2. 复用 recovery helper，GREEN。
3. scheduled retry 同时显示排期与 fresh recovery；timeout 文案保持；fresh replacement 又失败时使用“已经换会话”的时态。

## 4. 聚焦验证命令

```bash
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/claude-review-runner.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.codex-review.test.ts src/__tests__/StateStore.fly663-migration.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/review-request-coordinator.test.ts
pnpm --filter flywheel-teamlead typecheck
```

fixture 另做 SHA 校验，防止复制字节漂移。

## 5. 完成审计与全仓 gate

1. 检查无 `[DEBUG-...]`、旧错误告警、secret、开关或新 alert kind。
2. 重跑聚焦 suites 与 teamlead typecheck。
3. 执行精确全仓 gate：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。
4. 显式执行 `bash scripts/__tests__/fly2045-milestone-layout.test.sh`；枚举并逐个执行本分支新增的 `scripts/__tests__/*.test.sh`，有 mutation companion 也执行。
5. 通过 `codex:rescue` 运行代码审查，不使用 raw `codex exec`；修复 blocking findings 后重新跑 gates。
6. 注册 `review_code` gate + request-review，轮询到 `reviewVerdict=APPROVED`；advisories 报 Lead。
7. push feature branch并创建 PR；不可逆动作前重查 inbox。
8. `engineering/doc/milestones/FLY-2291.md` 作为 literal last commit；不修改 `CLAUDE.md`。
9. 唯一报告通道回报 Lead instruction `3501bc0f-126f-45f5-be80-75994c9d9a1b` 的处理结果、commits 与 PR。
10. `complete --route needs_review --pr <NUMBER>`；不 dispatch QA、不 merge、不 deploy。

## 6. 回退

- parser：删除 repair fallback 与 marker 传播，balanced extraction 不变。
- schema：新增列均向后兼容；旧 binary 会忽略，无破坏性 migration rollback。
- session：移除 streak/reset predicate 即恢复继承；已写 UUID 与 audit 字段保留。
- alert：移除 no_verdict 专用 recovery 即恢复旧文案，无外部状态迁移。

## 7. 完成定义

- 四形状与 R1–R5 权威 raw fixture 经生产 envelope seam 得到预期 verdict/repair 结果；真截断与 verdict-only 仍 no_verdict。
- repaired job 在后续 guard 前读到 `repaired_trailing_brace=true`；完整 verdict 为 false，成功 response/失败 alert 可见，旧库迁移幂等。
- 连续两次 session-integrity failure（no_verdict / reviewed_wrong_head，跨 request 或同 request）后 generation 已切换，下一 attempt/round 使用全新持久 UUID、`resume=false`；prompt 只恢复并标明最近一轮 prior findings。
- 连败 alert 明确已换新会话并可 retry 同 requestId，不再给出粘住坏 session 的建议。
- 聚焦 suites、teamlead typecheck、三条全仓 gates、milestone shell test、代码审查与外部 review gate 全部通过。
