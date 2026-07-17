# Plan: FLY-SBX-5 最小 doc 改动 — milestone 表 +1 行

**Version**: sandbox(不占主仓版本号)
**Issue**: FLY-136
**URL**: https://linear.app/xrli/issue/FLY-136
**Date**: 2026-07-17
**Source**: `engineering/doc/FLY-136-sbx5-race-doc-append/{exploration,research}.md`
**Status**: design-complete(三段式 design 节点产出,implement 节点按此执行)

## 目标

在 sandbox 仓(`xrliAnnie/flywheel-qa-sandbox`)完成 issue 规定的最小 doc-only
改动并走完 PR → approve → ship 链路,作为 FLY-128 5-spawn race 测试的第 5 路。

## 全部改动(diff 合同 — 有且仅有这一处)

**文件**: `CLAUDE.md`
**位置**: `| Milestone | Status |` 表(表头 line 39)的最后一行之后。
design 时刻的最后一行是 **line 138**(`| FLY-880(暂定…` 行);若 sibling PR
先 merge 导致行号漂移,锚点语义不变:**永远插在表末**。
**插入内容**(恰好一行):

```
| FLY-136: [Sandbox] FLY-SBX-5 — FLY-128 5-spawn race milestone record | ✅ Merged |
```

## 实施步骤(implement 节点)

1. 确认在分支 `project-slot-3-FLY-136`、工作树干净;`git fetch origin main`。
2. 用 Edit 在 milestone 表末插入上面那一行(整 diff = 1 行新增,0 行删除)。
3. Commit(先例形态):

   ```
   docs(FLY-136): record FLY-SBX-5 in milestone table
   ```

4. Push 分支,开 PR → base `main`:
   - 标题:`docs(FLY-136): record FLY-SBX-5 in milestone table`
   - body 必含:`## Linear Issue` 段(FLY-136 + URL)、doc-only 测试 waiver
     说明、以及一句 **"QA sandbox issue — do NOT close FLY-136"**。
5. 报 Lead、等 approve gate;**不自行 merge**(MERGE AUTHORITY 规则,merge 前
   必须 verify-approval)。
6. approve 后 ship:merge 前 `git fetch && git rebase origin/main`;若与
   sibling SBX PR 撞表末 conflict → **union 保留双方行**,自己的行维持表末,
   force-push 后走 merge。

## 明确不做

- 不创建 README.md(已被 `7049f719` 删除;issue 允许二选一,选 CLAUDE.md)。
- 不关 FLY-136(永久 open)。
- 不动 CLAUDE.md 其他任何行、不动任何代码/配置。
- 不写测试(doc-only;PR body 声明 waiver)。

## 验收标准

1. PR diff 恰好 = CLAUDE.md +1 行(上述内容)。
2. PR 经 approve gate 后 merge 进 `main`,CI 绿。
3. FLY-136 issue 保持 open。

## 风险与预案

| 风险 | 预案 |
|------|------|
| 表末行 conflict(5-spawn race 本性) | 步骤 6:rebase + union,先例 FLY-133/134/135/138 四连发验证过 |
| 行号漂移 | 锚点按语义(表末),不按行号 |
