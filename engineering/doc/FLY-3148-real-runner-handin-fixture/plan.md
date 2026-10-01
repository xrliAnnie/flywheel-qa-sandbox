# FLY-3148 真 Runner 交卷夹具 — 实施计划
Issue: FLY-3148 (https://linear.app/geoforge3d/issue/FLY-3148/qa-sbx-fly-3038-real-runner-handin-fixture-529-generalized-real-drill)
日期: 2026-10-01
基于: research.md

## 目标

- 在 `qa-fly-3038/runs/202610010731-f45ed7/` 下新建 `probe.txt`，内容恰为 `PROBE-1\n`。
- 按仓库规则把它登记进 `qa-fly-3038/probes.txt`。
- 交卷头（handed-in head）上的 `node qa-fly-3038/pre-handin-check.mjs` 通过（exit 0）。

## 非目标

- 不改 `qa-fly-3038/` 下已有的夹具脚本和 README，也不改 `.flywheel/config.yaml`、`CLAUDE.md` 和任何 `packages/` 代码。
- 不合并 PR，也不申请 ship。

## 步骤

```mermaid
graph LR
  R[RED: 写 probe 不登记<br/>守卫 fail] --> G[GREEN: 登记<br/>守卫 pass]
  G --> C[commit probe+registry]
  C --> V[pre-handin 本地自检]
  V --> CR[Codex code review]
  CR --> M[milestone 最后一个 commit]
  M --> P[push + PR→main]
  P --> F[冻结头 pre-handin + ci-full ensure]
  F --> D[complete --route needs_review]
```

1. **RED**：先写 `printf 'PROBE-1\n' > qa-fly-3038/runs/202610010731-f45ed7/probe.txt`，暂不登记。跑 `node --test qa-fly-3038/probe-registry.test.mjs`，预期 fail，消息为 `register in qa-fly-3038/probes.txt: qa-fly-3038/runs/202610010731-f45ed7/probe.txt`。
2. **GREEN**：在 `qa-fly-3038/probes.txt` 末尾追加一行 `qa-fly-3038/runs/202610010731-f45ed7/probe.txt`，保留原有的 `#` 注释行。重跑同一个测试，预期 1/1 pass。
3. **验收断言**：
   - `od -c` 输出恰为 `P R O B E - 1 \n`；
   - `wc -l` 为 1；
   - `grep -cxF 'qa-fly-3038/runs/202610010731-f45ed7/probe.txt' qa-fly-3038/probes.txt` 为 1；
   - `git diff origin/main --stat -- qa-fly-3038` 只有这两个文件变化，夹具脚本和 README 的哈希不变。
4. **commit**：把 probe 和登记放在同一个 commit 里：`test(FLY-3148): add PROBE-1 drill probe and register it`。这样任何中间头都满足守卫。
5. **本地 pre-handin**：工作树干净时跑 `node qa-fly-3038/pre-handin-check.mjs`，预期 exit 0，stdout 是一个 `status: "passed"` 的 `pre-handin/v1` JSON。
6. **评审**：用 `codex:rescue`（带 `--model gpt-5.6-sol --effort xhigh` 和策略块）做代码评审。每轮之后跑 `review-round code`；拿到 APPROVED 后跑 `codex-review-result --pr-head`。
7. **milestone**：`engineering/doc/milestones/FLY-3148.md` 作为最后一个 commit，内容包括交付范围、验证证据（本地定向测试和精确头 CI 分开写）、交接边界。progress 账本的 5/5 排在 milestone 之前。
8. **PR**：push `project-slot-2-FLY-3148`，对 `main` 开 PR，body 里链接 Linear issue，并写明 Never merge（README 的约定）。
9. **冻结头**：再跑一次 pre-handin，然后 `ci-full ensure --pr <N> --head $(git rev-parse HEAD) --json`。exit 8 时 park 等待；exit 1 时修复。exit 0 后跑 `complete --route needs_review --pr <N>`。

## 风险与应对

- **main 在交卷前前进**：pre-handin 的合并检查会给出提示。按提示合并 `origin/main`（技术同步，不需要 ship 授权），然后重新冻结。
- **精确头 CI 碰上与本 diff 无关的抖动**：先带证据 ask Lead，再只重跑失败的 job，不改 head。
- **评审要求改动**：改完重新提交，milestone 仍保持为最后一个 commit。
