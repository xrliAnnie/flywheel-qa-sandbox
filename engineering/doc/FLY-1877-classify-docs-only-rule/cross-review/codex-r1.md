# Design Review — FLY-1877 plan.md (Round 1)

Date: 2026-08-18
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向、删减边界与大部分源码事实都正确；在当前 `pull_request` merge-preview checkout 加 `fetch-depth: 0` 下，显式对 `BASE_SHA`/`HEAD_SHA` 求 merge-base 并检查累计 diff 是可行的。当前仍有一个可复现的 fail-open：存在多个同等 merge base 时，计划使用的 `git merge-base` 会任取一个，可能仅看到文档 diff 而跳过重 job，因此尚未满足“任何不可证明情况都全跑”。

## What's Good (Keep)

- 严格执行 founder 已定的单规则与净删除方向，没有保留 runs API/history baseline，也没有引入第二套规则、feature flag 或路径到 job 的耦合分析。
- 对当前实现的描述准确：现脚本确为 145 行；runs API 翻页、latest completed run、success/base/ancestor 校验都位于计划指出的区段；Python raw-diff 检查器及四前缀、后缀、symlink/gitlink 拒绝逻辑可直接复用。
- CI checkout 形态可行：classifier 不使用 merge-preview 的裸 `HEAD`，而使用事件提供的 PR head/base SHA；`fetch-depth: 0` 被结构 guard 钉住，缺对象时又分别以 `head_commit_missing`/`base_commit_missing` fail closed。
- 对 `ci-structure.test.sh` 的事实核对准确：四个重 job 的 `needs`/`if`、`ci-ok` 聚合表达式、classify 权限 exact-match、checkout fetch-depth、唯一 run 与 step id 均被钉；classifier step 的 `name` 和 `env` 没有被钉。
- `ci-status-vectors.json` 的 `baseline` 删除 blast radius 已正确收敛。全仓只有三个该 JSON 的消费者；重写 classifier test 后，另外两个消费者只读取 `status`/`conclusion`/`await`/`receiver`，删除该键不会改变其输入合同。
- `.github/workflows/ci.yml` 的注释、step name 与三个失效 env 的清理是有界且合理的；全仓没有其他代码依赖旧 step name，这些改动也不改变 job 图、permissions、needs、if、run 或 id。
- 负向向量已覆盖 code-only、mixed、机器消费文件、rename、symlink、gitlink、非法/缺失对象与 unrelated history；runs API 零引用还设计了阳性对照，方向正确。
- 当前基线的 `ci-classify.test.sh`、三个 CI guard 与 `ship-await-ci.test.sh` 均已实际执行通过；仓库除待审 plan 外没有新增改动。

## Issues & Recommendations

1. **多个同等 merge base 会绕过 fail-closed。** Git 明确允许一对 commits 有多个 best merge bases；未带 `--all` 时输出哪一个是 unspecified。计划 L134 的单值调用仍会返回合法 40-hex 并通过校验。我用 criss-cross commit graph 实测：被任取的 base 到 head 只包含 `doc/note.md`，但另一个同等合法 base 到同一 head 同时包含 `code.ts` 与 `doc/note.md`；按当前形态会输出 `no_code=true`。这直接违反“anything unprovable → full run”。建议把调用收窄为 `git merge-base --all "$base_sha" "$head_sha"`，只接受输出恰好一行 40-hex；零个或多个都 fail closed（可复用 `merge_base_unresolvable`，或用明确的 `merge_base_ambiguous`），并新增一个 criss-cross 多 merge-base 负向向量。这里只是让现有单规则确定化，不是增加新机制。

2. **§6 没有把“白名单逐字不变”和 uppercase SHA 锁进测试。** 正例目前只覆盖四个允许前缀中的 `engineering/doc/`、`doc/`，以及 14 个允许后缀中的 `.md`、`.png`；实现误删 `product/doc/`、`content/doc/` 或任一较少用后缀时，套件仍会绿但固定合同已回归。脚本特意接受并归一化 uppercase SHA，向量表却也未覆盖该分支。建议用一个简单的 table-driven 正例矩阵让四个前缀和每个允许后缀至少各出现一次（无需做 4×14 笛卡尔积），再加 HEAD/BASE uppercase 的成功向量；最好同时放一个 allowlisted 普通文件删除正例，证明“touches”不只覆盖新增文件。

3. **§7 声称本地跑三个 guard，但自验命令只列了 `ci-structure.test.sh`。** 这使“守卫不变且仍绿”的验收映射与实际执行清单不一致，而且仅跑测试也不能证明三个受保护文件未被修改。建议在自验清单中显式加入 `ci-matrix-coverage.test.sh`、`ci-shell-suite-enumeration.test.sh`，并增加相对实现基线对这三个文件的 diff-zero 检查。`ship-await-ci.test.sh` 加 land-driver 定向测试足以验证 vectors 删列；请把 land-driver 的准确 `pnpm` 命令也写明，避免执行阶段口径漂移。

## Verdict

CHANGES REQUESTED — address items above
