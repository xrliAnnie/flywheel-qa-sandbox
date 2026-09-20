# FLY-2753 本机定向测试守则 — 交付验证
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: plan.md

## 本阶段范围

只生成探索、调研、实施计划和 founder HTML。未改生产代码、runner 守则、CI 工作流或共享身份。设计工作树的 baseline 缺口与另一工作树已实现的参考状态均在 plan.md §0 明示。

## 图表

- `flow.mmd` 与 `structure.mmd` 均使用 Mermaid flowchart。
- 本地 `mmdc -i <source> -o <svg> -w 1000 -b white --svgId FLY-2753-d1|FLY-2753-d2`，每图首次运行加一次标准参数重试，均 exit 1。
- 原因：Chromium `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`。
- 按注入 fallback 使用明确 `DIAGRAM PENDING LOCAL RENDER` 提示和可展开源码；未使用 CSS 假图或远端渲染服务。已报告 Lead，receipt `8191a54f-ed8a-4562-9b78-69aaf5f09d40`。

## 评论层定向检查

2026-09-20 使用 Node vm 与最小 DOM harness 执行 HTML 的实际单一内联脚本，验证：

- 单一 `script nonce="__CSP_NONCE__"`；无 inline event handler、外部脚本/样式/字体、自带 CSP meta 或 unsafe innerHTML。
- 每个 section 有评论输入；输入事件自动保存，key 包含 location.pathname；换路径不会读取另页意见。
- localStorage 拒绝访问仍可编辑和复制。
- 恶意样式意见以 textContent 原样显示；不执行派生 HTML。
- 汇总首行精确为 `【页面意见汇总】FLY-2753`；含各节标题。
- 超长中文/emoji 意见按最多 1800 Unicode 字符切分，重组不丢字符，每段重复 marker。
- clipboard 成功、API 缺失、promise 拒绝三路径；后两者进入 execCommand fallback。

结果：PASS。测试脚本仅为临时验证 harness，不进入产品代码；此项不是 Chromium 视觉或实际浏览器 CSP 执行证据。本地浏览器因上述权限无法启动。

## 其余检查与边界

- `git diff --check` exit 0。
- 本阶段仅文档/HTML，没有受影响的包 API/type，包 build/typecheck 不适用。
- 未运行本机 `pnpm test:packages:run` 或全仓构建。
- 本分支不能执行缺失的 `sync-phase-protocols.mjs`；实现前基线检查会明确失败，未谎称 9 projections 通过。
- 设计 review 与托管页的最终结果以本文件后续记录和 progress 指针为准，不继承参考分支的测试结果。


## 发布与格式检查（2026-09-20）

- `pnpm lint` exit 0：检查 1894 个文件，14 个既有 warning，未应用修复。
- HTML 提交 `b0f773db3` 已 push。
- 注入命令 `publish-report --project test-slot-3 --publish-only` 成功，reportId `c447441e0bd7ac6926b61b1480a743e3`；publishOnly=true、delivered=false，未发送频道消息。
- 返回 URL：`http://127.0.0.1:54945/fw-reports-176a2a/r/c447441e0bd7ac6926b61b1480a743e3/`。这是测试发布器的 loopback URL，不能证明 founder 可远程访问；已向 Lead 单独披露。
- 对该 URL 实际 GET 为 HTTP 200、12054 bytes、nonce placeholder=0，单一 script nonce 与发布器注入的 CSP script-src nonce 相同。
- `DESIGN-HTML ready` 回执 `3f3caf69-a6e0-41b2-a9b0-3678b544dd32`；发布限制和验证报告回执 `b109e08b-bdae-4911-859d-125d2b41168b`。
- 正式设计 review request `2ea030e8-53a6-486b-a95a-b4e8b2f946b8` 已 accepted；question `cbd3b8fe-bf78-410b-9c57-db00f5b43221` 当前未答。尚未运行 design completion。
