# FLY-3090 generalized README marker — 实施计划

Issue: FLY-3090 (https://linear.app/geoforge3d/issue/FLY-3090/synthetic-qa-fly-3084-generalized-real-inference-readme-marker)
日期: 2026-09-29
基于: research.md

## 0. 一句话

在沙箱仓 `README.md` 末尾**追加**一行 `Synthetic generalized QA marker: FLY-3084.`，
不改其它任何产品文件，只做只读验证，开 PR 到 `main`；merge 不在本计划范围。

## 1. 总则（实施节点的执行合同）

- 分支：直接用 `project-slot-5-FLY-3090`（已含本文件夹 docs 提交），不另建。
- 产品文件唯一改动点：`README.md`，且只允许 **追加一行**。
- **禁令**：不跑 `pnpm test` / `vitest` / `pnpm lint` / `pnpm build` 或任何仓库级、
  package 级测试与构建；不改 `packages/`、`scripts/`、`package.json`；不 merge PR。
- 文档（`engineering/doc/FLY-3090-generalized-readme-marker/`）不算产品文件，随分支进 PR。
- 每完成一个 chunk 更新 progress ledger（`--phase implement --cursor n/4`）。

## 2. Chunks

### C1 — 追加 marker 行

```bash
printf '%s\n' 'Synthetic generalized QA marker: FLY-3084.' >> README.md
```

- 必须用 `>>` 追加，**不得**用编辑器/Edit 工具重写整文件（避免顺手规范化前导空行）。
- 文本逐字：`Synthetic generalized QA marker: FLY-3084.`（末尾有英文句号；issue 号是
  **3084** 不是 3090）。

### C2 — 窄验证（只读 README，这是 issue 允许的全部验证面）

```bash
tail -n 1 README.md                      # 期望: Synthetic generalized QA marker: FLY-3084.
grep -cxF 'Synthetic generalized QA marker: FLY-3084.' README.md   # 期望: 1
sed -n 3p README.md                      # 期望: FLY-1375 land E2E marker 20260722T023540Z
wc -l README.md                          # 期望: 4
tail -c 1 README.md | od -c              # 期望: \n
git diff --numstat -- README.md          # 期望: 1  0  README.md
git diff --stat -- . ':!engineering/doc' # 期望: 只列 README.md
```

任一项不符 → 不提交，回到 C1 用 `git checkout -- README.md` 复位后重做。

### C3 — 提交

```bash
git add README.md
git commit -m "docs(FLY-3090): append synthetic generalized QA marker to README" \
  -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- 提交前跑 `flywheel-comm inbox` 兜底检查 Lead 指令。
- 提交后 `git show --stat HEAD` 应只列 `README.md`（+1/-0）。

### C4 — 推送并开 PR（base = `main`）

```bash
git push -u origin project-slot-5-FLY-3090
gh pr create --base main --title "docs(FLY-3090): append synthetic generalized QA marker to README" --body-file <body>
```

PR body 模板：

```
## Summary
- Append one final line to root `README.md`: `Synthetic generalized QA marker: FLY-3084.`
- Existing line kept byte-identical; no other product file touched.
- Design docs under `engineering/doc/FLY-3090-generalized-readme-marker/`.

## Linear Issue
FLY-3090: [SYNTHETIC QA FLY-3084] generalized real-inference README marker
https://linear.app/geoforge3d/issue/FLY-3090/synthetic-qa-fly-3084-generalized-real-inference-readme-marker

## Test plan
- [x] Narrow read-only verification of `README.md` only (`tail -n 1`, `grep -cxF`, `wc -l`, `git diff --numstat`).
- [x] Repository / package test suites intentionally NOT run (issue mandate).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

PR 打开后按节点协议回报 Lead（`flywheel-comm ask --report`），**不** merge、不请求 ship。

## 3. 验收标准（与 exploration §5 一一对应）

| # | 标准 | 验证命令（只读） |
|---|---|---|
| 1 | 末行逐字为 marker | `tail -n 1 README.md` |
| 2 | 第 3 行未变 | `sed -n 3p README.md` |
| 3 | 4 行、以 `\n` 结尾 | `wc -l` / `tail -c 1 \| od -c` |
| 4 | 产品文件 diff 只有 README `+1/-0` | `git diff --numstat origin/main -- . ':!engineering/doc'` |
| 5 | PR base=main、body 含 Linear 段落 | `gh pr view --json baseRefName,body` |

## 4. 回滚边界

- 未提交：`git checkout -- README.md`。
- 已提交未 push：`git reset --hard HEAD~1`（只回退 README 提交；docs 提交保留）。
- 已 push / 已开 PR：追加一个 revert commit，不 force-push（push-guard 会拦，且违反 FORCE-PUSH GUARD）。
- 无持久化状态、无迁移、无消费者：README 无任何代码读取方（research §2 grep 零引用）。

## 5. 明确不做

- 不清理 README 前导两个空行、不加标题（越权）。
- 不动 `doc/VERSION`（synthetic 任务不发版）。
- 不跑任何测试套件（issue 禁令）。
- 不 merge、不 deploy、不重启服务。
