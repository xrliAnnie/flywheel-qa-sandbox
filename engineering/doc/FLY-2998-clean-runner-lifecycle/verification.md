# FLY-2998 干净房间执行流程 — 调研
Issue: FLY-2998 (https://linear.app/geoforge3d/issue/FLY-2998/qa-sbx-fly-2925-clean-room-synthetic-runner-lifecycle-task-2)
日期: 2026-09-28
基于: plan.md

## 设计产物核验
- pnpm lint：退出 0，检查 5214 文件，25 个现有警告；没有自动修改文件。
- git diff --check：通过。目标正文 qa-sandbox/fly2925-clean.md 不存在，设计未实施。
- HTML 静态检查：六张卡片均有评论框；单一 nonce 占位脚本；无外链资源、内联事件属性、innerHTML 或自设 CSP。
- Node vm 中执行实际内联脚本，使用隔离 DOM/存储替身：评论保存键包含页面路径，汇总保留标题及原始文本，4200 字长意见分成三片且每片 <=1800 字符并带正确首行；剪贴板成功、缺失、拒绝三条路径均通过；存储抛错仍可汇总复制。此证据不冒充真实浏览器运行。
- 两张 Mermaid 图分别本地 mmdc 渲染失败，随后各按 -w 1000 -b white --svgId FLY-2998-d1/d2 重试一次仍失败。错误为 Chromium MachPortRendezvousServer bootstrap_check_in Permission denied (1100)。按合同显示 DIAGRAM PENDING LOCAL RENDER，保留本地源码，无远程渲染。视觉核验未完成。
- request-review 代码审计：review-request-coordinator.ts 在 build prompt 首字节拼接完整 local-test-policy.md；内容与注入标记块一致。评审请求消息也显式带该完整前缀；不委派任何全包测试。

## 范围
仅本目录新增设计产物；没有更改产品源码、服务配置或合成正文。真实生命周期恢复及三段正文历史由后续授权阶段验收，不在此声称通过。
