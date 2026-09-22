# Design Review — plan.md (Round 3)

Date: 2026-09-17
Author: Codex
Status: APPROVED

## Summary

Round 2 的三个阻塞项均已关闭，且修订已传播到规范、改动清单和负面对照：`ensure` 的所有新旧判断改用 latest-attempt `run_started_at`；G4 只在 `gh pr checks` 正常终止且 status 属于 `{0,1,8}` 时消费完整 JSON；三个验证器统一通过 `.github/ci-required-jobs.json` 验证精确的 16-job 成功多重集。没有发现新的安全性、恢复性或可实施性阻塞项。

本次结论绑定 plan commit `26c12368c`，其 `plan.md` blob 为 `f960d04b23f660045c07323eb4475d43a856647b`、文件 SHA-256 为 `914bacfb1d49a9a782260b72dc28f89c9f88e1b6acc54f5ea417e54738050845`。当前 HEAD `8d30e0ff745b1cb72aaead5c60d89496d3004ad2` 仅更新 `progress.md`，其 `plan.md` blob 与 `26c12368c` 完全相同。本轮是计划审批，不代表尚未实施的代码已经通过实现审查。

## What's Good (Keep)

- **Round 2 #1 已关闭。** §2.3 明确定义 `epoch(run) = latest attempt run_started_at`，所有 run 排序、`N` 选择和 scoped/full supersession 都只用 epoch，不再用原始 `createdAt`。状态表说明 rerun 后 epoch 前移、下一次 `ensure` 返回 0；C6 同时覆盖 full→scoped→rerun-full 和 scoped→full→rerun-scoped 两个方向。
- [verified by executing] 现有多-attempt run `35151422945` 的顶层 API 当前显示 `created_at=2026-09-16T21:16:13Z`、attempt 7 的 `run_started_at=2026-09-16T22:59:13Z`，且 `jobs?filter=latest` 只返回 attempt 7 的 16 个 success job；新 epoch 合同与 GitHub 实际返回形状一致。
- **Round 2 #2 已关闭。** `ShipCiCommandRunner` 的合同包含 `{stdout,status,signal,error}`；只有无 error、无 signal、status 属于 `{0,1,8}` 的正常终止才可解析 checks。timeout、signal death、status null 和未知退出码即使带合法 JSON 也 fail-closed。§4.2 已加入绿色 JSON 前缀后超时、2/4/127、完整 exit 1 和 exit 8 的独立对照。
- [verified by executing] 本机 Node 子进程可以在输出合法 JSON 后超时并返回 `status=null`、`signal=SIGTERM`、`error.code=ETIMEDOUT`；计划新增的正常终止门会明确拒绝这个 Round 2 反例。
- **Round 2 #3 已关闭。** `.github/ci-required-jobs.json` 把 `always`、13 个 heavy 名、full/scoped aggregate 名集中成唯一合同；G4、reuse 和 ensure 都要求 latest-attempt job-name **多重集**精确等于 `always + heavy + [aggregate]`，同时全部 success，因此缺项、多项、同名重复和 skipped 都拒绝。
- [verified by reading code] 当前 `ci.yml` 展开后确为 2 个 always + 13 个 heavy + `CI OK` = 16 个唯一检查名；计划要求 `ci-structure.test.sh` 把 manifest 与这些实际名字、unit matrix 展开行及动态 aggregate 两个字面量逐字钉住。
- 形状合同的测试传播完整：G4 有 3-job、15-job、缺 matrix、缺 shard、未知额外 job、重复名和缺/坏 manifest；C2 镜像相同失败面；C6 对成功 run 的 multiset 不符返回 `inconsistent`。这避免三个消费者各自维护近似定义。
- 旧头兼容保持 fail-closed：manifest 缺失或畸形时，G4 只回退到无例外的 legacy ALL-pass；scoped-only 或带遗留 skipped/cancel 条目的头仍不会被放行，而 `ensure` 明确退出 2。
- Round 1 已接受的 G4 受限例外、Actions API 身份绑定、write-ahead 回执、同-run rerun、不可变 run 证据、metadata-only tree reuse、协议投影/canary 和 clean-run 成本口径均保持不变，没有相邻回退。

## Issues & Recommendations

No blocking issues.

实施审查时按计划中的 C2/C4/C5/C6 mutation controls 和两条 attempt-ordering 时序测试验证实际代码即可；这不是本轮批准的附加条件。

## Verdict

APPROVED — all Round 2 blockers are closed in the plan
