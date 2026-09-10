# FLY-2456 原证据重放 — 返工 #6
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456)
日期: 2026-09-10
基于: ../plan.md; ../host-runs/; replay-receipt.json

本目录是同一次宿主演练的重算产物，不是新一轮演练。原 76 份 host-runs 文件与 Lead 原件保持不变。当前摘要见上级 drill-report.md / founder-report.html；host-runs/r2/drill-report.md / founder-report.html 保留为旧工具计算的历史报告。

原 observation 派生输入：

- R1 final-observe.evidence.json：`6542fcf5155e5e4ec556b713306400fdacb1870b802c65c491738ec2f6b4fc92`。
- R2 final-observe.evidence.json：`bfb754b70810eb2fd62056c0dc63e6759b347502ee1e251f4be71668c708bf77`。

`replay-receipt.json` 记录原始及新 observation hash、原输入证据 hash、逐体标签差、事件原因和 verdict 差。重放断言除 classification/replacement 外的 observation 全对象逐值不变；所有 body 变化限定于 Lead 裁定 d51bd7ba / 7c465a92。

从仓库根目录复算（读取同一宿主私有证据目录，不连接真库、不调用 slot/服务命令）。先创建一个全新输出目录；下方 verdict 与 report-pair 在真实结果 FAIL 时 exit 1 是预期，必须保留 JSON 并检查 status/reason，不能把读取或 schema 错误当作有效 FAIL。两个 verdict JSON 仍有完整 evidence[]，pair 重新核验每份哈希并重跑 verdict。

```bash
SOURCE="$HOME/.flywheel/qa-evidence/FLY-2456"
REPLAY_DIR=$(mktemp -d /tmp/fly2456-replay.XXXXXX)
for round in r1 r2; do
  node scripts/qa-fly-2456-drill-tools.mjs observe \
    --db "$SOURCE/$round/final-observe.evidence.json" \
    --manifest "$SOURCE/$round/manifest.json" --step cycle-2 \
    > "$REPLAY_DIR/$round-observe.json"
  node scripts/qa-fly-2456-drill-tools.mjs verdict --round "$round" \
    --manifest "$SOURCE/$round/manifest.json" \
    --shape "$SOURCE/$round/campaign-shape.json" \
    --observe "$REPLAY_DIR/$round-observe.json" \
    --zero-impact "$SOURCE/$round/zero-impact.json" \
    --fixture "$SOURCE/$round/fixture.json" \
    > "$REPLAY_DIR/$round-verdict.json"
done
node scripts/qa-fly-2456-drill-tools.mjs report-pair \
  --r1 "$REPLAY_DIR/r1-verdict.json" --r2 "$REPLAY_DIR/r2-verdict.json" \
  > "$REPLAY_DIR/pair.json"
```

本次固定输出引用的私有 observation 是 `~/.flywheel/qa-evidence/FLY-2456/rework-6/r1-observe.json` 与 `r2-observe.json`。重新执行时输出路径不同，因此 verdict 的 evidence.path 与文件整体 SHA 会改变；比较逐体结果、原输入 SHA、失败/待归因列表及成功率，不能要求另一路径的派生 JSON 整体相同。没有把新的 observation 原始 timeline 或大型数据库投影提交到 PR。

结果：R1 `replaced / failed_exhausted_no_replacement / skipped_not_holder`；R2 `other / failed_exhausted_no_replacement / skipped_not_holder`。drift 2→0，成功率仍 0/2→0/2。生产失败与待归因项不因 body 分类修正消失。R2 B1 缺第一 episode 的 episode_exhausted 事件；不为该体扩展分类器。
