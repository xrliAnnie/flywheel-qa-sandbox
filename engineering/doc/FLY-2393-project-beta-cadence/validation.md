# FLY-2393 项目 beta 分频 — 调研
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393/1143b6-bridge-按项目分频独立泳道只阻塞-3每项目-beta-分频目标态不阻塞-flywheel-only-每周-release)
日期: 2026-09-10
基于: plan.md

## 设计交付验证（不代表实现验收）

- `git diff --check`：通过。
- HTML 15.8 KiB，7 个 section/card 均含评论框；只有一个 `script nonce="__CSP_NONCE__"`，无外部依赖、无自定义 CSP meta、无 inline event attributes。
- 使用已安装的 happy-dom 20.10.6 对真实生成 HTML 执行 controller：同路径刷新恢复、不同 pathname 不串评论、用户 HTML 作为纯文字、长意见分成每段不超过 1800 字且重复精确首行标记、正常剪贴板、剪贴板不存在 fallback、promise 拒绝 fallback、localStorage 禁用仍能复制，全部通过。
- 验证驱动位于 `/tmp/fly2393-html-check.mjs`；运行 `node /tmp/fly2393-html-check.mjs engineering/doc/FLY-2393-project-beta-cadence/founder-design.html`。DOM 模拟不能证明浏览器视觉/CSP enforcement；托管后另核实 HTTP/CSP/nonce。
- 两张图均执行下述本地命令两次（首次 + 标准参数重试），全部 exit 1：
  - `mmdc -i engineering/doc/FLY-2393-project-beta-cadence/d1-flow.mmd -o engineering/doc/FLY-2393-project-beta-cadence/d1-flow.svg -w 1000 -b white --svgId fly2393-d1`
  - `mmdc -i engineering/doc/FLY-2393-project-beta-cadence/d2-model.mmd -o engineering/doc/FLY-2393-project-beta-cadence/d2-model.svg -w 1000 -b white --svgId fly2393-d2`
- 相同错误：`Failed to launch the browser process`；`bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer... Permission denied (1100)`。未升级权限、未远程渲染，按任务明确允许的替代交付 `DIAGRAM PENDING LOCAL RENDER` 与真实 `.mmd` 源。
- 未修改任何调度/发布实现；计划中的新增测试和真实 A11 双项目 beta 验收尚未执行。

## 评审 / 发布

首轮 question `2873598d-7c54-4296-a791-439d83c6294f`，request `17ce1582-355b-45bd-b820-20756f4b0592`，已 accepted，等待有效 verdict。最终结果与托管验证在完成前补充。

## R1 修订验证

R1 有效 CHANGES_REQUESTED（1 HIGH、8 MEDIUM、2 LOW），完整结构化记录见 review-r1.json。HIGH 及多数实现合同建议已纳入；独立 Bridge 存活告警明确交 Lead follow-up。作者另补 queue:max 与 beta preflight 先于共享锁，保护 pending 客户任务。

作者 runner 原渲染失败仍是实测事实，不能推出其他执行环境失败。R1 reviewer 本地成功产物 `/tmp/fly2393-d1.svg`（SHA256 `1bf1661f584a7b5eb29ef310dd03b0db4bd1b00a49496129b52a04485bc7a1b9`）、`/tmp/fly2393-d2.svg`（`41b8ce82f22619323ead1c6094979f843c13f018f22d50f1bd4efca21faa2468`）已核对标签/XML，将全部 id 和 CSS/url 引用一致加 issue/图序号前缀后收入仓并内联。没有再用占位符。

happy-dom 对 Mermaid SVG 的 foreignObject/嵌套 HTML 解析不完整；最终脚本回归仅在测试输入中把 SVG 替换为静态空图容器，生产 HTML 保留完整原图。SVG 另做 XML、安全标签与跨图 ID/引用验证；不能把这个 DOM 模拟称作完整浏览器视觉验收。Chrome DevTools 连接查询长时间未返回，停止这次可选只读查询；sips 不支持该 SVG，未得到作者截图。下一轮请求 reviewer 核查实际页面。

## 有效最终评审

2026-09-10 R2：reviewVerdict=APPROVED，reviewerVerdict=APPROVED，request 97975305-bb76-435c-b0bb-100dd0484728，question 9c9dff1e-394c-4874-8096-b0a9e1aedc68。5 条非阻塞建议按 Lead 指令仅进入 plan §12 Follow-ups；完整原文见 review-r2.json。审批后的文档变更仅为结果元数据、建议归档与交付记录，没有继续修订实现行为。

最终完整 HTML 使用 parse5 HTML5 parser 校验：0 parse errors、2 个 SVG、7 个 section、7 个评论框、69 个唯一 ID；SVG 后的复制按钮仍处于正确 DOM，且无占位图。与 happy-dom 评论 controller 运行检查共同覆盖结构/交互；未将其冒充作者浏览器截图。
