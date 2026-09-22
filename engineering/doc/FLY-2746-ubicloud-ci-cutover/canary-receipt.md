# FLY-2746 CI 切换 Ubicloud — Canary 回执
Issue: FLY-2746 (https://linear.app/geoforge3d/issue/FLY-2746/ci切-ubicloud-ciyml-全部-job-从-ubuntu-latest-切到-ubicloudrepo-变量一键切换回滚先跑一次)
日期: 2026-09-18
基于: plan.md

## Run 1：main 基线与真实 runner 取证

- Run ID: `35393797039`
- URL: https://github.com/xrliAnnie/flywheel/actions/runs/35393797039
- Event: `workflow_dispatch`
- Head SHA: `bd2fc7dfe5ebabe281d4125c2114d382f7b1f7f0`
- 输入: `runner=ubicloud-standard-2`, `capacity=0`
- 时间: `2026-09-18T20:52:30Z` – `2026-09-18T21:08:51Z`
- Workflow conclusion: `failure`

| Job | Job ID | Runner | Labels | Conclusion | 时间 (UTC) |
| --- | ---: | --- | --- | --- | --- |
| Preflight | `105757881557` | `GitHub Actions 1000078251` | `ubuntu-latest` | success | 20:52:34–20:52:38 |
| Quick Gate | `105757913834` | `greg3z56y76e7kxv1mt9fzvmfj` | `ubicloud-standard-2` | **success** | 20:52:56–20:56:50 |
| Unit (teamlead 1 of 4) | `105757913856` | `grvnm63xs7dt4q5q9e8dfnw2cc` | `ubicloud-standard-2` | failure | 20:52:57–21:03:30 |
| Isolation Writer | `105757913857` | `gr3et3k4y7k27ked25gjcpmves` | `ubicloud-standard-2` | success | 20:52:56–20:53:01 |
| Script 2 | `105757913969` | `gr7rym3p7d3a5k6hd5z02fycnz` | `ubicloud-standard-2` | success | 20:52:57–21:08:44 |
| Capacity | `105757914816` | 未分配（`capacity=0`） | `ubicloud-standard-2` | skipped | — |
| Isolation Reader | `105758028299` | `gr3mzkz77xap3gk3kjngxb2pry` | `ubicloud-standard-2` | success | 20:53:09–20:53:14 |

Quick Gate、Script 2 和隔离验证均由真实 `ubicloud-standard-2` runner 接走并成功，证明 Ubicloud runner 可以执行本仓 checkout、install、build、lint、typecheck、root tests 和 shell tests。

Unit 的唯一失败为既有 `packages/teamlead/src/bridge/__tests__/fly2662-predeploy-replay.test.ts`：期望 `{ started: 1, held: 0 }`，实际 `{ started: 0, held: 1 }`。同一断言在本地当前 main 上以精确命令稳定复现；FLY-2746 未修改 teamlead 代码或该测试。Lead 确认 FLY-2702 已在随后合入 main，要求同步后重跑 canary。

## Run 2：最新 main 全绿

- Run ID: `35395475216`
- URL: https://github.com/xrliAnnie/flywheel/actions/runs/35395475216
- Event: `workflow_dispatch`
- Head SHA: `73edeb188127b4d86aa7190fed8188c7d39e4505`
- 输入: `runner=ubicloud-standard-2`, `capacity=0`
- 时间: `2026-09-18T21:11:26Z` – `2026-09-18T21:33:36Z`
- Workflow conclusion: **success**

| Job | Job ID | Runner | Labels | Conclusion | 时间 (UTC) |
| --- | ---: | --- | --- | --- | --- |
| Preflight | `105763206443` | `GitHub Actions 1000078316` | `ubuntu-latest` | success | 21:13:39–21:13:42 |
| Isolation Writer | `105763821352` | `grrpkkmgv46a2ntacajxfn6487` | `ubicloud-standard-2` | success | 21:14:00–21:14:05 |
| Unit (teamlead 1 of 4) | `105763821357` | `grdh4c4d34hy2hhdns4fg15825` | `ubicloud-standard-2` | success | 21:14:00–21:25:57 |
| Quick Gate | `105763821476` | `grv1p8pfjrge6nycxbkkgnhncp` | `ubicloud-standard-2` | success | 21:14:00–21:17:41 |
| Script 2 | `105763821480` | `gr4bbef5yh4a2pk3dfb7c9r3fs` | `ubicloud-standard-2` | success | 21:14:04–21:30:15 |
| Capacity | `105763822679` | 未分配（`capacity=0`） | `ubicloud-standard-2` | skipped | — |
| Isolation Reader | `105763930743` | `grccdx82fefa0q3n6mwj3cm889` | `ubicloud-standard-2` | success | 21:14:12–21:14:18 |
| Canary Result | `105768304581` | `GitHub Actions 1000078402` | `ubuntu-latest` | success | 21:33:31–21:33:35 |

Preflight 与 Canary Result 是 canary 自身的可信控制面，按设计固定使用 GitHub-hosted runner；所有实际 payload job 均请求 `ubicloud-standard-2`。除因 `capacity=0` 而按设计跳过的 Capacity 外，全部 payload job 都分配到名为 `gr…` 的 Ubicloud runner 并成功，Quick Gate 为绿。

## 限制：canary payload 与现网 `ci.yml` 的漂移

按 `scripts/ci-ubicloud/README.md` 的要求，canary 跑的是冻结在
`scripts/ci-ubicloud/fixtures/ci-source.yml` 的历史 `ci.yml`（`f0175458`），不是现网文件。
以 2026-09-21 的合并头（含 FLY-2755 六分片）用同一 YAML 解析器实测：

| 对比项 | 冻结 fixture | 现网 `ci.yml` |
| --- | ---: | ---: |
| job 数 | 10 | 11（多出 `script-tests-6`） |
| `quick-gate` 步数 | 24 | 24 |
| `unit-tests` 步数 | 11 | 11 |
| `script-tests-2` 步数 | 45 | 25 |
| `script-tests-2` 仅一侧存在的步骤 | 31（仅 fixture） | 11（仅现网） |

因此 canary 的「Script 2 971s」只代表旧的 5 分片布局在 Ubicloud 上的用时，
不能直接当成六分片布局的余量证据。六分片布局在 Ubicloud 上的实测用时见下节
「exact-head CI 回执」，以那一节为准。canary 证明的是 Ubicloud runner 能跑本仓的
checkout / install / build / lint / typecheck / root tests / shell tests 这一类工作负载，
不是对任何一个具体分片时长的承诺。

## exact-head CI 回执（PR #1271，head `407110cdc`，`CI_RUNNER=ubicloud-standard-2`）

- Run ID: `35572539036`（attempt 1）
- URL: https://github.com/xrliAnnie/flywheel/actions/runs/35572539036
- Event: `pull_request`
- 时间: `2026-09-21T07:21:00Z` – `2026-09-21T07:36:37Z`
- Workflow conclusion: `failure`（17 个 job 中 16 个成功；`Script Tests 6/6` 红，`CI OK` 因它红）

| Job | Job ID | Runner | Labels | Conclusion | 时间 (UTC) | 用时 (s) |
| --- | ---: | --- | --- | --- | --- | ---: |
| Classify CI scope | `106247248543` | `grz07n4zrsse5pvtq3g2wczsga` | `ubicloud-standard-2` | success | 07:21:58–07:22:24 | 26 |
| Quick Gate (build + typecheck + lint) | `106247248362` | `gr9w29fkv5fe3prr4e400rm5ne` | `ubicloud-standard-2` | success | 07:21:56–07:27:35 | 339 |
| Unit (teamlead 1 of 4) | `106247393916` | `gra3f73sdh667nk10t0an6s9sb` | `ubicloud-standard-2` | success | 07:22:32–07:32:35 | 603 |
| Unit (teamlead 2 of 4) | `106247393974` | `grht5mm3ze424g6kegcqhnxxgy` | `ubicloud-standard-2` | success | 07:22:32–07:36:19 | 827 |
| Unit (teamlead 3 of 4) | `106247394010` | `gr6ycjpnd31a3gqt7a9yvq55sh` | `ubicloud-standard-2` | success | 07:22:33–07:33:35 | 662 |
| Unit (teamlead 4 of 4) | `106247393940` | `grcanemd6vb65h56g55twpz82z` | `ubicloud-standard-2` | success | 07:22:32–07:32:24 | 592 |
| Unit (observation performance) | `106247393947` | `gr9w01se82ee0qc5864mcrpn8n` | `ubicloud-standard-2` | success | 07:22:32–07:25:56 | 204 |
| Unit (heavy) | `106247394004` | `grwc216z339p2gfrybd9ya479p` | `ubicloud-standard-2` | success | 07:22:33–07:31:49 | 556 |
| Unit (light) | `106247394013` | `grj9edwza5gj4k2c4t8knk5ynb` | `ubicloud-standard-2` | success | 07:22:33–07:25:44 | 191 |
| Script Tests 1/6 | `106247394061` | `gr0v0spf48za1nw6x48qj54kx5` | `ubicloud-standard-2` | success | 07:22:33–07:32:42 | 609 |
| Script Tests 2/6 | `106247393906` | `grt001n4jyba7p7e73tw16r4hm` | `ubicloud-standard-2` | success | 07:22:32–07:32:03 | 571 |
| Script Tests 3/6 | `106247393698` | `grer08e7x2py0kf0a8bgg76f36` | `ubicloud-standard-2` | success | 07:22:32–07:35:26 | 774 |
| Script Tests 4/6 | `106247393962` | `gr5mttrgtvea2pecaxxqx3cmf5` | `ubicloud-standard-2` | success | 07:22:33–07:35:50 | 797 |
| Script Tests 5/6 | `106247393708` | `grq067emrjzt3q2w114fq4q0hy` | `ubicloud-standard-2` | success | 07:22:32–07:32:43 | 611 |
| Script Tests 6/6 | `106247393897` | `gra4x3tebrwy1m7gnq2my1yw7w` | `ubicloud-standard-2` | **failure** | 07:22:32–07:32:55 | 623 |
| NPM payload distribution | `106247393891` | `grprrp1wnd3a6pb4713dz4kkhj` | `ubicloud-standard-2` | success | 07:22:32–07:25:25 | 173 |
| CI OK | `106250810187` | `gr26ms9vwjfa1pse9htw087gk1` | `ubicloud-standard-2` | failure（仅因 6/6） | 07:36:28–07:36:36 | 8 |

全部 17 个 job 的 `runner_name` 都是 `gr…` 形式的 Ubicloud runner，labels 全为 `ubicloud-standard-2`；
没有任何 job 落回 GitHub-hosted runner。六分片布局下最长的分片是 Script Tests 4/6（797s），
最长的 job 是 Unit (teamlead 2 of 4)（827s），均在 FLY-1870 的 1020s 预算之内
（tripwire 自报 Script Tests 6/6 `elapsed=614s budget=1020s usage=51%`）。

### Script Tests 6/6 红点分析

红点在步骤「Test — FLY-1726 canonical Lead identity delivery」里的
`scripts/__tests__/fly1697-v2-lease-body.test.sh`（18 个用例中 2 个失败：
`real lead-body entry did not launch its Claude child` 与
`degraded store prevented the one-shot body from launching`），本 PR 未触碰该测试及其被测脚本。

- 该测试的 `start_body` 只轮询 200 × 0.05s ≈ 10s 等 Claude 子进程写出 env 文件；而 `claude-lead.sh`
  在真正拉起子进程前要跑完 Discord state → Playwright 判定 → flywheel-bin 收敛 → launchd 普查 →
  规则拼装 → 上下文恢复门 → bootstrap curl（对不存在的 Bridge 必失败，随后固定 `interruptible_sleep 3`）。
- 同一步骤「pre-materialize → live v2 body」的耗时：QA1 Ubicloud（09-19，run `35424774620`）8.6s 过；
  GitHub-hosted main `58078bfee`（run `35554025391`）8.7s 过；GitHub-hosted main `e82193650`
  （run `35570340588`）**10.0s 过（贴线）**；本次 Ubicloud 10.5s 失败。
- 本地 macOS 同一脚本 18/18 通过。结论：这是一条在 main 上已经贴着 10s 预算的启动时序测试，
  Ubicloud standard-2 的单核启动链比 GitHub-hosted 慢约 1s 就越线；它不是 Ubicloud 缺工具或镜像差异，
  也不是 runner 变量化引入的。Lead 于 2026-09-21 裁定：只把该测试 `start_body` 的轮询上限 200→600（≈30s），不动任何断言与被测脚本；本 PR 不通过跳过或弱化断言来凑绿。修正后的同头新 run 见 PR。

## 清理与未激活证明

Run 2 终态后已 fail-loud 删除 `UBICLOUD_CANARY_PROBE` secret 与 `UBICLOUD_CANARY_AUTHORIZED` variable。2026-09-19 再次读取 repository Actions variables/secrets 列表，三者 `UBICLOUD_CANARY_PROBE`、`UBICLOUD_CANARY_AUTHORIZED`、`CI_RUNNER` 均不存在。实现阶段没有提前激活生产 runner 切换；文档不包含 probe secret 值。

合入后的激活与回滚演练不属于本实现节点。`CI_RUNNER=ubicloud-standard-2` 已由 QA 于 2026-09-19T05:44Z 设置；后继仍须保存第一张真实 PR 全部 job 的 `runner_name` 与绿色 CI，随后删除 `CI_RUNNER`，再保存下一次 run 回到 `ubuntu-latest` 的 run ID。`SHIP_RUNNER` 在本回执写就时不存在，ship 路径仍在 `ubuntu-latest`。
