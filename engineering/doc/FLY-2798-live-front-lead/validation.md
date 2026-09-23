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
