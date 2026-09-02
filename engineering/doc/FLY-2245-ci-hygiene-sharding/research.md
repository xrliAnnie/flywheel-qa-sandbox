# FLY-2245 CI 卫生与脚本分片 — 调研
Issue: FLY-2245 (https://linear.app/geoforge3d/issue/FLY-2245/ci卫生-doc-目录整体-inert-分类-script-tests-22-拆-shard9-1-容量-tripwire)
日期: 2026-09-01
基于: exploration.md

## 1. 结论

1. `engineering/doc/**` 的普通文件应按目录语义 inert，不再要求扩展名命中白名单；但必须先把 no-code-gated CI 实际消费的非白名单工件补进 `known_ci_consumed_doc_paths`。全仓 sweep 找到 5 条新增 fence；这样既覆盖 issue 点名的 `.sh/.py/.js/.json/cfg` 快照，也不把真实测试输入伪装成 inert。
2. “≤70% 预算”的分母按 Lead 2026-09-01 回复取 FLY-1870 tripwire 预算 1020s，不是 20 分钟 timeout cap；验收线为 `1020 × 70% = 714s`。三片在近期最慢样本下连平均下界都约 727s，所以必须拆成四片。
3. 低扰动四片分法：原 shard 1 只移出 FLY-1364；原 shard 2 按现有顺序连续切成两片；FLY-1364 单独成第四片。用六轮每个测试 step 的最大值和 149s 最大公共开销做保守投影，四片为 624/605/626/633s，即 tripwire 预算的 61.2%/59.3%/61.4%/62.1%。

## 2. 分类器白盒审计

### 2.1 当前规则

`scripts/ci-classify.sh` 的 embedded Python 对 merge-base 全量 diff 做 fail-closed 判断：

- 路径必须命中 `doc/`、`product/doc/`、`engineering/doc/`、`content/doc/` 之一；
- 路径必须命中扩展名白名单；
- 路径不能属于 `known_ci_consumed_doc_paths`；
- symlink(120000)、gitlink(160000)、畸形 raw diff、Git 错误都判 `no_code=false`。

因此 `engineering/doc/FLY-2241-*/measure.sh`、`reqstats.py`、`tools-list.js`、`cfg/*.json` 的唯一阻挡项是扩展名；它们不在精确机器消费清单里。

### 2.2 精确例外与新增 consumer sweep

全仓消费者 sweep 证明现有精确例外有真实测试消费方：

- `engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md` 被 `scripts/__tests__/package-onboard.test.sh` 读取；
- `engineering/doc/FLY-1648-hot-loop-closeout/runbook.md` 被 teamlead package test 读取；
- FLY-1278 artifacts 被 review governance/verdict/coordinator tests 读取；
- FLY-1135 三份文档被 `fly1135-doc-sentinel.test.ts` 读取；
- FLY-1775 plan、FLY-222/529 runbook 分别被部署/launchd shell suites读取。

`scripts/__tests__/ci-structure.test.sh` 还从真实消费者列表反推 FLY-1278/1135 fence parity，并用 mutation control 证明漏项会红。因此本单保留精确例外；“目录整体 inert”落实为**目录下其余普通文件不看扩展名**。

设计评审第一轮指出原 sweep 只覆盖已有 allowlisted fence，会把 no-code-gated CI 消费的非白名单工件漏成 inert。补做两层全仓反向扫描：

1. 从 `git ls-files engineering/doc` 取出不命中当前 26 个 suffix 的 402 条 tracked path，逐条在 `engineering/doc/**` 外搜索完整路径；
2. 对唯一的尾部二段路径（例如 `fixtures/fly-1251-rounds-6-9.json`）反搜，捕获 `docRoot + relativePath` 这类拼接消费者。

需要新增到精确 fence 的 5 条路径是：

| doc 工件 | no-code-gated 消费方 |
|---|---|
| `engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py` | `scripts/__tests__/test-fly1609-design-compare.test.sh`（Script Tests）直接执行 |
| `engineering/doc/FLY-1278-review-gate-convergence/fixtures/fly-1251-rounds-6-9.json` | review governance/verdict/coordinator package tests（unit-tests）读取 |
| `engineering/doc/FLY-2030-raya-brain-inquiry/summary-role-assignments.json` | `summary-assignment.test.ts`（unit-tests）读取 |
| `engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/capture.mjs` | `management-console-visual-regression.test.ts`（unit-tests）执行 |
| `engineering/doc/FLY-1269-codex-phase-keepalive/qa/target7-pane-identity.mjs` | `target7-pane-identity.test.ts`（unit-tests）导入 |

同一 sweep 的两条额外机器消费不需要 fence：

- `engineering/doc/FLY-1987-actions-cost-audit/data/derive-lib.mjs` 仅由 always-on `ci-structure.test.sh` 消费；
- `engineering/doc/FLY-2074-raya-voice-pipeline/evidence/discord-rounds.json` 由 always-on quick-gate 的 founder disclosure guard 消费。

它们随 doc-only PR 仍会被轻车道验证。FLY-1278 consumer parity 现有推导还用 suffix 白名单过滤 `artifactPaths`，所以会漏掉新增 JSON；实现时必须移除该过滤，让 consumer 清单和 fence 对所有扩展名保持 exact parity。

### 2.3 always-on 车道不受影响

`quick-gate` 无 `needs`/`if`，分类结果只控制 `unit-tests`、四个 Script Tests（改后）和 `payload-distribution`。FLY-2045 milestone layout guard 与 CI structure guard 已在 `quick-gate` 无条件运行；本单不移动或弱化它们。

### 2.4 新规则边界

- `engineering/doc/**` 普通文件（含 100755 脚本、无扩展名文件和任意扩展名数据）为 inert；
- 现有精确机器消费路径和上表新增 5 条路径仍非 inert；
- `doc/`、`product/doc/`、`content/doc/` 继续要求现有扩展名白名单，`doc/VERSION` 与 `product/doc/**/*.mjs` 等仍跑全套；
- 文档目录内 symlink/gitlink 仍 fail-closed；code→doc rename 在 `--no-renames` 下仍包含 code 删除路径，继续跑全套；
- 目录外任何改动或不确定状态继续 `no_code=false`。

## 3. Script Tests 真机数据

通过 GitHub Actions jobs API 读取 2026-09-01 六个已完成 run 的 job/step timestamps。单位为秒：

| run | 场景 | shard 1 | shard 2 | 结果 |
|---|---|---:|---:|---|
| [33559020400](https://github.com/xrliAnnie/flywheel/actions/runs/33559020400) | FLY-2241 PR | 1004 | 935 | success |
| [33546219860](https://github.com/xrliAnnie/flywheel/actions/runs/33546219860) | FLY-2211 PR | 935 | 1059 | shard 2 tripwire failure |
| [33536367565](https://github.com/xrliAnnie/flywheel/actions/runs/33536367565) | FLY-2211 PR | 1017 | 927 | success |
| [33455882496](https://github.com/xrliAnnie/flywheel/actions/runs/33455882496) | FLY-2204 PR | 974 | 924 | success |
| [33552649545](https://github.com/xrliAnnie/flywheel/actions/runs/33552649545) | main | 1075 | 928 | shard 1 tripwire failure |
| [33530622225](https://github.com/xrliAnnie/flywheel/actions/runs/33530622225) | main | 877 | 947 | success |

两片均明显高于 714s；不是只拆当晚报红的 shard 2 就能完成验收。六轮公共非测试开销（checkout/setup/install/build/apt/post 等）为 101–149s，中位数 114s。每次新增 shard 都会复制这段开销，所以四片增加总 runner-minutes，但显著降低 required lane 的墙钟和慢 VM 翻红风险。

六轮最慢测试 step 的范围：

| step | min–max |
|---|---:|
| FLY-1364 cmux sync repair | 372–484 |
| FLY-1434 unified restart + quota caller | 133–137 |
| FLY-1929 voucher watch | 114–117 |
| FLY-1501 restart brake | 102–106 |
| FLY-1663 launchd-native lifecycle | 93–103 |
| FLY-1814 launchd fleet | 75–100 |
| FLY-1389 path/529 repair | 81–96 |

## 4. 四片容量模型

保守计算方法：每个测试 step 取六轮最大秒数，公共开销统一取六轮最大 149s。不同 step 的最大值来自不同机器/轮次，因此这比任何单轮都更保守；最终验收仍必须用 PR CI 四片真实 elapsed，而不能把模型当真机证据。

| 新 shard | 测试 step 归属 | step 最大值和 | +149s 投影 | /1020s |
|---|---|---:|---:|---:|
| `script-tests` 1/4 | 原 shard 1，移出 FLY-1364；其余顺序不变 | 475 | 624 | 61.2% |
| `script-tests-2` 2/4 | 原 shard 2 从 FLY-1905 helper 到 FLY-1330 log janitor（含） | 456 | 605 | 59.3% |
| `script-tests-3` 3/4 | 原 shard 2 从 FLY-2139 database maintenance 到 FLY-1870 contract（含） | 477 | 626 | 61.4% |
| `script-tests-4` 4/4 | 仅 FLY-1364 cmux sync repair | 484 | 633 | 62.1% |

这一连续切分保留每个原 shard 内的相对顺序，并把最慢族分散：FLY-1364 独占 4/4；FLY-1434/1678/1986/1855 在 3/4；FLY-1501/1389 在 2/4；FLY-1929/1663/1814 在 1/4。四片 max-step-sum 为 475/456/477/484，差值仅 28s。

## 5. FLY-1870 保护语义

四片都必须原样保留：

- `timeout-minutes: 20`；
- 第一个 workflow step 写入相同 start epoch 文件；
- 完整 checkout/pnpm/node/git/install/better-sqlite3/build/apt setup 前奏；
- 最后一个 step `if: always()` 调 `ci-job-elapsed-tripwire.sh --cap-minutes 20 --threshold-pct 85`；
- 无 `--now-epoch`、无 `continue-on-error`；
- `ci-ok.needs` 和聚合 jq 同时纳入四片，docs-only 时只接受由 `no_code=true` 导致的 skipped；
- 当前 HEAD 的 76 个测试 step 恰好归属一片，命令内容不改（六轮历史 API 中另有同一步骤改名前后的两个名字，容量取大值但 inventory 只按当前 HEAD 计一次）。

## 6. 测试 seam 定稿输入

- 分类器：真实临时 Git repo + `HEAD_SHA/BASE_SHA/GITHUB_OUTPUT`，用 `.sh/.py/.js/.json/cfg/extensionless` 正例、目录外同扩展负例、全部已知机器消费路径（含新增 5 条）负例、symlink/gitlink 负例。
- workflow：解析真实 `.github/workflows/ci.yml` 的 shell structure guard 与 teamlead Vitest guard；先要求四片（RED），再复制骨架和移动完整 step（GREEN）。
- 容量：静态 guard 证明结构与语义；PR CI 四片真实 job timestamps 证明每片 ≤714s。若普通片超线，只在普通片间移动完整 named step；若仅有一个 named step 的 FLY-1364 片超线，按计划预写的命令边界拆成第五片，不调整 cap/tripwire 或 suite 内等待。

checkout 合同也显式固定：只有含 FLY-2007 历史 freeze commit 检查的 `script-tests` 需要 `fetch-depth: 0`；新 2/4、3/4、4/4 都使用默认 shallow checkout。六轮容量模型把 full-checkout shard 的 149s 最大公共开销套给所有片，仍是保守估算。
