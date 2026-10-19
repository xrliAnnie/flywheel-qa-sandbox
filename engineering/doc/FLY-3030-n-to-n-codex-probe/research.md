# FLY-3030 N-to-N Codex 体探针 — 调研
Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: exploration.md

## R1. README.md 的确切字节

`od -c README.md`：

```
0000000  \n \n  F  L  Y  -  1  3  7  5     l  a  n  d
0000020     E  2  E     m  a  r  k  e  r     2  0  2  6  0
0000040  7  2  2  T  0  2  3  5  4  0  Z \n
0000054
```

- 44 字节，`wc -l` = 3（两行空行 + marker 行），**最后一个字节是 `\n`**。
- 所以 `printf '%s\n' 'FLY-2919 N-to-N codex-body probe' >> README.md` 恰好得到第 4 行，不会粘到上一行尾，也不会多出空行。
- 追加后应为 44 + 33 = **77 字节、4 行**；`git diff --numstat -- README.md` 应为 `1<TAB>0<TAB>README.md`。
- 目标行 `FLY-2919 N-to-N codex-body probe` = 32 个 ASCII 字符 + 换行 = 33 字节。

## R2. 幂等判定（换体续干的关键）

执行体随时可能被杀（FLY-2919 就是要测这个）。新体接手时，工作区可能处在 5 种中间状态之一：

| 状态 | 可观测判据 |
|---|---|
| S0 未动 | README 中目标行出现 0 次 |
| S1 已追加未提交 | 目标行 1 次且为最后一行；`git diff --quiet -- README.md` 非 0 |
| S2 已提交未推送 | 工作区 README 干净；`git log origin/main..HEAD` 里有 README 提交；`git rev-parse HEAD` ≠ 远端分支头（或远端分支不存在） |
| S3 已推送未开 PR | 远端分支头 = 本地 HEAD；`gh pr list --head <branch> --state all` 为空 |
| S4 已开 PR | 上面的 PR 查询返回 1 个 OPEN PR |

判据全部来自 git / GitHub 本身（单一真相），不依赖进程、窗口或内存状态——这正好与「活体丢窗口不判死」互不干扰：plan 不读窗口。

**异常态（必须 STOP + ask，不自愈）**：目标行出现 ≥2 次；目标行出现 1 次但不是最后一行；README 有目标行以外的改动；远端分支与本地分叉（非快进）；同 head 有 ≥2 个 PR 或 PR 已 CLOSED/MERGED。

## R3. 推送约束

- `core.hooksPath` = slot push-guard（`/tmp/flywheel-test-slot-2/state/push-guard/worktrees/<hash>/hooks`），`pre-push` 转发到 slot 级守卫。禁止 `--no-verify`、禁止改 `core.hooksPath`。
- 普通快进推送 `git push -u origin HEAD:refs/heads/project-slot-2-FLY-3030` 即可；非快进 = 异常态，按 FORCE-PUSH GUARD 先 ask Lead。
- 本仓没装依赖（无 `node_modules`）；本单不需要 `pnpm install`，因此也不会触发根 `package.json` 的 husky `prepare` 改写 hooksPath（见同 slot 历史坑）。实现节点**不得**为了跑 lint/test 去装依赖。

## R4. CI

- `.github/workflows/ci.yml`：`pull_request` → `main` 触发 `Build & Test`（install / build / typecheck / lint / test，~13 min，timeout 20 min）。
- PR 刚开时 `gh pr checks` 可能先报 no checks（exit 1），`gh pr checks --watch`（gh 2.97）在 `statusCheckRollup=[]` 时立刻退出不等——要先有界轮询 `gh pr view --json statusCheckRollup` 非空再 watch。
- 纯 README 改动不改变任何构建输入，CI 结果应与 `origin/main` 一致；若 CI 红，先用 main 的 CI 结果对照判断是否 pre-existing，再按 implement 协议处理（不在本 plan 内自行扩大范围修代码）。

## R5. implement 节点合同要点（来自本 run 快照 `tpl_code` rev 1）

- `creates_pr=true`，完成路由 `needs_review`。
- PR 必须以 `engineering/doc/milestones/FLY-3030.md` 作为**字面最后一个 commit**；不改 `CLAUDE.md`。
- `local-test-policy/v1`：禁止任何全量本地测试。本单改动是 `README.md` 一行 + 文档，无 TypeScript、无 `scripts/__tests__/*.test.sh`；`git grep -lF -- 'FLY-2919 N-to-N codex-body probe'` 只会命中 README 与本 issue 文档，**选中测试集为空**——按策略不得回退到宽命令，改为检查 diff 本身（R1 的字节断言）。全量证据只认 PR 精确头 CI。
- 代码评审：按注入的评审门走（Claude 作者族 → `codex:rescue`；Codex 作者族 → 注入的 `request-review --type code` 通道）。评审对象就是这一行 + milestone，评审提示词须以 local-test-policy 块原文开头。
- 回报：`ask --report` + `complete --route needs_review --pr <N>`（以注入命令为准）。

## R6. 本单不做

- 不在生产（`~/Dev/flywheel`）或生产 Bridge 上做任何事；不派单、不起房间（房间由 FLY-2919 driver 管）。
- 不改 `packages/`、CI、脚本。
- 不合并、不 ship。

## R7. 第 2 轮（claude-body）新增事实（2026-09-28 实测）

- 当前 README：77 字节 / 4 行，末字节 `\n`，第 4 行 = `FLY-2919 N-to-N codex-body probe`。
- 新目标行 `FLY-2919 N-to-N claude-body probe` = 33 字符 + 换行 = **34 字节**（`printf … | wc -c` = 34）。追加后 README = **111 字节 / 5 行**，相对 `origin/main`（`1855f7a1a`，未漂移）numstat = `2<TAB>0<TAB>README.md`。
- 两个目标行互不为子串（`grep -xF` 整行匹配），计数各自独立。
- 旧冻结判据失效：`git cat-file -e HEAD:engineering/doc/milestones/FLY-3030.md` 现在已成立。新判据：`HEAD:<milestone>` 的内容包含 claude-body 行（`git show HEAD:$MS | grep -qF -- "$LINE"`），第 1 轮 milestone 不含它 → 未冻结；本轮 milestone 写入后 → 冻结。
- 本轮 README commit 判据：`origin/main..HEAD -- README.md` 共 **2** 个 commit（codex 轮 1 + claude 轮 1），且 subject 含 `claude-body` 的恰 1 个。
- PR #299 已 OPEN、head = 本地 HEAD、`statusCheckRollup` 非空（2 项，属第 1 轮头）。本轮复用它：push 新头后 CI 对新头重跑；标题/正文用 `gh pr edit` 幂等更新为覆盖两轮。
- `sleep 780` 的幂等判据：sleep 是「追加」之前的一步，因此**工作区 README 已含 claude 行** ⇒ 某个前体一定已睡满 780 秒 ⇒ 可跳过；否则（包括睡到一半被杀）新体必须重新完整前台睡 780 秒。判据来自文件本身，不依赖账本文字、进程或窗口。
