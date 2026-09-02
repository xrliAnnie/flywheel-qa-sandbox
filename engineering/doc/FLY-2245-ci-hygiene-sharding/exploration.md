# FLY-2245 CI 卫生与脚本分片 — 探索
Issue: FLY-2245 (https://linear.app/geoforge3d/issue/FLY-2245/ci卫生-doc-目录整体-inert-分类-script-tests-22-拆-shard9-1-容量-tripwire)
日期: 2026-09-01
基于: 无

## 问题边界

本单只处理两项 CI 卫生问题：

1. `engineering/doc/**` 是设计、取证和交付物快照目录，其中非 Markdown 脚本/数据工件不接线生产 runtime；这类纯文档形 PR 不应触发重 shell 套件。
2. `Script Tests` 两片仍贴近 FLY-1870 的 85% 容量 tripwire；必须通过增加 shard 和重平衡恢复到每片不超过 20 分钟 cap 的 70%，不能提高 cap 或放宽 tripwire。

不在本单范围：修改任何 shell suite 的行为/等待时长、降低覆盖、改动 always-on `quick-gate`、修改 85% tripwire 阈值、合并或部署 PR。

## 当前代码事实

- `.github/workflows/ci.yml` 的 `classify` job 调用 `scripts/ci-classify.sh`；`quick-gate` 不受分类结果影响，重 job 通过 `needs.classify.outputs.no_code != 'true'` 决定是否运行。
- `scripts/ci-classify.sh` 当前要求路径同时满足四个文档前缀之一和扩展名白名单；因此 `engineering/doc/**/*.sh|py|js|json` 会被判为 `diff_not_inert`。
- 分类器还保留一组明确的 `known_ci_consumed_doc_paths`，这些路径是 no-code-gated 测试的机器输入，现状会强制跑重套件。
- `script-tests` 与 `script-tests-2` 都保持 `timeout-minutes: 20`，末步都执行 FLY-1870 的 85% tripwire。
- workflow 注释记录 2026-08-31 实测为 shard 1 = 929s、shard 2 = 1077s；随后把约 77s 的完整测试 step 从 shard 2 移到 shard 1，估算约 1006s/1000s，即约 84%/83%，仍高于本单 70% 验收线（840s）。
- FLY-1870 的 runbook 已明确：双片都逼近时新增 shard，复制完整 setup/tripwire 骨架，并以完整 named step 为单位重平衡。

## 拟保留的安全语义

- 不动 `quick-gate`，所以 FLY-2045 这类专抓 docs 回归的 always-on 轻检查继续运行。
- 分类器任何 Git 异常、非普通文件、文档目录外改动继续 fail-closed 为 `no_code=false`。
- FLY-1870 tripwire 的 cap、85% 阈值、首步计时、末步 `if: always()` 和失败文案全部保持。
- 所有现有 Script Tests 命令恰好归属一个 shard；不得新增 `if`、`continue-on-error` 或漏跑。

## TDD seam（待设计评审确认）

1. **分类 seam**：`scripts/ci-classify.sh` 的公开环境输入（`HEAD_SHA`、`BASE_SHA`、`GITHUB_OUTPUT`）和 `no_code=true|false` 输出。新增真实临时 Git 仓库向量，证明 `engineering/doc/` 内非白名单扩展普通文件为 inert，同时目录外同扩展、已知机器消费路径和 symlink/gitlink 负例保持 fail-closed。
2. **workflow seam**：`scripts/__tests__/ci-structure.test.sh` 与 teamlead 的 workflow timeout guard 解析真实 `.github/workflows/ci.yml`。先让守卫要求三片并失败，再最小修改 workflow 使 job 图、完整 step inventory、setup、tripwire、`ci-ok.needs` 一起转绿。
3. **容量 seam**：以最近真实 CI job/step duration 作为分配输入，PR CI 的三片 elapsed 作为最终证据；静态测试只证明结构与保护语义，不能替代 ≤70% 的真机时长证据。

## 需要在调研/计划中定稿

- `engineering/doc/**` 的目录级 inert 规则是否仍保留 `known_ci_consumed_doc_paths` 精确例外；必须以 issue 的“整体 inert”边界和这些消费方的真实运行位置为准，不能凭文件名猜。
- 三片的 step 分配必须基于最近可取得的 GitHub Actions step duration，而不是继续沿用 2026-08-17 的历史秒数。
- shard 命名统一改为 `Script Tests 1/3`、`2/3`、`3/3`，job id 保持前两片兼容并新增 `script-tests-3`。
