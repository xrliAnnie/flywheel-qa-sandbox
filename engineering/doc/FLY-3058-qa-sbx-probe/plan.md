# FLY-3058 QA-SBX probe — 实施计划
Issue: FLY-3058 (https://linear.app/geoforge3d/issue/FLY-3058/qa-sbx-fly-2922-qa4-fixture-529-generalized-real-drill)
日期: 2026-09-29
基于: research.md

## 目标与结构

只创建一个实现文件：`qa-2922/probe.txt`。它先处于 Round 1 单行状态；只有 QA 明确打回要求 attempt-2 marker 后，才进入 Rework 双行状态。设计文档是上游阶段产物，不属于实现节点可扩展的文件范围。

## Round 1：创建、提交并开 PR

1. 确认工作树干净，并运行以下发现命令：
   ```bash
   git grep -lF -- 'PROBE-1' HEAD
   git grep -lF -- 'PROBE-2' HEAD
   git grep -lF -- 'qa-2922/probe.txt' HEAD
   git grep -lF -- 'probe.txt' HEAD
   git grep -lF -- 'qa-2922' HEAD
   ```
   预期均无匹配。若命中具体测试文件，逐个判断是否保留并逐文件运行；任何排除都要记录原因。不得回退到包级或仓库级测试。
2. 新建 `qa-2922/probe.txt`，内容必须精确为：
   ```text
   PROBE-1
   ```
   文件末尾保留一个 LF 换行；不得加入 `PROBE-2`。
3. 验证字节和变更面：
   ```bash
   test "$(od -An -tx1 qa-2922/probe.txt | tr -d ' \n')" = "50524f42452d310a"
   ! rg -n -F -- 'PROBE-2' qa-2922/probe.txt
   git diff --check
   git status --short
   ```
   实现增量只允许 `?? qa-2922/probe.txt`；无适用测试文件时，将“无测试消费者；纯文本精确字节检查已通过”作为测试记录。
4. 只暂存目标文件，确认 `git diff --cached --name-only` 只输出 `qa-2922/probe.txt`，然后提交，commit message 使用 `test(FLY-3058): add round-one QA probe`。
5. 推送当前 `project-slot-2-FLY-3058` 分支，并向 `xrliAnnie/flywheel-qa-sandbox` 的 `main` 新开一个 PR。PR 明确写出 Round 1 只有 `PROBE-1`，并保留给 QA rework。
6. 完成实现节点的 review handoff；不自行 merge，不提前执行 Rework。

## Rework：在同一 PR 追加 attempt-2 marker

只在 QA 明确要求 implement attempt-2 marker 后执行：

1. 拉取并核对现有文件仍精确等于 `PROBE-1\n`，同时确认当前分支对应原 PR。
2. 在原文件末尾追加一行 `PROBE-2`，最终内容必须精确为：
   ```text
   PROBE-1
   PROBE-2
   ```
3. 重跑 literal/path/filename/parent discovery，并验证：
   ```bash
   test "$(od -An -tx1 qa-2922/probe.txt | tr -d ' \n')" = "50524f42452d310a50524f42452d320a"
   test "$(rg -x -c -- 'PROBE-1' qa-2922/probe.txt)" = "1"
   test "$(rg -x -c -- 'PROBE-2' qa-2922/probe.txt)" = "1"
   git diff --check
   git diff --name-only
   ```
   `git diff --name-only` 只能输出 `qa-2922/probe.txt`。
4. 只提交目标文件，commit message 使用 `test(FLY-3058): add attempt-two QA probe`；推送到同一远端分支，让原 PR 更新。不得再运行 `gh pr create`。
5. 再次完成 review handoff，并提供原 PR URL、新 commit SHA、双行字节检查和单文件 diff 证据。

## 不做的事

- Design 节点不创建 `qa-2922/probe.txt`，也不实现任何 marker。
- Round 1 不包含 `PROBE-2`。
- 不新增脚本、测试、依赖或配置，不修改其他实现文件。
- 不运行完整仓库/包测试，不 merge PR，不请求 shipping authority。
