# FLY-2920 交付检查 — 调研
Issue: FLY-2920 (https://linear.app/geoforge3d/issue/FLY-2920/病根修复-4-重启和负载不再把系统自己打垮删卡顿自杀与-250ms-起体判败审查作业与孤儿身份只认领退休一次内存手刹不锁存6-张-59)
日期: 2026-09-26
基于: plan.md

## 本地交付检查

- 文档基线提交 `b91d646eb` 已推送 origin/flywheel-FLY-2920。
- 评审 gate `dbb3852e-bf19-42c4-9789-c88d83414d07`；request `55832709-c4d7-4916-ab7e-7e88c16d96f6`，accepted=true、skipped=false。有效裁决仍待回收，不视为通过。
- `review-flow.mmd` 与 `data-model.mmd` 各本地 mmdc 2 次，均失败。标准命令为 `mmdc -i <name>.mmd -o <name>.svg -w 1000 -b white --svgId FLY-2920-d<N>`。
- 原因：Chromium `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`，发生在浏览器启动、不是 Mermaid 内容渲染完成。未使用远程绘图服务。HTML 显示 `DIAGRAM PENDING LOCAL RENDER` 并保留转义后的源文本；不声称有 SVG。
- Node VM 控制器模拟检查通过：7 个 section 各有意见框；一个 nonce 占位 script；无 inline event handler、外部依赖或自写 CSP；localStorage 按 pathname 隔离并捕获异常；恢复保存值；字面恶意标签仅当文本；每个长文本 chunk≤1800 JS 字符、各首行精确为 `【页面意见汇总】FLY-2920`；emoji 不拆 surrogate；clipboard 成功、缺席 fallback、promise reject fallback 均通过。
- 初次 harness 等待跨 VM Promise 的 microtask 不充分造成假失败；改为等待一轮 setImmediate 后通过。未因此修改页面逻辑。
- diagram-design self_check 未通过：无 accessible SVG（上面的真实渲染失败）；该通用工具还要求 motion script/data-motion-root。任务强制意见脚本与 nonce，且此页静态，所以不为通过该工具添加无意义 motion 控制或伪造 SVG。
- 未做浏览器截图、真实布局或实际 CSP 下执行验收；只能将上述称为源码/控制器检查。未运行产品代码测试，未启动测试房、重启或部署服务。

## 待完成

有效评审 → 最终页状态刷新 → commit/push → publish-only → 托管 HTTP/CSP/source 校验 → Lead URL report → exact complete/park。
