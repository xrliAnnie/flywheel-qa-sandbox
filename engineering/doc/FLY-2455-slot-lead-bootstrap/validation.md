# FLY-2455 529 房启动诊断 — 调研
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-08
基于: plan.md

## 本设计已验证

- 已持 design TURN epoch 1 开展文档工作；不修改实现程序，不运行 slot deploy/teardown，不更动生产服务。
- 已独立执行 host tmux gate 到一次性临时目录，exit 0；真实 verifier 的相等 PID/失败 probe fixture 返回 1；证据限制见 research.md。
- exploration/research/plan 文档头符合注入的 DOC-FLOW；`git diff --check` 通过。
- `python3 engineering/doc/FLY-2455-slot-lead-bootstrap/build-report.py` 生成约 14 KB、自包含的 `founder-design.html`。
- DOM（文档对象模型，即浏览器用来表示页面元素的结构）逻辑验证通过：7 张卡片都有批注、输入即保存、同页面恢复、不同 pathname 隔离、存储拒绝时仍可用、输入只作为文本、长意见分段不超 1800 字符、每段精确 marker、整体复制、clipboard API 缺失/拒绝两种 fallback。检查只有一个 nonced inline script，没有 handler 属性或自定义 CSP meta。验证器运行在 linkedom + VM 中，不冒充真浏览器/CSP 执行证据。

可重跑：

```sh
node engineering/doc/FLY-2455-slot-lead-bootstrap/validate-report.mjs \
  engineering/doc/FLY-2455-slot-lead-bootstrap/founder-design.html \
  /private/tmp/fly2107-html-qa/node_modules/linkedom/esm/index.js
```

最后一参为本机现有 linkedom 安装入口，可替换成其他本地安装路径。验证器第一次对被拒绝的异步 clipboard Promise 等待过短；改为等待一次事件循环后全通过，报告页面无需修改。

## 图形和视觉限制

`flow.mmd` 与 `model.mmd` 已完成。每张图都在本地用 `mmdc -i <source> -o <output> -w 1000 -b white --svgId FLY-2455-d1|FLY-2455-d2` 运行一次并按同样标准 flags 重试一次。四次均返回 1：Chromium 的 `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`。

按任务明确规定交付 `DIAGRAM PENDING LOCAL RENDER` 提示并保留 Mermaid 图源；未使用远程图形渲染、运行时 Mermaid 或 CSS 假图。恢复本地渲染能力后运行上述两个 mmdc 命令再执行 builder 即可嵌入 SVG；两个 svgId 独立。

Chrome DevTools 可列出既有页面，但打开本报告被工具拒绝：`MCP tool call requires approval, but approval policy is never`。没有尝试绕过权限，也没有声称完成真浏览器视觉检查。托管 HTTP/CSP 验证结果如下。

发布后验证：`https://fw-reports-a53de2.vercel.app/r/dcddc311ac6aee1da075dec2ad4474bc/` 返回 HTTP 200；`__CSP_NONCE__` 占位符为零；只有一个 inline script，nonce 与注入 CSP 匹配；两处待渲染提示保留；没有外部 script。页面 bytes 来自已提交并推送的 28f7fae04，后续评审修改的是实施计划，HTML 内容未漂移。publish-only 返回 messageId=null，未向频道发消息；已通过 DESIGN-HTML ready 报告把 URL 交给 Lead。

## 设计评审游标

Round 1：question `075b317f-de8b-40c8-8c3d-af45c19b79ee` / request `a6d540b2-7732-4bd4-bc98-882a758673de`，有效 CHANGES_REQUESTED。查证后在 6e6cc0d32 修正两项 HIGH：已有 claude-lead EXIT trap 的覆盖，以及真实 Terminal GUI 测试的排除；同时处理七项 MEDIUM/LOW，详见 plan 的 env-i、末次采样、CI 枚举、tmux 双端、证据 residue、sender preflight 合同。

Round 2：question `33ecd719-d601-4915-8bb8-f7e66d00134c` / request `9851a352-783a-4161-87ca-ca89ea90b0bf`，有效 CHANGES_REQUESTED。补全第二处 EXIT 清除点、实际安装状态单一判据及 OFF 生产清理控制；补 server 停止前的结果记录与实际 shell 退出的区分；修正 release-contract 非 Vitest 命令，逐项补全锁释放/再认领路径。独立只读审计确认同 shell 只有两处 EXIT 所有权修改；两个无服务 shell fixture 分别证明旧安装点替换诊断 trap、真实 commit_once 清掉诊断 trap。未运行真实 slot。

Round 3：修订计划已提交并推送为 `136794572`；question `bdd61544-2b56-4257-8e1d-a8399854c530` / request `33c78f8a-aba4-42d7-a70d-f53079416d77` 有效 `reviewVerdict=APPROVED`，reviewer 原始 vote 同为 APPROVED。三条非阻塞 advisories 已报告 Lead 并记录于 review-handoff.md；通过后的 plan.md 字节不再修改。Lead 指令 `[lead-instruction 24007c2d-d453-4ff7-a146-4ae694679270]` 要求只在最终评审通过后再报告 DESIGN-HTML ready；中间稿留仓库，遵照执行。

## 尚未属于完成证据

本设计未证明真实 slot 恢复、未执行完整起拆、未收到测试消息、未跑实现代码的 CI；这些仍是 C3/C4/C5 的硬条件。诊断先行由 Lead 接受，不等于根因已知或放弃完整验收。

## 设计交付状态

探索、调研、实施计划、可批注 HTML、图源与验证说明均已完成；设计评审有效 APPROVED。最终交付按 progress.md 游标、DESIGN-HTML ready 报告和 phase_design_complete 事件确认。此处“设计交付”不表示 C1–C5 的代码与真机验收完成。

最终 APPROVED 后再次以 publish-only 发布，最终 URL 为 https://fw-reports-a53de2.vercel.app/r/7b7f776d0d6f6188d951189c862b6693/ ，messageId=null。再次核验 HTTP 200、七处批注、单 script nonce 与 CSP 匹配、无占位 nonce、两处待渲染提示；HTML 内容保持不变。
