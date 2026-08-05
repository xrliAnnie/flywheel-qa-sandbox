# FLY-202 Sandbox Notes Implementation Plan

> **For agentic workers:** 在当前会话内执行这份有界文档计划；Flywheel workflow 负责 orchestration，不要派发 subagent。

**Goal:** 创建 `doc/qa/sandbox-notes.md`，准确说明仓库用途，完整列出顶层目录，总结 QA framework，并收录指定的 `doc/` listing。

**Architecture:** 以仓库文件系统和 `packages/qa-framework/README.md` 为权威输入。交付文档保持自包含，提交前用机械检查逐项验证所有要求。

**Tech Stack:** Markdown, POSIX shell, Git, GitHub CLI

---

### Task 1: Create the sandbox notes

**Files:**
- Create: `doc/qa/sandbox-notes.md`

- [ ] **Step 1:** 根据 QA framework README 和任务描述，用 2–3 段说明 sandbox repo 的用途。
- [ ] **Step 2:** 对 `find . -mindepth 1 -maxdepth 1 -type d` 返回的每个顶层目录添加一行表格，仅排除 Git 内部目录 `.git`。
- [ ] **Step 3:** 用约 10 个 bullet 总结 `packages/qa-framework/README.md`。
- [ ] **Step 4:** 运行 `ls -R doc/ | head -50`，将完整输出原样放入 fenced `text` block。

### Task 2: Verify and deliver

**Files:**
- Verify: `doc/qa/sandbox-notes.md`

- [ ] **Step 1:** 检查段落数、目录覆盖、bullet 数量和 fenced command output。
- [ ] **Step 2:** 检查 `git diff --check` 和 Markdown 源文档。
- [ ] **Step 3:** 在现有 feature branch 提交并 push。
- [ ] **Step 4:** 创建以 `main` 为 base 的 PR，然后提交要求的 workflow JSON artifact。
