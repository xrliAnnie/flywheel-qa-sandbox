# FLY-2984 runner 生命周期说明文件 — 探索
Issue: FLY-2984 (https://linear.app/geoforge3d/issue/FLY-2984/qa-sbx-fly-2925-n-to-n-synthetic-runner-lifecycle-task)
日期: 2026-09-27
基于: 无

## 1. 任务是什么

这是 529 测试房里的合成 QA 单，服务于 FLY-2925 的 Discord 端到端（N-to-N）验收，不是生产工作。
交付物只有一个文件：`qa-sandbox/fly2925-n2n.md`，分三步写，每步 commit + push 到本 issue 分支：

1. 一个短标题 + 一段话：runner 做什么；
2. 第二段：runner 被重启时发生什么；
3. 第三段：工作如何交卷（hand in）。

除该文件外不改任何其他文件；写完按正常流程交卷。

## 2. 仓库现状（2026-09-27 实测）

| 项 | 观测 |
|---|---|
| 仓库 | `xrliAnnie/flywheel-qa-sandbox`（沙箱仓，非生产） |
| 分支 | `project-slot-2-FLY-2984`，worktree 绑定 generation 已锁定 |
| 分支基线 | `7c5a01d74`（FLY-2925 实现头），领先 `origin/main` 2686、落后 32 |
| 远端分支 | 设计开始时不存在；设计节点首次 push 会创建 |
| `qa-sandbox/` 目录 | 不存在（implement 第 1 步创建） |
| TURN | `yours phase=design epoch=1 node=eng_design attempt=1` |

## 3. 为什么是「三步三推」

FLY-2925 的验收要观察 runner 在任务中途被重启 / 接管后是否按原会话续接，而不是从头重做。
把交付拆成三个可独立观察的 push，相当于给验收方三个检查点：远端分支上每出现一个新 commit，
就证明 runner 推进了一步；重启后若重复写已完成的段落或跳过未完成的段落，都能从 git 历史直接看出来。

因此实现的关键性质是**每一步幂等、可续跑**：进入某步前先看文件和远端已处在哪一步，已完成就跳过，
不重复追加、不回滚。

## 4. 假设（显式列出）

- A1 不重锚分支：worktree 绑定已锁，DAG 共享分支；以 `7c5a01d74` 为设计基线，不 merge / rebase origin/main。已向 Lead 发非阻塞问题 `cc147074-ac51-4b79-a8a1-857f36bce612`。
- A2 「不改任何其他文件」约束的是 implement 的交付；DOC-FLOW 要求的设计文档与 founder HTML 放在 `engineering/doc/FLY-2984-runner-lifecycle-note/`，由设计节点提交，不属于违规。
- A3 `progress.md` 账本由 `flywheel-comm progress` 路径限定提交，是流程元数据，不算交付文件改动。
- A4 段落语言用英文（issue 原文为英文）；内容描述 Flywheel runner 的真实行为，不虚构机制。
- A5 「正常流程交卷」= implement 节点注入的收尾合同（账本 → push → 报告 → `complete`）；设计不硬编码 implement 的 route。

## 5. 不做什么

不改任何代码、测试、配置；不开 PR 到 main、不 merge、不部署；不写第四段；不改 `qa-sandbox/` 下其他文件。
