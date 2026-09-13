# FLY-2517 换体后旧唤醒退役 — 调研
Issue: FLY-2517 (https://linear.app/geoforge3d/issue/FLY-2517/病根-引擎-proven-dead-replacement-换体后仍向旧体投-phase-wakerework-wake20-分钟后判)
日期: 2026-09-11
基于: plan.md

## 本节点验证范围

只验证设计文档与 HTML，不运行引擎行为测试，不声称修复已实现。设计评审 R1 questionId=`baa4a713-c5a1-4e64-9804-cc6528b2ba3e`，requestId=`2628e8ed-1f6f-4011-9e94-57749d8dc372`，effective `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`，2026-09-11 恢复后通过 `check` 重新确认。

## Mermaid 本地渲染：失败并按合同降级

`mmdc` 11.12.0，每图首次及标准重试均失败；保留 `flow.mmd`、`model.mmd`，没有生成 SVG，没有使用远程渲染服务。HTML 对两图均显示 `DIAGRAM PENDING LOCAL RENDER`。

```sh
mmdc -i engineering/doc/FLY-2517-replacement-wake-retirement/flow.mmd -o engineering/doc/FLY-2517-replacement-wake-retirement/flow.svg -w 1000 -b white --svgId FLY-2517-d1
mmdc -i engineering/doc/FLY-2517-replacement-wake-retirement/model.mmd -o engineering/doc/FLY-2517-replacement-wake-retirement/model.svg -w 1000 -b white --svgId FLY-2517-d2
```

四次结果均 exit 1，核心错误：`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer: Permission denied (1100)`。没有请求/绕过沙箱授权。此限制也意味着没有本地 Chromium 视觉或真实 CSP 执行验收；不能把 DOM 检查报告成浏览器验收。

## HTML 可执行 DOM 验证：通过

使用现有 happy-dom 20.10.6，在独立模拟 origin/path 上执行 HTML 的实际单一 inline script；Node vm 语法检查通过。输入来自测试直接 DOM 事件，没有替代产品脚本。

| 验证 | 结果 |
|---|---|
| 7 个 section / 7 个评论输入，包含整体意见 | PASS |
| 单一 script，exact `nonce="__CSP_NONCE__"`；无自定义 CSP meta / inline handlers / 外部依赖 | PASS |
| 输入事件保存、同 path 重载恢复、不同 path 隔离 | PASS |
| localStorage get/set 抛错仍可输入、聚合与复制 | PASS |
| clipboard 正常、不可用、Promise 拒绝后的 execCommand fallback | PASS |
| 长意见分成 4 段；每段 exact marker 开头、少于 1800 UTF-16 单元，不切断 emoji surrogate pair | PASS |
| copy-all 保留每段 marker；空意见时禁用 | PASS |
| `<img src=x onerror=alert(1)>` 只作为文本输出，无新增 img 节点 | PASS |
| 唯一 DOM IDs；静态 HTML 使用 Apple-light / viewport / 系统字体 | PASS（静态检查；非视觉验收） |

实际产品脚本没有 innerHTML 写入、外部 fetch 或外链脚本。图表为规定的失败占位，不能称为已经渲染。

## 托管页验证

已使用 `publish-report --html engineering/doc/FLY-2517-replacement-wake-retirement/design.html --project flywheel --publish-only` 发布提交版本 HTML。

- URL: https://fw-reports-a53de2.vercel.app/r/d2398627277aa69e0e0845aad60b19b2/
- reportId: `d2398627277aa69e0e0845aad60b19b2`
- `publishOnly=true`、`messageId=null`、`delivered=false`：仅发布成功，没有发送频道消息，符合本任务授权。
- `verify-report --url <上述 URL> --expect FLY-2517`：`ok=true`、HTTP 200、noncePlaceholder/scriptCsp/scriptNonce/expect 全部 pass、warnings=[]。
- `hasInlineSvg=false` 与既有两张本地渲染失败占位相符；未宣称已生成图或完成浏览器视觉验收。

HTML 保持已批提交 `8c1042521` 的原字节。托管页实际替换了 nonce 并注入对应 CSP；没有自定义 CSP 或外部脚本。

## 恢复审计与收尾授权

恢复后 `turn` 确认 design / epoch 2 / 本次 execution，工作树初始干净，Bridge health 正常（build `ca869ad6d`）。重新读取项目 onboarding、前序三份设计及 Lead 问题 `a1aa3413-1dbd-4025-83bd-7d8c57caaabc` 的裁定，保留 FLY-2518 两项并入范围；不重做既有研究或修改业务代码。

R1 的完整 verdict、findings、advisories、findingKey 见同目录 `design-review.json`。五项建议为：退役待办的项目隔离、父通知 pending/sent 状态、告警文案消费者、plugin enqueue 消费者、claim 四值处理。已通过 ask --report 回报 Lead。

Lead 指令 `[lead-instruction f5849ab0-3b01-4899-b555-9908e0477808]` 要求只收尾、不改已批计划、不重审。指令到达前本节点曾起草建议修订，现已撤回；`plan.md` 的技术内容和 `design.html` 与既有提交 `8c1042521` 完全一致。advisories 留给 Lead 处置，不伪造为已实现。计划中的“设计评审待提交”是获批前保留的原文，评审状态以 `design-review.json` 为准。

恢复后再次执行前序 `/private/tmp/fly2517-report-check.mjs`，上述 DOM 检查全部 PASS。没有重复启动被沙箱拒绝的 Chromium，图表与视觉验收边界保持不变。

完成命令首次返回 `consume_pending_mail`，按其提示通过 inbox/check 消费问题 `cfc1e146-a1ae-4792-a645-d4e71a3f5a36`。Lead 再次裁定不采纳建议修订，仅在 plan 末尾新增一行 Follow-ups 引用；本节点遵照执行，不修改技术设计、不重审，随后使用返回的 exact drain receipt 重试原完成 route。
