# FLY-2134 监控者的监控 — 验收
Issue: FLY-2134 (https://linear.app/geoforge3d/issue/FLY-2134/infra观测-没有人监控这些监控者4-例自动机制静默失效-2-5-个月无一发出声音-其中全舰-12-个-lead-的-1043)
日期: 2026-09-08
基于: plan.md

## 当前结论

Phase A 的实现和本地隔离行为验证已完成;生产部署、exact-head CI、部署后
24 小时连续证据和 Phase B(schema 3 producer)尚未发生。本文只把已有证据记为
PASS,不把「代码已写」替代为「生产看者已产出」。

本阶段交付:

- 五行期望产出物登记表和三种只读探针,只按文件、SQLite 行或 Git 远端事实判活。
- 两本独立 episode 账(`incident` / `unobservable`)、追加台账和整轮 receipt。
- repo-owned launchd `copy` 单元及审计退役路径。
- Bridge schema 2 可选 W-4 producer、完整 fail-closed receipt reader、TS/jq 等价
  validator,以及 probe 既有 degraded episode 的 W-4 consumer。
- required CI 中三条新 shell suite 的精确串行登记。

## 阶段一隔离证据

| 面 | 命令/夹具 | 当前结果 |
| --- | --- | --- |
| 登记表 | `artifact-freshness-manifest.test.sh` | PASS:生产表 5 行;坏 kind、重复 id、列数、路径、SQLite identifier、无裁定 suspended 全拒绝 |
| 探针与账本 | `artifact-freshness-check.test.sh` | PASS:file/sqlite/git 真值表、两本 episode、锁、sink 预检、崩溃窗口、receipt 绑定 |
| W-4 接收端 | `bridge-liveness-probe-w4.test.sh` | PASS:31 项;schema 2 兼容、schema 3 强制、逐字段 fail-closed、第三轮页、恢复清账 |
| 真实 producer 交叉 | `bridge-liveness-probe.test.sh` | PASS:31 项;临时真 receipt → `buildLivenessManifest` → probe 得到 W-4 `fresh/ok` |
| TS 契约 | TeamLead liveness manifest + Config truth Vitest | PASS:9 + 38;reader 全拒绝分支、180 分钟边界、生产 wiring、schema 2/3 契约 |
| launchd 合同 | FLY-1814 manifest/census/convergence suites + retire suite | PASS:第三 label 退役全矩阵,plist 与 `copy` authority 闭合 |
| CI 权威 | `ci-structure.test.sh` + `ci-shell-suite-enumeration.test.sh` | PASS:三条命令顺序锁定;292 shell suites 全分类(238 CI / 55 manual-only) |

已验证的实现提交:

- `a63a99836`:登记表、解析器和三种只读探针。
- `3326f0b61`:两本 episode、台账和整轮 receipt。
- `409692df3`:launchd 单元、convergence 与审计退役 authority。
- `395e7a793`:Bridge W-4 producer、reader 与 truth validator。
- `cffc507ba`:probe W-4 consumer 与真 producer 交叉测试。
- `83ec806ae`:required CI 登记和结构守卫。
- `4612ec042`:运维顺序、Phase A 本地证据与 Phase B 开门条件。

## 合并前本地门禁

- `pnpm lint`:exit 0;14 条 warning 均为仓库既有路径,FLY-2134 改动文件无新增
  lint error。
- `pnpm -r build`:exit 0;22/22 workspace targets 通过。
- 三个新增 shell suite 在最新实现头原样串行通过:`artifact-freshness-manifest`,
  `artifact-freshness-check`,`bridge-liveness-probe-w4`(后者 31/31)。
- `pnpm test:packages:run` 原样执行三次,aggregate **尚未绿色**;每次失败均落在
  相对 `origin/main` 零 diff 的短时限测试,且失败集合不重复:
  1. Claude runner 的 1ms helper deadline 断言在全包负载下得到
     `deadline_exhausted`;该断言隔离 PASS,整个 `TmuxAdapter.test.ts` 170/170 PASS。
  2. `flywheel-comm` 的 25ms mailbox compaction budget 用例在全包负载下返回 0;
     该断言隔离 PASS,整个文件 17/17 PASS。
  3. Claude runner 的 500ms stdin 子进程和 5s real-tmux 五连发超时,同时 Vitest
     报 `Timeout calling onTaskUpdate`;两文件随后同一命令隔离 9/9 PASS。
- 因此不能把 focused PASS 冒充 full aggregate green。PR exact-head CI 将作为新的
  aggregate 裁决;若仍红,必须按其精确失败处理,不能以本段豁免。

## 合并前剩余门

- exact-head cross-family code review 与 GitHub CI。
- 工作树最终必须为空;里程碑文件必须是 PR 的 literal last commit。

## Phase A 部署后证据模板

以下项目由有部署权限的后续节点填写;当前均为 `pending`,不由 implementation
节点触碰生产 launchd、Bridge 或 Discord。

| 判据 | 状态 | 要粘贴的证据 |
| --- | --- | --- |
| 生产表通过 | pending | `bash scripts/artifact-freshness-check.sh --validate` 的 `rows=5 sha256=<x>` 与 exit 0 |
| 首轮产出物判词 | pending | `--status` 五行;以当日实况确认 2 stale + 1 missing + 2 fresh,差异必须解释 |
| 看者自身产出 | pending | `checks.tsv` 末 5 行同一 `run_id`;`last-run.json` 的 registry sha/counts/run_status |
| Bridge W-4 | pending | `/health` 中 `{freshness:"fresh",run_status:"ok"}` |
| 预期阳性送达 | pending | `#flywheel-alerts` 三条 incident enter:token usage、chezmoi remote、runner memory remote |
| probe 自身健康 | pending | probe state 无 degraded episode;`lastOkTs` 晚于已部署 probe 脚本 mtime至少一个 60s 周期 |
| 连续 24h | pending | `checks.tsv` 每小时新增 5 行;W-4 连续 `fresh/ok`;probe 无 degraded |

阴性对照只复制生产登记表到临时文件,把副本中的
`bridge-liveness-probe-state.max_age_h` 改为 `0.01`,用
`--registry <副本> --status` 读到 `stale`,记录副本 sha256 后删除。不得编辑生产
权威表,不得把此只读 shadow 说成真实告警送达。

## Phase B 开门条件

只有上一节连续 24h 证据齐全后才可在同一 issue 开第二个 PR:

1. 主 checkout 的实际 `bridge-liveness-probe.sh` 能接受合成 schema 3 + 完整
   W-4,删除 W-4 后拒绝;记录 checkout exact HEAD 与脚本 sha256。
2. probe 状态 `lastOkTs` 晚于该脚本 mtime 至少一个 60 秒周期,证明新 consumer
   真运行过,而不是只看仓内源码。
3. probe degraded 账为空,W-4 已连续 24h `fresh/ok`。

满足后 Phase B 才把 Bridge producer 升到 schema 3 并将 W-4 变为必有行。
Phase A 的“可选”不是完成态;FLY-2134 的 DoD 包含 Phase B 合并和部署。

## 诚实边界

- 三方环仍在同一台机器和同一 launchd 域,只做到进程级不同故障域;整机级副本
  与外部看者不在本单。
- 首轮三条 alert 是预期阳性,本单只让静默机制出声,不修 token usage、chezmoi
  或 runner-memory 远端。
- Discord 全挂时 watcher 与 probe 都投递失败;receipt `degraded` 只能等 Discord
  恢复后由 probe 补页。
- schema 2 下 W-4 缺失或 `not_started` 在 Phase A 故意静默,因此 post-merge
  checklist 和 Phase B 硬门不可省略。
