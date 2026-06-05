# FLY-221 generic-runner smoke — 实施计划

Issue: FLY-221 (https://linear.app/geoforge3d/issue/FLY-221/sandbox-fly-217-generic-runner-real-run-do-not-action-throwaway)
日期: 2026-06-05
基于: 无

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 repo 根目录新增 `HELLO-FLY-217.md`，内容为且仅为一行 smoke 文案，用以端到端验证「无 agent-role 的 generic-executor + Superpowers RPC」流程。

**Architecture:** 单文件静态 Markdown，无运行时代码、无依赖。verification 通过一条 shell 断言完成（精确比对文件内容等于期望的一行），扮演 TDD 中 RED→GREEN 的角色。

**Tech Stack:** 纯文件 + Bash/Zsh shell (`diff` / `printf` / process substitution `<(...)`) 做内容断言。

## File Structure

- Create: `HELLO-FLY-217.md` — repo 根目录，唯一交付物，内含一行 smoke 文案。
- Create: `doc/FLY-221-generic-runner-smoke/plan.md` — 本计划文档（随分支一起合并）。

期望文件内容（精确，含末尾换行）：

```
FLY-217 sandbox smoke — generic Runner reached implementation.
```

---

### Task 1: 新增 HELLO-FLY-217.md 并断言内容

**Files:**
- Create: `HELLO-FLY-217.md`

- [ ] **Step 1: 写失败断言 (RED)**

文件尚不存在，先建立期望内容并运行断言，预期失败：

```bash
EXPECTED='FLY-217 sandbox smoke — generic Runner reached implementation.'
diff <(printf '%s\n' "$EXPECTED") HELLO-FLY-217.md
```

- [ ] **Step 2: 运行断言确认失败**

Run: 上述 `diff` 命令
Expected: FAIL —— `HELLO-FLY-217.md: No such file or directory`（非零退出）

- [ ] **Step 3: 写最小实现 (GREEN)**

```bash
printf '%s\n' 'FLY-217 sandbox smoke — generic Runner reached implementation.' > HELLO-FLY-217.md
```

- [ ] **Step 4: 运行断言确认通过**

Run:
```bash
EXPECTED='FLY-217 sandbox smoke — generic Runner reached implementation.'
diff <(printf '%s\n' "$EXPECTED") HELLO-FLY-217.md && echo "PASS: content exact-match"
```
Expected: PASS —— 无 diff 输出，打印 `PASS: content exact-match`，退出码 0。

- [ ] **Step 5: 提交**

```bash
git add HELLO-FLY-217.md doc/FLY-221-generic-runner-smoke/plan.md
git commit -m "feat(FLY-221): add HELLO-FLY-217.md sandbox smoke file"
```

---

## Self-Review

- **Spec coverage:** issue 唯一要求 = 根目录单文件单行内容 → Task 1 完整覆盖。
- **Placeholder scan:** 无 TBD/TODO，断言命令与期望输出均为具体内容。
- **Type consistency:** N/A（无代码符号）；期望文案在本计划中出现四处（期望块 / RED / GREEN / 验证），均字节一致（含 em dash "—"）。
- **Scope:** 仅触碰交付物与本计划文档，无附带改动 —— 符合 scope discipline。
