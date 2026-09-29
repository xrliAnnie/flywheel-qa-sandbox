# FLY-3058 QA-SBX probe — 调研
Issue: FLY-3058 (https://linear.app/geoforge3d/issue/FLY-3058/qa-sbx-fly-2922-qa4-fixture-529-generalized-real-drill)
日期: 2026-09-29
基于: exploration.md

## 当前事实

| 项目 | 证据 | 结论 |
|---|---|---|
| 仓库 | `origin` 指向 `xrliAnnie/flywheel-qa-sandbox` | 任务位于指定 529 QA 沙箱，不触碰生产仓库 |
| 分支 | 当前分支为 `project-slot-2-FLY-3058` | 直接作为 feature/PR 分支，不另建分支 |
| 基线 | 起始点为 `origin/main` 的 `1855f7a1a` | Round 1 从当前沙箱主线开始 |
| 目标路径 | HEAD 中没有 `qa-2922/` 或 `probe.txt` | Round 1 是新建，不是覆盖已有夹具 |
| 标记搜索 | HEAD 中没有 `PROBE-1` 或 `PROBE-2` | 两个标记不会与既有仓库内容混淆 |
| PR | 当前 head 分支没有历史 PR | Round 1 需要新开一个 PR；rework 必须复用它 |
| 工作流 | `.flywheel/config.yaml` 开启 `doc_flow` | design 产物留在本文件夹；实现目标仍只允许 `qa-2922/probe.txt` |

## 内容合同

`probe.txt` 使用 UTF-8/ASCII 文本和 LF 换行。状态只有两个：

| 状态 | 精确字节 | 允许进入条件 |
|---|---|---|
| Round 1 | `PROBE-1\n` | 初次实现 |
| Rework | `PROBE-1\nPROBE-2\n` | QA 明确要求 implement attempt-2 marker |

没有第三种状态，不允许空行、前后空格、重复标记或提前写入 `PROBE-2`。

## 验证边界

这是纯文本夹具，不修改 TypeScript、构建配置或可执行代码，因此不运行包级或仓库级测试。每轮使用以下证据：

- 先搜索 `PROBE-1`、`PROBE-2`、完整路径、文件名和父目录，确认没有需要纳入的具体测试文件；若发现测试消费者，只逐文件运行并记录任何排除理由。
- 用十六进制字节输出验证内容和末尾 LF，而不只依赖 `cat` 的视觉结果。
- 用限定路径的 `git diff`、`git diff --check` 和 `git status --short` 证明该轮没有额外实现文件变化。
- Round 1 在提交前反向搜索并断言 `PROBE-2` 不存在；rework 则断言两行各出现一次且顺序固定。
