# Design

## Context

FLY-202 是真实 Runner E2E 的沙箱夹具任务。目标是在 `flywheel-qa-sandbox` 的当前检出状态中新增一份可读、可核对的说明文档，而不修改生产资源或实现代码。

## Approaches

1. **Evidence-first manual document（推荐）**：用仓库和 QA 文档作为事实来源，人工组织简洁说明；兼顾准确性与可读性。
2. **Generated document**：写脚本自动生成全部内容；目录清单更机械稳定，但对一次性文档任务过度设计，摘要质量较弱。
3. **Name-only inventory**：仅按目录名推断用途；最快，但容易产生未经仓库内容支持的描述。

## Approved Design

新增一份英文 Markdown 文件 `doc/qa/sandbox-notes.md`，内容顺序如下：

1. 以 2–3 段说明 sandbox 是独立于生产仓库的真实 Runner E2E push/PR 目标、如何被 slot harness 使用，以及它为何需要与生产代码保持接近。
2. 表格列出当前检出的所有顶层目录（包括隐藏配置目录），每项给出一句用途说明。
3. 单独注明顶层异常条目 `=` 是文件而非目录，因此不把它错误地放入目录表。
4. 用恰好 10 个 bullet 总结 `packages/qa-framework/README.md` 的核心内容。
5. 运行 `ls -R doc/ | head -50`，将 stdout 原样放入 fenced code block。

## Verification

提交前执行四项检查：

- 对比 filesystem 得到的顶层目录集合与表格条目，确保无遗漏或额外目录。
- 断言 QA framework 摘要恰好有 10 个 bullet。
- 重跑指定命令并对比 fenced block，确保 transcript 完全一致。
- 检查 2–3 段目的说明、Markdown 表格/标题/代码围栏，并人工复核 README 摘要没有越界推断。

## Scope

只改 sandbox clone 内的文档与 Flywheel 流程记录；不访问或修改生产资源，不改实现代码，不引入生成脚本。
