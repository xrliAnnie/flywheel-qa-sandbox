# Design Review — plan.md (Round 4)

Date: 2026-09-22  
Author: Codex  
Status: CHANGES REQUESTED

## Summary

本轮严格只核验 Round 3 的两个阻断项，并将结论绑定到 commit `f33f7c9c0a3212e75a7d076b4f27946ade04f54c`。该 commit 只修改了 `plan.md`。

第 1 项已经关闭：v4 明确要求 stored members 与 observations 同时按当前 `{profile, accountKey}` 取交集后重放；交集为空时 fail closed；并加入了指定的跨 reset 时序测试。

第 2 项部分关闭：5 个 CI shell suites 已全部进入迁移清单，并明确按 CI 的 `bash` 命令逐个执行；两段 residue gate 也已写入。但 plan 声称在基线 `58693d28c` 上 scoped regex 并集命中 7 个 claude-runner 测试文件，这一证明无法复现。按 §3.5 列出的 claude-runner 文件执行原样正则，实际只命中 5 个；teamlead 3 个和 shell 5 个与声明一致。因此测试/fixture closure 仍有一个窄的阻断缺口。

## Item verification

| item | closed? | evidence |
|---|---|---|
| 1. removal-only capacity fact replay | Yes | `plan.md` §3 Chunk E 明确要求 stored members 与 observations 一起按当前 `{profile, accountKey}` 取交集后交给 selector；空交集保持旧事实为 current（fail closed）。测试合同固定为 A `t+10s`、B `t+50s`、`t+5s` 删除 A、`t+15s` guard=true、`t+55s` guard=false，并另测空交集 guard=true。 |
| 2. test/fixture closure | No | 5 个 shell suites 均在 §3.5 迁移清单，且 §3.5 明确逐个执行 `bash scripts/__tests__/<name>.test.sh`；基线 CI 也确实执行这 5 个文件。两道 residue gate 已写入。可是对基线 `58693d28c` 的 scoped regex 并集实跑结果为 claude-runner **5**、teamlead **3**、shell **5**，不是计划声称的 **7/3/5**。claude-runner 的 5 个命中文件是 `CodexTmuxAdapter.test.ts`、`codex-account-identity.test.ts`、`codex-account-install.test.ts`、`codex-home.test.ts`、`codex-profile-quota-refresh.test.ts`。repo-wide `loadCodexAccountRegistry|CodexAccountRegistry` gate 在 claude-runner 测试中只额外看到已重叠的 `codex-account-identity.test.ts`，不能补出另外两个 fixture。 |

## Blocking issues

1. **基线 fixture-gate 证明的 claude-runner 计数不成立。**

   §3.5 要求实施前在 `58693d28c` 上证明 scoped union 能命中已知 v1 fixtures，并记录为 claude-runner 7、teamlead 3、shell 5。实际按计划中的两个正则及列出的文件范围执行，只得到 5/3/5。因而当前写下的 pre-change proof 会在实施时与事实冲突，无法作为同一判据由“已知非零”收敛到 post-change 0 的可靠验收证据。

   最小修正：明确列出基线预期命中文件。如果正确集合就是上述 5 个 claude-runner fixtures，则把 7 修正为 5，并说明另外两个原本预期的文件为何不是 v1 account-registry fixture；如果确实应有 7 个，则补全 scope 或 predicate，使那两个具体文件在 `58693d28c` 上真实命中。teamlead 3 个与 5 个 shell suites 无需改动。

## Advisory

无。对 v4 的 bounded diff 未发现其它新的阻断回归。

## Verdict

**CHANGES REQUESTED**
