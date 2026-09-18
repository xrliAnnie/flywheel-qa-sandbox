# Design Review — plan.md (Round 1)

Date: 2026-09-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

分层策略、动态聚合检查名和 main 树复用的总体方向可行，也尊重了既有 `CI OK`、Quick Gate、精确头和 history-free classifier 裁定；我复跑 `data/replay.py` 后，§1.3 / §1.4 的方案表数字与计划一致。当前版本仍有会让 G4 比今天更宽松、让全量请求重复或永久卡住、以及使复用脚本无法按文档实现的阻塞缺口，因此尚未达到 fail-closed、可实施的标准。

## What's Good (Keep)

- 保留 required check 名 `CI OK`，只让 scoped 普通头产生 `CI Scope OK`；未履行全量义务的头因此在 G1/G2/G3 上缺少 `CI OK`，这是正确的 fail-closed 主轴。
- `heavy != 'skip'`、未知 `mode` 回落到 `CI OK`、聚合步骤逐个断言重 job 结果的设计方向正确；全量分支不接受 skipped，跳过分支不接受部分执行。
- Quick Gate 始终运行、`scripts/ci-classify.sh` 不读取历史、静态 unit 矩阵和 shard 清单不改，均与 FLY-1861 / FLY-1877 / FLY-1987 的既有裁定一致。
- 经 actionlint 1.7.12 和官方 Actions 语义核对，`jobs.<id>.name` 使用 `needs`、`pull_request: labeled`、`vars` 和所写 `run-name` 表达式在语法层面可行；由 `GITHUB_TOKEN` 产生的普通事件不会递归触发 workflow，因此由本机用户令牌打 label 的边界也写对了。
- main 复用坚持“artifact 只作索引、run/job/API 与 git 独立重算才是证明”，并明确不顺手放宽 PR 头复用或 docs-only 的 G4 语义，范围控制合理。
- [verified by executing] `data/replay.py` 复现了 10,936 基线、−7.9% / 13.5% / 21.1% 以及分层方案 59.2% / 52.8% / 46.4% / 38.7%（main 复用时 66.8% / 60.4% / 54.0% / 46.4%）；计划当前采用的 Lead 判据与重放结果一致。

## Issues & Recommendations

1. **阻塞 — G4 会忽略同 workflow 的后续失败，明确比今天更宽松。** §2.5 第 5 条把 `workflow == K.workflow` 且 run id 不同的所有条目都忽略，甚至明确包含“之后又触发的 scoped run”。反例是：同一头先有全量绿 K，随后 `reopened` 或其它 label 触发 scoped run，Quick Gate 变成 fail / pending / cancelled；新规则仍会用旧 K 放行，而今天 `probeShipCiGreen` 的 ALL-pass 规则会拒绝。`gh pr checks` 的 `workflow` 还是显示名，不是 `.github/workflows/ci.yml` 的稳定身份，另一个同名 workflow 也会被错误归组；当前 runner 又用 `execFileSync`（`ship-ci-guard.ts:20-26`），失败/待定时 CLI 的非零退出可能在读取 JSON 前直接抛错，无法可靠实施“只忽略旧噪音”。建议只豁免**早于 K**、且名字精确属于已实测遗留集合的 `CI Scope OK` 与 `Unit (${{ matrix.name }})`；任何晚于 K 的条目仍必须 pass。通过 Actions run API 将 K 绑定到本仓、精确头、`pull_request`、`.github/workflows/ci.yml` 和 latest attempt，并回验该 run 的完整 16-job 全绿形状；命令 runner 改为同时返回 stdout 与 exit status。补充“全量绿后又有 scoped Quick Gate fail/pending/cancel”“另一个 workflow 也叫 CI”“CLI 非零但 stdout 有合法 JSON”的负面对照。

2. **阻塞 — cancelled 全量的恢复路径自相矛盾，并可能让 G3 永久失败。** §2.3 步骤 3 会把已有 cancelled `CI OK` 当作“其它已完成结论”直接返回 1，所以到不了步骤 4 声称的 cancelled 恢复；若旧 run 尚未显出 `CI OK` 而步骤 4/5 另起一个 label run，旧 cancelled `CI OK` 稍后出现时又会与新 success `CI OK` 同时留在 `statusCheckRollup`。`exactGreenCi` 和 `contentCarryoverCiReason` 都要求所有同名 `CI OK` 成功，因此头会永久落在 failed。实测 PR #1212 证明同头的两个独立 run 会保留两条 `CI OK`；相反，run `35151422945` 的第 7 attempt 用 `jobs?filter=latest` 只返回最新 attempt 的 16 个 success，说明复用现有 `gh run rerun <databaseId>` 才与 G3 合同兼容。建议已发出请求后绝不再用 label 创建第二个 full run：cancelled 走同一 run 的 rerun（沿用 `ship-await-ci.sh` 的既有模式），其余结论给出闭合、fail-closed 的人工恢复表。该表还必须覆盖 `action_required`、`neutral`、`skipped`、`stale`、未知 conclusion、completed-success 但无 `CI OK`、以及旧 success `CI OK` 之后出现更新 full run 的优先级；查询加入明确 `--limit` 和 `url`（当前 JSON 字段列表无法打印计划承诺的 run 链接）。

