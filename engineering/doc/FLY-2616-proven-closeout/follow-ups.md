# FLY-2616 审阅通过后的 Follow-ups — 调研
Issue: FLY-2616 (https://linear.app/geoforge3d/issue/FLY-2616/land收尾-合入后收尾必须能证明每个体已消失session-行缺失窗口不存在心跳超时goneworktree)
日期: 2026-09-15
基于: plan.md

第4轮 effective reviewVerdict=APPROVED。以下是非阻塞建议，随报告交 Lead 选择后续处置；不重开设计审阅，不将它们伪装为已实现或已验证。

1. **MEDIUM — hold-write-failure-still-falls-into-log-only-catch**：holdWorkflowLandNode 本身在并发状态改变下返回 ok:false 时，现有 holdLandRun 会 throw 到 log-only catch。建议后续明确重读当前 run/node：仍属于同一待处理意图则下次以新 tuple 重试；已前进则记录 superseded disposition；持续写失败走既有项目升级。该项不改变本轮有效 APPROVED。
2. **LOW — section6a-fixture-names-superseded-entry-point**：§6 A 第一条旧措辞写 ensureLandOperation 捕获 snapshot，§2.5 的最终契约已明确捕获属于 prepareLandIntent。实施阅读应以 §2.5 的完整 provider 路径为准；不能手填 verifiedTargets 绕过 provider 来让 fixture 变绿。冻结 plan 不作审批后改写，本阅读提示保留该审阅发现。

其他显式限制：Mermaid 本地 Chromium 因 MachPort 权限失败（含标准重试），使用指令允许的 DIAGRAM PENDING LOCAL RENDER 标记；批注测试是静态/JS VM 验证，不是浏览器 QA。四实例沙盒 replay、红绿测试、精确头 CI、ship report 均由后续实施/QA/授权 ship 流程完成。
