# FLY-3121 Canary 传输探针 — 实施计划
Issue: FLY-3121 (https://linear.app/geoforge3d/issue/FLY-3121/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-phase)
日期: 2026-10-01
基于: research.md

## 步骤
1. 确认 `turn` = `yours`。✅
2. 向 `probe.txt` 追加一行:`FLY2127-CANARY-<uuid> node=<node> exec=<exec> activation=<activation> turn=yours ts=<UTC>`。✅(d54794dec)
3. 本地 commit(路径限定 `probe.txt`)。✅
4. 用 `ask --report` 向 Lead 回执 TURN + 标记提交。
5. 后继节点(实施/QA)若需追加，同样先查 `turn`,再追加自己的一行。

## 验收
- `tail -1 probe.txt` 含 owner 标记与本 exec id。
- `git log -1 -- probe.txt` 为本节点提交。
- 无产品代码改动(`git diff main --stat` 仅 probe.txt + 本文档夹)。

## 回滚
`git revert <marker commit>`;不影响任何运行时代码。
