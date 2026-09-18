# FLY-2681 重放数据

- `runs-0916.tsv` / `runs-prev.tsv`：`GET /repos/xrliAnnie/flywheel/actions/workflows/ci.yml/runs?created=…`（2026-09-16；2026-09-10..15 仅用于找每个分支的前一个头）。列：run id、event、status、conclusion、head_branch、head_sha、run_started_at、updated_at、run_attempt。
- `jobs-0916.tsv`：每个 09-16 run 的 `/jobs?filter=all`。列：run id、job 名、status、conclusion、started_at、completed_at、run_attempt。
- `paths.py` → `paths-0916.json`：每个 run 头相对 merge-base（push 取第一父）的改动文件。需要本地有这些提交对象。
- `stats.py`：每个 job 的中位数 / p90、按事件与结论的计费合计。
- `replay.py`：§1.3 / §1.4 的两张表。计费口径 = 每个 job `ceil(秒/60)`，skipped 计 0，按 `(run, name, started_at, completed_at)` 去重。
- `ci-cost.py`：合入后的 7 日真实成本复核；默认经 `GET /actions/workflows/ci.yml/runs` 与每个 run 的 `/jobs?filter=all` 拉数，也可读本目录 TSV 重放同一口径。输出 run 数、计费分钟、tier 占比、每个 PR 头 / 每次全量 / 每个 QA 会话成本与全量次数 ÷ 合入 PR 数。

复跑：`python3 paths.py && python3 replay.py`（在本目录）。抓取原始数据的 `gh api` 命令见 plan.md §1.3。

成本基线复核（2026-09-16）：

```bash
./ci-cost.py --from 2026-09-16 --to 2026-09-16 \
  --runs-tsv runs-0916.tsv --jobs-tsv jobs-0916.tsv \
  --merged-prs 14 --qa-sessions 15 --baseline-minutes 10936
```

打开 `CI_SCOPED_MODE` 7 天后，Lead 在仓库根目录运行：

```bash
engineering/doc/FLY-2681-ci-on-demand-matrix/data/ci-cost.py \
  --from YYYY-MM-DD --to YYYY-MM-DD \
  --qa-sessions <同期 QA 会话数> --baseline-minutes <同等天数基线分钟>
```

同期 QA 会话数仍按 plan.md §5 的只读 SQLite 查询人工填入；脚本不会读取生产数据库。
