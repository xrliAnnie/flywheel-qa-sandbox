# Implementation: [XHS-deep] backlog consolidation — FLY-503

**Issue**: FLY-503 (Consolidate FLY-349 XHS-deep backlog issues — cluster by theme, merge duplicates → interactive review HTML)
**Date**: 2026-06-22
**Status**: Phase 1 done (提案 HTML 已交付 Annie) · Phase 2 待 Annie 导出决策后执行
**Owner**: Tadashi (Runner: Ron)

## 背景

FLY-349 v2 deep-scan engine 跑完 10 批 review，建了大量 `[XHS-deep]` 前缀的 Backlog
issue。很多主题重叠、可以用同一个 issue 代表。本任务把这批 issue 看一遍、做
consolidation，方便后续使用。

**精确范围**：`status=Backlog` + `label=Flywheel` + title 带 `[XHS-deep]`，共 **49 条**
（含较早的 FLY-374/375/377/379/380；已排除 FLY-503 本身；已 Canceled 的不计；
FLY-436 已不在该集内，早前已转 GeoForge3D→GEO-431）。

## 方法

1. `list_issues` (label=Flywheel, state=Backlog, query=`[XHS-deep]`) 拉全 49 条。
2. 按主题聚成 **10 个 cluster**。
3. 每条给一个默认建议（角色）：
   - **代表 (representative)** — 本组合并目标，保留并在 Phase 2 补充各来源 provenance。
   - **合并 (merge)** — 建议并入代表，被并的标 `duplicateOf` + Canceled。
   - **独立 (independent)** — 主题虽同但内容不同，独立保留。
   - **跨项目路由 (route_out)** — Joycon / GeoForge3D 域，默认**不并入 Flywheel**，待 Annie 拍。

**Propose-first（核心约束）**：本阶段只出提案，**在 Annie 导出决策之前绝不动任何 Linear
issue**。

## Cluster 与合并提案

| Cluster | 代表 | 建议合并入代表 | 独立保留 | 跨项目路由 |
|---|---|---|---|---|
| 多-agent 编排 / coding-agent 平台 | FLY-379 | FLY-375, 427, 431, 455, 476 | FLY-456, 478 | — |
| Agent 间通信 | FLY-410 | FLY-417 | FLY-402 | — |
| 记忆与上下文 | FLY-401 | FLY-420 | FLY-418, 453 | — |
| Skill 生态与 marketplace | FLY-434 | FLY-380, 416, 470 | — | — |
| 可建的具体 skill | FLY-437 / FLY-422 | FLY-426, 482 → 437 · FLY-407 → 422 | FLY-419 | — |
| 研究自动化 / 前沿模型 | FLY-425 | FLY-454 | FLY-423, 442, 408 | — |
| 视频 / 视觉 / 设计 / 语音 | FLY-439 | FLY-465 | FLY-441, 479, 374, 435 | FLY-451 |
| CC 平台特性 / 工作流 / 模型 | — | — | FLY-444, 471, 473 | — |
| Agent 安全 / 浏览器 | — | — | FLY-458, 459 | — |
| 硬件 / 3D（跨项目） | — | — | — | FLY-403, 415, 457, 460, 377, 438, 477 |

**计数**：8 代表 · 15 合并 · 18 独立 · 8 跨项目路由 = 49。全采纳合并则 **49 → 34**。

每条的具体理由见 `scripts/fly503-consolidation/clusters.json`（`rationale` 字段）。

### 跨项目处理（不并入 Flywheel）

- **Joycon 硬件**（Hiro 在接）：FLY-403（墨水屏 Dashboard）、FLY-415（Meta 眼镜）、
  FLY-457（Viture XR）、FLY-460（Apple Home）；FLY-377（Omi 可穿戴）疑似同域，标出待路由。
- **3D / GeoForge3D 倾向**（同 FLY-436→GEO-431 一类）：FLY-451（Gemini 3 做 3D 打印模型）、
  FLY-438（Rhino3D 接 OpenClaw）、FLY-477（SHEIN 3D 打印电商）。

这些**默认不并入 Flywheel**，HTML 里单独标「跨项目 · 默认不并入」，由 Annie 拍是否转对应项目。

## 交付物（Phase 1）

- `scripts/fly503-consolidation/issues.json` — 49 条 issue 数据（id/title/author/source/summary/linearUrl）。
- `scripts/fly503-consolidation/clusters.json` — 本提案（cluster + 每条角色 + 默认决策 + 理由）。
- `scripts/fly503-consolidation/build_review.py` — 交互 review HTML 生成器。
- `scripts/fly503-consolidation/test_build_review.py` — 测试（escape / nonce / 无内联 handler /
  全 issue 在场 / 默认决策对应角色 / 导出结构 / 体积上限）。
- `scripts/fly503-consolidation/FLY-503-consolidation-review.html` — 生成的 review 页（committed 快照）。

**交付方式**：`flywheel-comm publish-report` 发 Annie（托管 URL + Discord 一条消息）。

### review 页设计要点

- 风格对齐 FLY-349 review page（Apple-light，per-cluster 卡片）。
- 每条 issue：代表/合并/独立/跨项目 badge + 标题 + 作者 + 原帖链接 + 摘要 + 建议 + 理由 +
  决策 radio（合并/保持独立/路由/取消）+ 评论框。
- 顶部 sticky 栏：实时 tally（合并/保留/路由/取消计数）+「复制决策 JSON」按钮 + JSON 预览。
- **CSP 安全**（走 publish-report 的 `default-src 'none'` 管线）：脚本经 `__CSP_NONCE__`
  占位符 opt-in，所有 handler 用 `addEventListener`（无内联 onclick），所有 XHS 文本
  HTML-escape，原帖/Linear 链接经 scheme(https)+host allowlist 才成 `<a href>`，否则惰性文本。
  不可信数据只进静态 HTML、绝不进 script 上下文（注入的 `</script>` 无法 break out）。
- **导出**：`navigator.clipboard.writeText`（真实点击 + https 托管页可用，FLY-349 copy-button
  已验证）；clipboard 不可用时降级为可见 JSON 供手动复制。

### 重新生成

```bash
cd scripts/fly503-consolidation
python3 -m pytest test_build_review.py -q   # 测试
python3 build_review.py                      # 生成 ./FLY-503-consolidation-review.html (默认输出本目录, 可传 argv 覆盖)
```

## Phase 2（待 Annie 导出决策后执行）

Annie 在 review 页逐条调整 → 点「复制决策 JSON」→ 把 JSON 发回 Tadashi。据此执行：

1. **merge**：把被并 issue 的 provenance（原帖链接 + 作者 + 提炼）追加进代表 issue 描述；
   被并 issue 标记 `duplicateOf` 代表 + 设 Canceled。
2. **keep**：不动（保留 Backlog）。
3. **route_out**：按 target 转对应项目（Joycon / GeoForge3D），或保留——按 Annie 的选择。
4. **cancel**：直接 Canceled。

全程**保留各来源 provenance**，不丢信息。执行前对每条被并/代表 issue 用 `get_issue`
取完整描述（list 接口截断在 500 字），确保合并后的代表描述完整。
