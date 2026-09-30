# FLY-3090 generalized README marker — 探索

Issue: FLY-3090 (https://linear.app/geoforge3d/issue/FLY-3090/synthetic-qa-fly-3084-generalized-real-inference-readme-marker)
日期: 2026-09-29
基于: 无

## 1. 任务原文（issue 合同）

> In the repository root `README.md`, add one new final line exactly:
> `Synthetic generalized QA marker: FLY-3084.` Keep the existing line unchanged.
> Do not modify any other product file. Run only a narrow verification that reads
> `README.md`; do not run a package or repository test suite. Open the sandbox PR
> against `main`.

这是 FLY-3084 的 **synthetic（合成）QA 任务**：目的不是改产品，而是让 generalized
workflow（design → implement → …）在真实推理下跑完整条链。产品改动被刻意压到最小，
以便 QA 观察的是**流程行为**而不是代码难度。

## 2. 现状审计（2026-09-29，分支 `project-slot-5-FLY-3090`，HEAD `1855f7a1a`）

### 2.1 `README.md` 字节级现状

```
$ od -c README.md
0000000   \n  \n   F   L   Y   -   1   3   7   5       l   a   n   d
0000020    E   2   E       m   a   r   k   e   r       2   0   2   6   0
0000040    7   2   2   T   0   2   3   5   4   0   Z  \n
0000054
```

- 共 3 行：第 1、2 行为空行，第 3 行为 `FLY-1375 land E2E marker 20260722T023540Z`。
- 文件以 `\n` 结尾（POSIX 完整行），**没有** trailing 空白、没有 CRLF、没有 BOM。
- 44 字节。最近三次触碰 README 的 commit：`e9a75dfed`（FLY-1375）、`7049f7199`
  （FLY-1286）、`e03d7ae99`（FLY-124）——全是历史 sandbox QA 轮留下的 marker，
  与本任务同型。

**结论**：「Keep the existing line unchanged」指第 3 行；两个前导空行同样原样保留
（issue 未授权清理）。新行追加在当前最后一行之后，追加后文件仍以 `\n` 结尾。

### 2.2 仓库与工具

| 项 | 实测 |
|---|---|
| remote | `origin = https://github.com/xrliAnnie/flywheel-qa-sandbox.git`（沙箱仓，非生产 flywheel） |
| 分支 | `project-slot-5-FLY-3090`，尚无 upstream（首次 push 需 `-u`） |
| 工作树 | 干净 |
| `gh` | 已登录 `xrliAnnie` |
| doc 文件夹 | `engineering/doc/` 下无 FLY-3090- 前缀文件夹 → 新建 `FLY-3090-generalized-readme-marker/` |
| 仓库内 FLY-3084/FLY-3090 引用 | 零（grep 全仓 `*.md` 无命中）——marker 是全新字符串，不会与既有内容冲突 |

### 2.3 项目约定检查

- 这里是 **flywheel-qa-sandbox**（生产仓的结构镜像），CLAUDE.md 是从生产仓镜像来的；
  其中「必须走 worktree+branch+PR、绝不 push main」的规则对本任务成立，且 issue 明确要求
  「Open the sandbox PR against `main`」。
- doc-flow tier = full：exploration / research / plan 三份文档 + 本文件夹 progress.md，
  随分支进 PR。

## 3. 需求拆解与歧义清单

| # | 问题 | 判定 | 是否阻塞 |
|---|---|---|---|
| Q1 | 「final line」是否要求文件以换行符结束？ | 是。现状以 `\n` 结尾，追加后保持 `\n` 结尾，避免 `\ No newline at end of file` 噪音 diff。 | 否 |
| Q2 | 前导两个空行要不要顺手清理？ | 不清理。issue 说「Do not modify any other product file」且「Keep the existing line unchanged」，清理属于 scope 之外。 | 否 |
| Q3 | 「narrow verification that reads README.md」允许什么？ | 只读 README 的命令：`tail -n 1`、`grep -c`、`od -c`、`git diff`。**不跑** `pnpm test`/`vitest`/lint。 | 否 |
| Q4 | 文档（engineering/doc/…）算不算「other product file」？ | 不算。doc-flow 是流程强制产物，不是产品文件；issue 的禁令针对产品源文件。 | 否 |
| Q5 | marker 写 FLY-3084 而非本 issue FLY-3090，是否笔误？ | 不是。本 issue 标题即「SYNTHETIC QA FLY-3084 …」，FLY-3084 是被验证的上游 QA 计划号，marker 文本必须**逐字**照抄 issue。 | 否 |

没有阻塞性歧义，无需向 Lead 发问。

## 4. 方案空间

| 方案 | 描述 | 取舍 |
|---|---|---|
| **A（选定）** | `printf '%s\n' 'Synthetic generalized QA marker: FLY-3084.' >> README.md` | 最小、可精确控制字节；`>>` 不触碰既有内容。 |
| B | 用编辑器/Edit 工具把整文件重写为 4 行 | 结果等价但重写整个文件，多一次「读全文再写回」的风险面，无收益。 |
| C | `echo '...' >> README.md` | 与 A 等价，但 `echo` 在不同 shell 下对转义/`-n` 行为有差异；`printf` 更确定。 |
| D | 顺手把前导空行删掉、加标题 | 越权（Q2），拒绝。 |

## 5. 成功标准（可机验）

1. `tail -n 1 README.md` 输出恰为 `Synthetic generalized QA marker: FLY-3084.`
2. `sed -n 3p README.md` 仍为 `FLY-1375 land E2E marker 20260722T023540Z`（既有行不变）。
3. `wc -l README.md` = 4；`tail -c 1 README.md | od -c` 为 `\n`。
4. `git diff --stat main -- . ':!engineering/doc'` 只列 `README.md`，且为 `+1` 行、`-0` 行。
5. PR 目标分支 `main`，PR body 链接 FLY-3090。
