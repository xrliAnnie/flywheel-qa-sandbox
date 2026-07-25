# FLY-202 Sandbox Notes — Exploration

**Issue**: FLY-202
**Date**: 2026-07-25
**Based on**: 当前 sandbox worktree、`packages/qa-framework/README.md` 与 FLY-202 task brief

## Problem

test-slot real-Runner E2E 需要一个小而稳定、又足够多步骤的真实任务，让 QA 可以观察 Runner 从 Linear issue 注入到 PR 落地的完整生命周期。交付物是 `doc/qa/sandbox-notes.md`：说明 sandbox 仓库的用途，列全顶层目录，概括 QA framework README，并保存指定目录命令的现场输出。

约束很明确：只修改当前 sandbox clone；不触碰生产资源；内容必须来自本次 checkout 的真实状态，而不是沿用可能过时的历史 fixture 文档。

## Approaches

### A. Live-source documentation (selected)

从当前 `HEAD` 读取 tracked top-level directories，通读当前 `packages/qa-framework/README.md`，实际运行 `ls -R doc/ | head -50`，再手写精炼说明。

- 优点：与最终 PR base 的 live source tree 一致，避免沿用旧 fixture 的目录与 README 状态。
- 风险：README 较长，需要主动收敛到约 10 个高信息密度 bullet。

### B. Refresh a historical FLY-202 note

从旧的 FLY-202 remote branch 复制 `sandbox-notes.md`，再修补目录与 README 差异。

- 优点：速度快，格式已经被多次 E2E 使用。
- 风险：容易漏掉当前分支变化，也会把旧 run 的措辞或日期带入新文档。

### C. Generate the document mechanically

新增脚本自动生成目录表、README 摘要骨架和命令输出。

- 优点：重复运行一致。
- 风险：对一次性 fixture 任务过度设计；自动摘要质量更难验证，还会扩大变更范围。

## Design

选择方案 A。最终文档采用五个部分：

1. 标题与 FLY-202 日期元数据。
2. 3 段 Purpose，分别解释 sandbox 隔离边界、slot harness 执行链、fixture issue 的角色。
3. Top-Level Directories 表，按 `git ls-tree -d --name-only HEAD` 顺序覆盖 17 个 tracked 目录，每行给一条可由目录内容验证的描述。
4. `packages/qa-framework/README.md` Summary，严格保持 10 个 bullet，覆盖框架定位、五步协议、slot lifecycle、镜像模式、近期 529-Room 能力与契约。
5. `ls -R doc/ | head -50` 的原样输出，使用 fenced text block。

## Verification

文档型交付物采用 requirements-as-tests：

- RED：在目标文件不存在时运行检查脚本，确认因 missing file 失败。
- GREEN：创建文档后重复运行同一脚本，验证段落数、17 个目录表项、10 个 README bullets，以及 fenced block 与实际命令输出逐行一致。
- 最后运行 `git diff --check`，并对照 task brief 逐条审计。