3. **阻塞 — `ensure` 的锁在当前 Node 上不可实现，且进程锁不足以满足幂等判据。** [verified by executing] 当前 macOS / Node v25.6.1 的 `fs.constants.O_EXLOCK` 为 `undefined`；标准 Node 文件 API没有计划所写的“darwin `O_EXLOCK`、进程退出自动释放”合同。仓库已经有并被 flywheel-comm 使用的 `withMkdirLock`，应直接复用。更重要的是，即使换成可用的互斥锁，进程在 add-label 成功后崩溃、API 响应丢失、或 60 秒内 run 尚不可见时，下一次调用仍会再次 remove/add label，违反“同一头重复调用不产生第二次全量”。建议在任何外发动作前写入按 repo/pr/head 键控的 durable request intent/receipt，在锁内先对账 receipt、label、run 与精确 PR 头；未决 receipt 只能继续观察或要求显式恢复，不得自动再次 toggle。外发前再次读取 `headRefOid`。测试必须覆盖 add 成功后崩溃、响应丢失、可见性延迟超过 60 秒、陈旧锁和锁内 head 移动。

4. **阻塞 — 用“当前 repo variable”解释历史 run，会在开关切换时误判。** §2.3 步骤 4 用 `gh variable get CI_SCOPED_MODE != on` 推断查到的历史 run 都是 full；但 repo variable 是可变的，不是 run 创建时的事实。典型反例是 mode=on 时产生 scoped run，随后回滚为 off，再对同一头调用 `ensure`：旧 scoped run 会被重新解释成 full，可能阻止本应产生的 16-job run或落入未定义的 completed-success 分支。建议 full/scoped 身份只由不可变 run 证据决定：请求标题/receipt 加上该 run 的实际 job/check 形状，不得读取当前变量来重分类历史。补充 on→off、off→on、回到旧头以及 merge-head 的状态迁移测试。

5. **阻塞 — §2.6 没有下载 artifact，却在后续读取其中的 `tested_parents`。** `GET /actions/artifacts?name=...` 返回的是 artifact 元数据，不包含上传 JSON 的文件内容；步骤 1–3 没有 archive download，步骤 4 因此无法实现。需要明确调用 `/actions/artifacts/{artifact_id}/zip`，在受限临时目录中只读取一个固定文件名，并对压缩包大小、条目数量/路径、JSON schema、字符串长度和 40-hex OID 做上限及类型校验；任何异常继续 `reuse=false`。C2 测试应加入缺文件、重复文件、路径穿越、超大 archive、坏 zip 和畸形 JSON。当前算法也没有读取 PR endpoint，故 classify 新增的 `pull-requests: read` 没有依据，应删除以维持 least privilege，除非修订后的算法真的引入该 API。

6. **高 — 交付清单漏了生成投影和一个现有 shard 守卫，按当前 C7/C4 实施会留下漂移。** 修改 `packages/teamlead/phase-protocols/{qa,implement}.md` 后，`scripts/sync-phase-protocols.mjs --check` 要求 `.flywheel/agents/nodes/{qa,implement}.md` 的 managed block 同步；`packages/teamlead` 的 `prebuild` 已强制执行这个检查。C7 应明确先审阅 canonical 文件，再运行 `--write`，把两份生成投影列入改动，并以 `--check` 和 FLY-2533 asset suite 验证。另一个事实错误是计划称 `fly-889-ci-workflow-timeout-guard.test.ts` 已覆盖全部 script shard，但其中 `scriptShardIds` 只有 `script-tests` 到 `script-tests-4`，遗漏 `script-tests-5`；既然 C4 会改该文件，应一并修复并加变异对照。上线核对也不能只看 `flywheel-comm ci-full --help`：打开变量前至少要 canary 新 ship guard、CLI、Blueprint CI PRECONDITION 和 QA/implement protocol 投影均已部署/生效，否则系统虽 fail-closed，却会在冻结头上运营性卡死。

7. **低 — 让 140 分钟假设在重放程序中自证。** 表格算术正确，且 140 与“干净、单 attempt 的全量”样本相符；但当前 `replay.py` 同时打印“green full run mean = 161, n=41”后再硬编码 `FULL = 140`，读者无法仅靠脚本输出区分 rerun-weighted mean 与 clean-run 估值。建议脚本直接计算并标注 clean single-attempt 的 billed median/mean，再用该导出值生成 §1.4 表，避免 7 天复核时口径漂移。

## Verdict

CHANGES REQUESTED — address items above
