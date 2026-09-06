# FLY-2298 founder_review 等待判据 — 实施计划
Issue: FLY-2298 (https://linear.app/geoforge3d/issue/FLY-2298/病根-dwell-的是否等-founder判据不认-founder-review-卡-question-checkpoint)
日期: 2026-09-06
基于: research.md

## 0. 锁定范围

只为 `STEP DWELL` 增加第三种 founder-wait 形状，并把它接入现有 waiting episode 起点。保留原有 `founder_gate/review`、`approve_to_ship`、owner attribution、阈值、receipt 与 grouped reminder 语义；不增加进程、schema、feature flag、节点类型特判或对账器。

## 1. Question-domain projection（TDD）

1. RED：在 `node-dwell-control.test.ts` 新增用例，要求 helper 投影未答、未 supersede/terminal dispose 的 `founder_review` question id 与 sender。当前尚无 API，测试应因缺少 export/command 失败。
2. GREEN：在 `node-dwell-control.ts` 新增窄接口 `readOpenFounderReviewGates()`：
   - 复用 `CommDB.getOpenGatesByCheckpoint('founder_review')` 的 canonical 未答/未注销判定；
   - 不解析 raw `content`，避免合法 content-ref 卡使全项目 DWELL unavailable；
   - 与现有 approve projection 相同，只校验 schema 保证非空的 id/sender；
   - 增加 `open-founder-review-gates --comm-db` CLI 子命令，所有字符串继续 hex 编码，并输出严格 count summary。
3. GREEN/REFACTOR：保留现有 `open-approve-gates` 字节合同与调用，不改名、不扩大它的 checkpoint 集合；共享少量验证/hex 输出代码仅在不会改变现有输出时进行。

## 2. STEP DWELL route 与 episode（TDD）

1. RED：在 `lead-patrol-snapshot.test.sh` 构造超阈普通 `pm` 节点，其 sender 打开未答 `founder_review`，并有当前 run 的 immutable `founder_review_card_binding`。断言目前错误的 `deep_dive`，目标要求改为 `founder_reminder`，且同 issue 只生成一条 action。
2. RED：写 `waiting_founder` receipt 并把 receipt 时间倒填超过多个阈值窗，断言同一张卡仍 `waiting_episode_reminded=yes`、不生成第二条 action；当前代码因走 deep dive 失败。
3. RED：加入新 round，断言新 binding 时间先重置阈值；将新 binding 时间置于阈值外后再次产生一条 reminder。加入其他 run、其他 execution、缺 binding、已答/已注销卡的负向 guard，均不能让普通节点绕过 deep dive。
4. GREEN：`lead-patrol-snapshot.sh` 每 tick 调用新 helper 子命令，严格解析 hex + count 为 `open_founder_review_questions` CTE。解析或 helper 失败设置 DWELL structural unavailable。
5. GREEN：在 StateStore 主库中把 open question id 与 `founder_review_card_binding.question_id` 精确连接；`classified` 第三个 OR 同时要求 binding `run_id` 等于当前 run、question sender 等于当前 node execution。不得按 `pm`、issue 或仅 sender 模糊匹配。
6. GREEN：增加当前 run/execution 的 founder-review activity，并将最新 binding `created_at` 以 `coalesce(strftime(...), strftime(..., started_at))` 纳入 `episode_started_at` 的 scalar `max(...)`。复用现有 `waiting_examined_at >= episode_started_at` 抑制，不建立第二套 receipt；回归证明没有 founder_review 的既有两种 route 仍有非空 baseline。
7. REFACTOR：集中两类 helper 输出的严格 awk parser，前提是保持各自稳定 token 和 fail-closed 行为；否则保留显式代码以便审计。

## 3. 规则合同（TDD）

1. RED：扩展 `fly369-patrol-rule.test.ts`，要求规则文本写明三个判据、open `founder_review` + immutable card binding、exact run/execution 绑定、新 round 重新武装，以及禁止 `pm` blanket exemption。
2. GREEN：更新 `runner-patrol-rules.md` 的 founder-wait 段，把「两个判据」改为三个；第三条复用现有 question domain 和 waiting receipt 路径，不改变 deep-dive 证据纪律与四值 verdict domain。
3. REFACTOR：搜索所有宣称「两个判据」或只列两种 founder-wait 的生产/测试文本，更新真正的合同消费者，历史文档保持不动。

## 4. 验证与交付

1. 保存 RED 证据后做最小实现，依次运行 `node-dwell-control.test.ts`、`fly369-patrol-rule.test.ts` 与 `scripts/__tests__/lead-patrol-snapshot.test.sh`。
2. 检查 inbox，提交小批次并用 progress ledger 记录真实 cursor。
3. 运行准确全仓门：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，以及本次改动的 `scripts/__tests__/lead-patrol-snapshot.test.sh`。`pnpm test:packages:run` 会包含可驱动真实 Terminal.app 的 macOS 测试；执行前通过 Lead question gate 明确安全运行口径，在未取得安全口径前不得触发该 GUI 用例，也不得把过滤后的定向套件冒充全仓门。
4. 通过 `codex:rescue` 执行独立代码审查，再按运行契约注册 `review_code` gate；blocking finding 修复后必须新开一轮。
5. push 并创建 PR；最后一个 commit 仅新增 `engineering/doc/milestones/FLY-2298.md`，不修改 `CLAUDE.md`。
6. 通过 `flywheel-comm ask --report` 汇报，然后执行 `complete --route needs_review --pr <number>`；不 dispatch QA、不请求 ship、不 merge。
