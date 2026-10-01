# FLY-3122 Claude TURN 金丝雀 — 探索
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: 无

## 一句话结论

把本单限定为一次可审计的传输探针：在取得 design TURN 后，只向仓库根目录 `probe.txt` 追加两行稳定标记，提交到当前 feature branch；不修改产品代码、不发版、不部署。

## 已确认事实

- Issue 的稳定 owner 是 `FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c`，执行体标签是 `claude`。
- 当前 design TURN 已由 `flywheel-comm turn` 返回 `yours`：epoch 为 `1`，activation 为 `activation:4514c33a-ba5c-4eb3-a046-08bb14e6b209:24efb425-bd4f-4d69-a813-e120e1e1bf1a:eng_design:1`。
- 当前 mailbox 返回 `No instructions.`；因此本次用 TURN 本身作为“传输已到达”的权威回执。
- Issue 和动态任务正文没有内嵌逐字 marker literal；仓库对应的 FLY-2127 canary driver 是该字段的 source of truth。它为 `claude` case 派生出 `…-CLAUDE-BOOT` 与 `…-R4-CLAUDE`，并以完整行匹配二者。先前向 Lead 发出的非阻塞问题 `66c1ce36-2433-4193-94bd-0a127dca1b1b` 不再阻塞，因为已经从 driver 取得精确证据。

## 成功标准

1. `probe.txt` 只追加以下两行，不覆盖已有内容：

   ```text
   FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-CLAUDE-BOOT
   FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c-R4-CLAUDE
   ```

2. 变更被本地提交并推送到 `project-slot-2-FLY-3122`，不触碰 `main`。
3. 设计文档、Founder HTML、设计审查和 phase completion 按本节点合同完成。
4. 不创建产品实现、不运行部署、不请求 ship authority、不合并 PR。

## 备选方案

### A. Driver 派生的 BOOT + R4-CLAUDE（采用）

两行都直接来自 FLY-2127 canary driver 的构造规则。BOOT 行证明执行体完成初始落盘，R4 行是该 `claude` case 的完成标记；当前工作流另以 `flywheel-comm turn` 的 `yours` 结果完成授权确认。

### B. Owner + TURN 身份自定义行

可以记录更多本次 execution 元数据，但 harness 不匹配这些自定义 literal，无法成为 canary 的权威成功证据，因此拒绝。

### C. 把完整 mailbox / TURN JSON 写入文件

信息最多，但会把易变字段和工具输出格式固化进仓库，增加噪声，也可能把未来新增的敏感字段带入版本历史，因此拒绝。

## 设计边界

本设计验证的是“这个执行体收到了 TURN，并能在持有 TURN 时留下仓库标记”。它不验证 FLY-2127 的完整产品行为，不修改 native wake 实现，也不声称覆盖 mailbox 投递、跨重启恢复、部署或生产运行。
