# FLY-2461 中文批准 — 实施计划
Issue: FLY-2461 (https://linear.app/geoforge3d/issue/FLY-2461/founder-ux静默失败-批准只认英文approve-look-good-to-me打回却认中文打回-founder)
日期: 2026-09-09
基于: research.md

目标：有限中英批准协议 + 当前卡授权边界 + 未锚定输入可见反馈。技术栈：TypeScript、Vitest、现有 CommDB/StateStore 与 Discord ingress。按当前 implement TURN 内联执行；设计评审通过后不修改本计划。

## 1. 共享批准协议（严格 red → green → commit）

修改 packages/teamlead/src/workflow-rework-hint.ts；测试 packages/teamlead/src/__tests__/workflow-rework-hint.test.ts、src/__tests__/founder-review-response.test.ts、src/bridge/__tests__/text-approval-source.test.ts（后两条相对 packages/teamlead）。

- [ ] 首先写一个 failing case：`expect(isFixedFounderCardApproval("通过")).toBe(true)`。运行 `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-rework-hint.test.ts`，确认失败为 false 与 true 的断言差异。
- [ ] 最小实现保留原 normalize：`new Set(["approve", "look good to me", "通过", "可以", "同意", "批准", "行"]).has(normalizeFounderCardProtocolText(content))`。
- [ ] 逐个增加词表/规范化/负例测试并验证。正例覆盖五个中文词、原英文、首尾空白与句末句号/感叹号。负例包括「不通过」「可以吗」「通过？」「行不行」「通过以后再说」、英文 question、包含词的长句，确保精确匹配。
- [ ] 增加显式语言覆盖不变量：按 en/zh 配对运行真实 approval helper 与 kickback helper。en approval approve/look good to me 对 design:/implement:/qa:；zh 五词对 打回/设计:/实现:/测试:。断言每种接受 kickback 的 fixture 语言至少一个 approval 成功，且五中文词各自成功；避免未来删除中文分支只剩英文还绿。
- [ ] founder review classifier 与 ship text source 表驱动验证中文 pass/approve；ship 非 anchor、非 founder 仍无批准。测试通过后提交这一批。

## 2. 未锚定反馈（严格 red → green → commit）

修改 packages/teamlead/src/bridge/founder-reply-deliverer.ts；测试同目录 __tests__/founder-reply-deliverer.test.ts。使用已有真实 CommDB fixture，先加失败用例：存在 review 门、founder 普通消息「通过」、postThreadReply 成功，应提示但 family.response 仍 undefined；当前基线缺少提示而失败。

最小插入点：ship/review anchored 分支之后、deliverAmbiguousToLead 成功之后、现有 anchored-neither explainer 之前。计算条件：`!founderReviewGate && !shipCardGate && (founderReviewGates.length > 0 || shipGates.length > 0) && isFixedFounderCardApproval(rawAnswer)`。这仅识别需要解释的输入，不创建/绑定 verdict。

固定提示：`这条还没有批准：请回复对应的当前审批卡，只回「通过」（也支持「可以 / 同意 / 批准 / 行 / approve / look good to me」），或在卡片上点 ✅。这条消息已转给 Lead。`

无 postThreadReply 返回 `{ok:false, stage:"approval_anchor_feedback_failed", reason:"thread reply sender missing"}`；await false 或 throw 返回同 stage 和明确原因。成功返回正常 outcome，沿用 cursor 推进。禁止只 audit 然后成功吞掉发送失败。保留既有 superseded-card 分支，不覆盖其通知协议。

- [ ] 每个行为先加 red case 再最小实现：五中文无 anchor、英文无 anchor、wrong card/channel、多个待答门均不写 response，只作无对象猜测的提示。
- [ ] 当前卡中文 reply 经真实 ingress 写 passed:true 并调用确认 reaction；旧轮不批准新轮、非 founder、不存在 gate、问题句、普通讨论不触发新提示。
- [ ] 验证 false、throw、missing sender 返回 process_failed，cursor 不越过该消息；发送恢复后同消息重试成功且 gate 保持未答。重建 cursor store 使用已保存水位不重复消费。现有 retry dead-letter 行为继续有效。
- [ ] 保留 Lead handoff 失败路径；不因新增解释丢失原消息。发送成功与 cursor 落盘间 crash 可能重复解释，这是至少一次副作用的已知边界，不影响批准安全。
- [ ] 跑 `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/founder-reply-deliverer.test.ts src/__tests__/founder-review-response.test.ts src/bridge/__tests__/text-approval-source.test.ts` 后提交。

## 3. 卡片与说明同步（严格 red → green → commit）

修改 packages/teamlead/src/bridge/founder-thread-notifier.ts、gate-materializer.ts、founder-reply-deliverer.ts 现有 anchored-neither 文案，及 approval-signal/text-approval-source.ts 注释。

- [ ] 修改 founder-thread-notifier.test.ts、gate-materializer.test.ts 的实际发送正文断言：包含「通过」与中文词表并继续明确 reply-to 当前卡。先运行失败，再更新正文；保留 head、卡绑定、打回说明和 reaction 说明。
- [ ] existing neither explainer 加中文批准说明，保留其既有一次/轮语义；对应测试验证实际传给 postThreadReply 的文本。
- [ ] 这些是 Discord 文本而非 HTML/UI 页面。验证真实 payload，不宣称浏览器渲染或真实房间 QA。没有注入视觉捕获命令，也不发送测试消息到生产。
- [ ] 运行相关三文件测试后提交。

## 4. 验证与交付

- [ ] 运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。新 scripts/__tests__/*.test.sh 若出现必须逐个跑；本方案不新增 shell 测试。记录完整退出码与日志，既有失败也不能称全仓通过。
- [ ] 无 schema 变化；以实际 ingress 失败恢复/游标重建测试证明 replay 行为，以原有 writer stale/run/digest 测试证明负 guards。rollback 为 revert 本单代码；不写旧轮 verdict，不调整 48h 超时。
- [ ] inbox 检查、更新 progress、提交证据。code review 按 codex-author 合同开 review_code gate，再 request-review，检查 reviewVerdict；CHANGES 后修复重测并新开评审。不运行 raw codex exec，不自行派评审或 QA。
- [ ] 按 engineering/doc/milestones/README.md 写 FLY-2461.md 为 literal last commit，创建 PR；最终 HEAD 必须有新鲜评审，若 milestone 或修复改变 head 必须以新 HEAD 请求。必要 force push 先取得 Lead 对本次重写批准。
- [ ] 通过 ask --report 报告完整证据/限制。依 runner-memory closeout 约定记录可复用经验（遵守 memory 写入权限）；运行 `complete --route needs_review --pr <NUMBER>`。完成 phase 后按 controller 要求 park，目标是否终结遵守 phase keep-alive 合同，不自行 merge/deploy。

## 验收对应

产品 1/2/4 → 任务 1 的中英 helper、五中文词和语言覆盖测试；产品 3 → 任务 1/2 的确定性、identity/current-card/negative guards；非 anchored 反馈 → 任务 2 的实际发送与失败重试；可发现性 → 任务 3；仓库 gates 与工作流交付 → 任务 4。历史 FLY-2244 消息 anchor 未知，不作为已经确认的根因证据。
