# FLY-3090 generalized README marker — 调研

Issue: FLY-3090 (https://linear.app/geoforge3d/issue/FLY-3090/synthetic-qa-fly-3084-generalized-real-inference-readme-marker)
日期: 2026-09-29
基于: exploration.md

本文只记录**实测**得到的事实；每条附命令，实施节点可原样复跑核对。

## 1. 分支基线

| 项 | 实测值 | 命令 |
|---|---|---|
| `origin/main` | `1855f7a1a`（Merge #162, FLY-2164 sandbox cleanup） | `git fetch origin main && git rev-parse --short FETCH_HEAD` |
| 本分支 HEAD | `8da718f28`（仅一条 `chore(progress)` 提交，由 progress ledger 自动产生） | `git log --oneline origin/main..HEAD` |
| main 是否为祖先 | 是（`git merge-base --is-ancestor FETCH_HEAD HEAD` 成功） | — |
| upstream | 未配置 → 首次 push 用 `git push -u origin project-slot-5-FLY-3090` | `git rev-parse --abbrev-ref @{u}` 报 fatal |

结论：本分支与 `main` 零冲突面，PR base 直接用 `main`，无需 sync/merge。

## 2. 提交/推送钩子会不会跑测试套件？

issue 禁止跑 package / repository test suite，需确认钩子不会「背着我」跑。

| 钩子层 | 实测 | 对本任务的影响 |
|---|---|---|
| `core.hooksPath` | `/tmp/flywheel-test-slot-5/state/push-guard/worktrees/<hash>/hooks`（QA slot 的 push-guard） | 目录内**只有 `pre-push`**；它把 stdin 转交 `push-guard/hooks/pre-push`，职责是 force-push 守卫，不跑测试 |
| husky | `package.json` 有 `"prepare": "husky"`，但仓库内**无 `.husky/` 目录**，且 hooksPath 已被 push-guard 接管 | husky pre-commit 不会触发 |
| lint-staged | 配置 glob 为 `*.{js,jsx,ts,tsx,json}` | `README.md` / `*.md` 不匹配，即使触发也不会碰 |
| `.gitattributes` | 不存在；`git check-attr -a README.md` 空 | 无 eol/filter 改写，追加的字节原样入库 |
| `core.autocrlf` | 未设置（darwin 默认 false） | LF 保持 LF |

结论：`git commit` + `git push` 不会引发任何测试；「narrow verification」边界由我们自己守住即可。

## 3. 追加操作的字节级验证（scratch 副本实测）

```
$ cp README.md $SCRATCH/README.probe
$ printf '%s\n' 'Synthetic generalized QA marker: FLY-3084.' >> $SCRATCH/README.probe
$ od -c $SCRATCH/README.probe | tail -5
0000040    7   2   2   T   0   2   3   5   4   0   Z  \n   S   y   n   t
0000060    h   e   t   i   c       g   e   n   e   r   a   l   i   z   e
0000100    d       Q   A       m   a   r   k   e   r   :       F   L   Y
0000120    -   3   0   8   4   .  \n
0000127
$ wc -l   → 4
$ tail -n 1 → Synthetic generalized QA marker: FLY-3084.
$ diff README.md README.probe
3a4
> Synthetic generalized QA marker: FLY-3084.
```

- 追加后 87 字节（44 + 43），第 3 行逐字未动，末尾仍是 `\n`。
- `diff` 只有 `3a4` 一处增行，证明「只加不改」。
- 真实 README.md **未被触碰**（此步只在 scratch 副本上做）。

## 4. PR 落地路径

| 项 | 实测 |
|---|---|
| `gh` | 已登录 `xrliAnnie`，remote 为 `xrliAnnie/flywheel-qa-sandbox` |
| PR 标题建议 | `docs(FLY-3090): append synthetic generalized QA marker to README` |
| PR body 必含 | `## Linear Issue` 段落（FLY-3090 + URL）；测试计划写明只做 README 只读验证、显式声明未跑测试套件 |
| 谁 merge | **不是本节点，也不是实施节点自决**——merge 走 ship 流程（founder-gated），设计与实施节点都只到「PR 打开 + 回报」为止 |

## 5. 对 exploration 方案 A 的确认

方案 A（`printf '%s\n' … >> README.md`）在 §3 实测下满足 exploration §5 全部 5 条成功标准
中前 4 条（第 5 条 PR 归实施节点验证）。没有发现需要改方案的事实。

## 6. 风险登记

| 风险 | 概率 | 缓解 |
|---|---|---|
| 实施节点用编辑器工具重写整文件导致前导空行被「顺手」规范化 | 低 | plan 明确规定用 `>>` 追加 + `git diff` 必须恰为 `+1/-0` |
| marker 文本抄错（如漏句号、FLY-3084 写成 FLY-3090） | 低 | plan 里给出逐字命令；验收用 `grep -cxF` 精确整行匹配 |
| 实施节点顺手跑 `pnpm test` | 低 | plan 验证段只列只读命令，并写明禁令 |
