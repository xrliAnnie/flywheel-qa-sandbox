# FLY-889 CI job 超时贴边缓解 — 实施计划

Version: v1.63.1（当前 `doc/VERSION` 为 v1.55.0，实际以合并时最新版本号为准，Implement 阶段核实后自行调整文件名/版本注记不影响本计划内容）
Issue: FLY-889 (https://linear.app/geoforge3d/issue/FLY-889/infraci-ci-job-贴近-10-分钟超时上限-50percent-run-timeout-cancelfleet-wide)
日期: 2026-07-05
基于: `exploration.md`, `research.md`
Status: codex-approved（Round 1 APPROVED，见文末）

## 范围

**只改 `.github/workflows/ci.yml` 一个文件，不碰任何业务代码、不改任何测试逻辑。**

本计划落地 brainstorm 阶段与 Tadashi 对齐的 A + C 两项：

- **A**：`timeout-minutes` 从 10 提到 20。
- **C**：把 3 处独立的 `sudo apt-get update && sudo apt-get install -y <pkg>`（tmux / lsof / sqlite3）合并成 1 处。

**明确排除（不在本 PR 范围内，仅记录 follow-up）**：

- **B（job 拆分并行）**：把 `teamlead` 测试（349 个文件，占 Test step 68% 耗时）拆成独立 job、其余包+hermetic 脚本测试合并另一 job。Tadashi 决定另开 follow-up（FLY-889 phase-2 或新 issue），因为它涉及 job 间共享 build 产物/artifact 上传下载/job 依赖，需要自己反复验证绿，不能拖住这次止血 PR。**Codex design review 已顺手核实**：`git log -- .github/workflows/ci.yml` 显示这个 workflow 从创建至今一直是单一 `build-and-test` job，历次 commit 只是逐步追加 FLY-110/183/519/513/697 等测试 step，没有拆分-合并的历史包袱。执行 B 时仍需自行确认 GitHub Actions 对本仓库并发 job 是否有额度限制。
- **D（`concurrency: cancel-in-progress` race）**：FLY-871 已认领，root cause 不同，不动。

## 改动 1（A）——超时阈值

```yaml
jobs:
  build-and-test:
    name: Build & Test
    runs-on: ubuntu-latest
    timeout-minutes: 20   # was: 10 — see FLY-889: suite runs ~750s (Test step alone
                           # is 446-467s, dominated by the teamlead package's 349
                           # test files sitting last in the pnpm workspace topo
                           # order); 10min gave near-zero headroom and ~half of
                           # non-superseded runs hit the wall and got force-cancelled
                           # (not a test failure — masks real failures, see FLY-882).
                           # 20min gives ~60%+ headroom without needing to shave the
                           # suite itself (that's FLY-889-B, a separate follow-up).
    steps:
      - uses: actions/checkout@v4
      ...
```

只改这一行数值 + 加注释说明 why（不是随手拍的数字，避免下一个人看到"10→20"又想凭感觉往上调或往下调）。

## 改动 2（C)——合并 3 处 apt-get

**现状**（3 处分散，每处都重新 `apt-get update`）：

```yaml
      - name: Install tmux for cmux-sync hook integration test
        run: sudo apt-get update && sudo apt-get install -y tmux
      - name: Integration test — cmux-sync hooks
        run: bash scripts/test-cmux-sync-hooks-integration.sh

      - name: Install lsof for adapter-reap test
        run: sudo apt-get update && sudo apt-get install -y lsof
      - name: Test — Discord adapter orphan reaper (FLY-183)
        run: bash packages/teamlead/scripts/__tests__/adapter-reap.test.sh

      - name: Test — FLY-519 fleet provisioning + zero-secret gate
        run: |
          bash scripts/__tests__/fleet-sanitize.test.sh
          ...

      - name: Test — FLY-513 global-codex repoint apply-path
        run: bash packages/teamlead/scripts/__tests__/fly-513-repoint.test.sh

      - name: Install sqlite3 for codex-log-guard test
        run: sudo apt-get update && sudo apt-get install -y sqlite3
      - name: Test — FLY-697 codex-log-guard
        run: bash scripts/__tests__/codex-log-guard.test.sh
```

**改为**（在 `Test` step 之后、第一个需要这些工具的测试之前，插入唯一一处合并安装；删除另外两处 `Install X` step，其余 step 顺序、内容一律不动）：

```yaml
      # FLY-889: tmux/lsof/sqlite3 are each needed by a later hermetic test
      # step (cmux-sync / FLY-183 orphan-reaper / FLY-697 codex-log-guard).
      # Installing all three here in one apt-get avoids repeating
      # `apt-get update` three times for the same effect.
      - name: Install tmux/lsof/sqlite3 for hermetic test scripts
        run: sudo apt-get update && sudo apt-get install -y tmux lsof sqlite3

      - name: Integration test — cmux-sync hooks
        run: bash scripts/test-cmux-sync-hooks-integration.sh

      - name: Test — Discord adapter orphan reaper (FLY-183)
        run: bash packages/teamlead/scripts/__tests__/adapter-reap.test.sh

      - name: Test — FLY-519 fleet provisioning + zero-secret gate
        run: |
          bash scripts/__tests__/fleet-sanitize.test.sh
          bash scripts/__tests__/fleet-capture.test.sh
          bash scripts/__tests__/provision-fleet-host.test.sh
          bash -c 'source scripts/lib/fleet-sanitize.sh; scan_for_secrets fleet/'

      - name: Test — FLY-513 global-codex repoint apply-path
        run: bash packages/teamlead/scripts/__tests__/fly-513-repoint.test.sh

      - name: Test — FLY-697 codex-log-guard
        run: bash scripts/__tests__/codex-log-guard.test.sh
```

**注释归属要求（Codex round 1 review 指出的实现细节，非阻塞但必须照做）**：原文件里 FLY-110 注释描述的是 cmux-sync 集成测试本身（不是"装 tmux"这件事），FLY-183/FLY-519/FLY-513/FLY-697 同理——每段注释解释的是紧跟在它下面的**测试** step，不是安装 step。所以插入新的合并安装 step 时：

1. 新增的 "FLY-889: tmux/lsof/sqlite3 are each needed by..." 注释 + `Install tmux/lsof/sqlite3 for hermetic test scripts` step，放在 `Test` step 结束之后、`Integration test — cmux-sync hooks` 之前（即取代原来 "Install tmux" 那个位置）。
2. 原本的 FLY-110 注释（如果原文件里在 "Install tmux" 之上而非 "Integration test" 之上，需要确认实际位置）必须继续贴在 `Integration test — cmux-sync hooks` step 正上方,不要跟着旧的 "Install tmux" step 一起被顶掉或误删。
3. 同理，FLY-183 注释贴在 `Test — Discord adapter orphan reaper` 上方，FLY-519 注释（如有）贴在对应 fleet 测试上方，FLY-513/FLY-697 同理。
4. 简言之：删除的只是 3 个 "Install X" step 里的 2 个（lsof/sqlite3 那两个，连同其上方如果专门描述"装什么工具"的注释一起删）,以及新增 1 个合并 step；**所有描述"这个测试在验证什么"的 FLY-XXX 注释都不动位置**，原样留在各自测试 step 上方。

## 不改动的部分（显式列出，防止 Implement 顺手清理）

- `permissions: contents: read`——FLY-350 安全考量，不动。
- `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`——FLY-871 的 root cause，不动。
- `Test` step 本身（`pnpm test:packages:run`）——不拆、不改并发参数，B 的范围。
- 其余所有 step 的顺序、命令、注释——原样保留。

## 测试计划

这是纯 CI workflow 配置改动，没有"单元测试"可跑；验证方式 = **真实触发一次 CI run 并观察**：

- [ ] 推送本分支后触发一次真实 GitHub Actions run，确认：
  - **不要故意制造 20 分钟超时来"验证"这个数字**（`gh run view --json jobs` 不会直接暴露 `timeout-minutes` 配置值，只能看到 job 的 startedAt/completedAt/conclusion）。实际验证方式是看 `.github/workflows/ci.yml` 的 diff 里这一行确实改成了 20，加上这次 run 本身正常跑完、没有落在旧的 10 分钟危险区被 cancel，两者合起来就是证据。
  - 新合并的 "Install tmux/lsof/sqlite3 for hermetic test scripts" step 成功安装三个工具且只出现一次 `apt-get update`。
  - 原本依赖这三个工具的三个测试 step（cmux-sync 集成测试 / FLY-183 orphan-reaper / FLY-697 codex-log-guard）均正常通过（工具确实装上了，没有因为合并安装漏掉某个包）。
  - 整个 job 总耗时与 `research.md` 里的基线（~750s）一致或更短（apt-get 合并省下 ~15-20s），且不再贴着任何超时线。
- [ ] 用 `git diff` 确认改动只涉及 `.github/workflows/ci.yml`，没有误改其他文件。
- 不需要新增/修改任何 `*.test.ts`——这个 issue 的 root cause 不是测试逻辑错误。

## 风险评估

- **风险等级：低**。改动范围严格限定在 CI workflow 的两个数值/结构性调整，不触碰任何运行时业务代码路径，理论上不可能引入生产行为回归。
- 唯一需要小心的地方：合并 apt-get 安装的**位置**必须在三个消费者 step 之前（当前计划放在 Test step 之后、cmux-sync 集成测试之前，是三个消费者里最早的一个，满足要求）。
- `timeout-minutes: 20` 的副作用：如果未来测试套件本身出现真实死循环/挂起 bug，会比现在多等 10 分钟才被杀掉。可接受——比起"每次真 bug 都被 timeout-cancel 掩盖、需要人工 retry 才能发现"的现状，这个 trade-off 明显更好；且 B 方案（job 拆分）落地后总耗时会显著下降，届时可以重新评估是否需要收紧这个数字。

## Design Review

**Round 1: APPROVED**（2026-07-05,effort xhigh）。Codex 核实了当前 `.github/workflows/ci.yml` 的实际内容与本计划描述一致（单 job、`timeout-minutes: 10`、3 处独立 apt-get、`permissions`/`concurrency` 块），确认 A+C 的 scope 收窄合理，B/D 排除理由成立。提出 3 条非阻塞建议，均已采纳并体现在上文（注释归属要求、B follow-up 补充了"经 git log 核实无拆合历史"、测试计划去掉了"故意触发超时验证"的误导表述）。完整 review 记录见 `/tmp/codex-rescue-design-feedback-flywheel-FLY-889-ci-job-timeout-mitigation-round1.md`。

Verdict: **APPROVED — ready to implement**。
