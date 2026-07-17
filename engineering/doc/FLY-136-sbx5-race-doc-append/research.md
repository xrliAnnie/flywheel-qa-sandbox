# Research: FLY-SBX-5 沙箱仓现状核查 — FLY-136

**Issue**: FLY-136
**URL**: https://linear.app/xrli/issue/FLY-136
**Date**: 2026-07-17
**Source**: `engineering/doc/FLY-136-sbx5-race-doc-append/exploration.md`

## 仓库事实(全部实测,非推断)

1. **Remote**: `origin = https://github.com/xrliAnnie/flywheel-qa-sandbox.git` —
   与 issue 描述的 sandbox 仓一致;当前分支 `project-slot-3-FLY-136`,基于
   `main` @ `7049f719`,工作树干净。

2. **README.md 不存在**:`git ls-files | grep -i readme` 为空;
   `git log --diff-filter=D -- README.md` 显示删除发生在 `7049f719`
   (`test(FLY-1286): capture failed resident phase E2E (#58)`)。

3. **CLAUDE.md 存在**(342 行,主仓 CLAUDE.md 镜像),`| Milestone | Status |`
   表头在 **line 39**,表体为主仓 milestone 大表。

4. **先例 diff 形态**(`git show b6bfdd90 -- CLAUDE.md`,FLY-138):

   ```diff
   +| FLY-138: [QA-FLY-127 sandbox] Product-Test label only (S1 happy path) — milestone record | ✅ Merged |
   ```

   插入位置 = milestone 表最后一行之后;commit message 形态
   `docs(FLY-138): record FLY-138 in milestone table`;经 PR merge(#18)。

5. **doc_flow 配置**(`.flywheel/config.yaml` line 99):`enabled: true`,
   `default_department: engineering` → 过程文档落
   `engineering/doc/<ISSUE>-<slug>/`,与既有 folder(如
   `engineering/doc/FLY-1050-three-stage-qa-respawn/` 含
   exploration/research/plan/progress 四件)形态一致。

6. **CI / 测试面**:改动为 doc-only(CLAUDE.md 一行),不触碰
   `packages/`,无可运行的 runtime surface;测试要求按 doc-only waiver 处理
   (与先例 4 个 sandbox PR 相同)。

## 风险清单

| 风险 | 概率 | 处理 |
|------|------|------|
| sibling SBX PR 先 merge → 表末行 conflict | 中(5-spawn race 本性) | ship 前 rebase main;union 保留双方行 |
| 误关 FLY-136 | — | plan 明确禁止;PR body 注明 "do NOT close issue" |
| scope 膨胀(顺手清理) | — | plan 限定 diff = CLAUDE.md +1 行,别无其他 |

## 结论

无未知项。落点、行内容、commit/PR 形态全部有实测先例背书,可直接出 plan。
