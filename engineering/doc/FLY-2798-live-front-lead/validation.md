# FLY-2798 前台快答与后台 Lead — 调研
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-23
基于: plan.md

## 设计验证范围
本文件仅记录文档/交互交付检查，不是实现测试或真人语音 QA。
- 本地 `git diff --check` 无错误。
- HTML 8个 section 均有 textarea；单一 script nonce=__CSP_NONCE__；无自带 CSP meta、无 inline handlers、无外部依赖。
- `node check-report.cjs founder-design.html` 使用 Node VM + 最小 DOM harness 验证：path-scoped localStorage；存储不可用不中断；实时聚合；每段 ≤1800 字符并重复精确 marker；clipboard 缺失与 Promise rejection 两种 fallback；用户派生文本保持原始 value/textContent。
- JavaScript 经 `node --check`。以上不等于浏览器实测。

## 本地渲染失败的真实记录
2026-09-23T18:09Z，flow.mmd 与 identity.mmd 各执行两次（首次 + 标准参数重试）：
`mmdc -i <name>.mmd -o <name>.svg -w 1000 -b white --svgId FLY-2798-d1|FLY-2798-d2`。
四次均在本地 Chromium 启动阶段失败：`MachPortRendezvousServer ... bootstrap_check_in ... Permission denied (1100)`，未生成 SVG。
依任务 h 与 Lead 答复 d02a893d-929b-4509-a9e3-624114156b6d，HTML 使用 `DIAGRAM PENDING LOCAL RENDER` 明示占位，带 repo .mmd 路径与唯一 id；源文件一起提交。Lead 同意在其侧本地渲染后替换；禁止远程渲染或伪造图。
Chrome DevTools MCP new_page 返回 `MCP tool call requires approval, but approval policy is never`；没有浏览器截图、视觉或真实 CSP 交互验收。没有请求额外权限或另走绕过路径。

## 设计审查
R1 requestId=16c48913-5c24-4820-b791-8e232e685f7f，questionId=67af40da-8c5d-46dd-a484-0470817a661d；已 accepted，提交基线 92104ad4c。结论待返回，不能按 bare stage 或 pending 视为批准。
R1 期间收到 2796 草案 c7189944e，plan §2.1 九项已对齐，最终 pin 待 Lead 给审查通过版本。最终交付必须复审包含这些变更的版本。

## 待完成交付检查
有效 APPROVED；最终 HTML commit/push；publish-only；托管 HTTP 200、nonce/CSP 一致、source/content 对齐；向 Lead DESIGN-HTML ready；closeout receipt；phase_design_complete + park。

## R1 处置
有效 verdict=CHANGES_REQUESTED；完整 findings 去除投递 nonce 后存 review-r1.json。
- HIGH delegation-closure-and-live-restate：接受；§6.5 使用关闭并永久隔离原 Live 会话，明确不依赖 thinking.append resolve；commentary-only 不退回模型复述；不回灌已播报正文/已完成问题；新增重复请求、超时、逐字/改写重复检测与真实 QA 失败规则。
- MEDIUM shared-type-surface-typecheck-scope：接受；所有5个下游逐包 typecheck，仍不跑全量。
- MEDIUM doorbell-bridge-url-env-name-split：接受；已核 index.ts:976，实际 child process 中统一 URL resolver，列四种 env 回归；尚不认定历史事故根因。
- MEDIUM no-latency-budget-for-2s-gate：接受；§10.1 加明确未实测的2000ms预算与10/10失败处置，不改验收。
- MEDIUM t0-hard-gate-blocks-everything：接受；T0前离线与T0后集成任务明确拆开；九项已对齐上游草案。
- LOW sendtext-to-speak-receipt-dropped / close-resumehandle-contract-unstated：接受；写明 audit/error、catch、supportsResume=false、undefined与close异常语义。
- MEDIUM announcer-takeover-rebuilds-live-unconditionally：非阻断 Follow-up，§10.2 保留 Lead 已接受的安全基线，频繁重连实测；优化空闲接管需另证无turn ID的晚帧安全。不是覆盖HIGH的治理裁定。
