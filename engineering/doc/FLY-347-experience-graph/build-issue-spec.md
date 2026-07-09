# FLY-347 Run 教训库 MVP — build-issue spec

Issue: FLY-347 (https://linear.app/geoforge3d/issue/FLY-347/xhsclaude-karpathy用-llm-构建个人知识库token-从处理代码转向处理知识)
日期: 2026-07-08
基于: engineering/doc/FLY-347-experience-graph/prd.md (v5 定稿)

> **已建:build issue = FLY-1033**(Lead 于 2026-07-08 建,一个连贯功能,挂 Tadashi 队列)。
> 交 Lead 建 FLY eng build issue 挂 Tadashi 队列(Runner 不自建 issue、不自 ship)。
> 定稿依据:engineering/doc/FLY-347-experience-graph/prd.md (v5 定稿)。

## 标题(建议)

[Flywheel] Run 教训库 MVP — ship 前写 lesson + onboard 读 + 每周 lint + index

## 一句话

一个连贯的 Run 教训库:Runner ship 前把这趟坑写成 markdown 进同一个 PR、写时更新轻量 index、下次
Runner onboard 按 tag 读相关教训避坑、每周一次 lint pass 保库不烂。**一个 PR 做完,不拆子 issue。**

## 范围(库的四面,一个功能)

1. **写(ship 前进 PR)**:在 Runner ship-prep(**请求 approve 之前**那一步)加一步 —— Runner 用它手上的
   LLM 给这趟 run 写 `knowledge/lessons/<ISSUE>-<slug>.md`(格式见下),没值得记的**跳过**;提交进当前 PR。
2. **索引**:同一步更新 `knowledge/lessons/index.md` 一行(`文件名 · 一句话摘要 · tags`)。
3. **读(onboard)**:在 Runner 起活(onboard)加一步 —— 读 index → 按本单 tag/关键词(label + 标题)捞
   top-N 相关 lesson 注入 context。
4. **lint(每周 + 可手动)**:一个**每周一次**低频定时(+ 随时手动)的 pass,做 4 件:① 去重/合并近似(留全
   要点 + 各自来源)② 退役过时/被推翻(**标记退役、不物理删、可逆**)③ 消解矛盾(合成带条件的一条 or flag
   给 Lead)④ 更新 index → **可审 diff,Lead 审后才落,绝不自动删**。

## lesson 文件格式(写死)

```markdown
---
issue: FLY-176
tags: [bridge, restart, process-kill]
---
# 改 Bridge 重启逻辑:PID 变量要加引号
**踩的坑**: restart-services.sh:523 的 multi-line PID 没加引号 → kill 静默失败 → 手动重启。
**避法**: PID 加引号,或 pgrep -f run-bridge | xargs kill -9。
```

## 存哪

目标 repo(先 flywheel 自身跑通)根 `knowledge/lessons/`(`*.md` + `index.md`),随 PR 合进 main。无新存储/DB。

## 触发点(写死)

- **写** = Runner ship-prep,**请求 approve 之前**(进 reviewed diff、避 head drift)。
- **读** = Runner onboard 阶段。
- **lint** = 每周一次低频定时 + 随时可手动。

## 验收(Success)

1. 有值得记的 run 稳定产 1 个 lesson + 更新 index;平淡的 run 跳过不硬写。
2. onboard 按 tag 能捞到相关 —— 两个真实场景验收:再动 Bridge restart 能捞到 FLY-176/193 那几条;起
   Discord E2E 能捞到 thread 改名限速 / TEST_REPLY_BY_ISSUE / urllib User-Agent 那几条。
3. lint pass 能把重复/过时合并退役、出**可审 diff**(不自动删);Lead 审后才落。
4. 不拖慢 ship / onboard。

## 依赖 / 接线点

- Runner ship-prep 流程(approve gate 之前那步)→ 加「写 lesson + 更新 index」。
- Runner onboard 流程 → 加「读 lesson」。
- 一个每周定时触发(cron/scheduler)跑 lint;lint diff 走 Lead review。
- 无新存储;纯 repo markdown。

## 非目标(明确不做)

图结构/节点/边、向量/语义检索、独立后台抽取服务、跨项目库、lint 自动删、拆成多个 issue。

## 参考

- PRD 定稿:`engineering/doc/FLY-347-experience-graph/prd.md` (v5)
- 应用场景 + 通用背景:`product/doc/FLY-347-llm-knowledge-base/`(经验图谱怎么用 / Karpathy 方法 explainer)
