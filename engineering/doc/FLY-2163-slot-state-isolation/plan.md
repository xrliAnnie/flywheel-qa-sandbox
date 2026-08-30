# FLY-2163 slot Bridge state 隔离 — 实施计划
Issue: FLY-2163 (https://linear.app/geoforge3d/issue/FLY-2163/529隔离漏-slot-bridge-不隔离-flywheel-state-dir测试房覆写了生产-meta-alert-文件134502)
日期: 2026-08-30
基于: research.md

## 目标与锁定范围

让 `scripts/test-deploy.sh` 启动的每一个 529 slot Bridge 都显式使用
`${SLOT_DIR}` 作为 `FLYWHEEL_STATE_DIR`（与生产 `~/.flywheel` 相同的 root 语义），并用
可执行阳性对照证明真实 state writer 的
产物只落 slot，模拟生产目录逐文件零变化。

只修改：

- `scripts/test-deploy.sh`
- `scripts/__tests__/test-deploy-generalized.test.sh`
- 本 issue 的 DOC-FLOW 文档与最终 milestone

不修改 Lead manifest 的 per-carrier state dir，不修改 state-path resolver、MetaAlertNotifier、
`meta-alert.sh`、告警目录语义、teardown 或配置 schema。不增加依赖、helper、开关或抽象。

## Consumer postcondition（锁定）

一行 env 会重定向 Bridge 进程及其 child 中所有**由 state root 解析**的读取；每条 live
consumer 的预期如下：

| consumer | 预期 postcondition |
| --- | --- |
| TS/shell meta-alert | `${SLOT_DIR}/meta-alert/*` |
| transport `getStateDir()`（founder cursor、structured inbox、adapter state） | `${SLOT_DIR}` 下对应 raw-base 路径 |
| `bridgeMarkerPath()` | `${SLOT_DIR}/state/bridge-running-marker.json`；动态测试钉住 root 语义 |
| EventLoopAttribution | 继续被显式 `FLYWHEEL_LOOP_DIAGNOSTICS_DIR=${SLOT_DIR}/state/loop-diagnostics` 覆盖 |
| WorktreeManager / push guard | `${SLOT_DIR}/state/push-guard/*` |
| FleetPoller / lead-window locator | 只查 `${SLOT_DIR}/manifests` 与 `${SLOT_DIR}/bin`；529 Lead manifest 在 `launchd/*`，test lead 保持 external/null。接受此 test-only 可见性降级，禁止回读生产 manifest |
| tmux environment scrub | `${SLOT_DIR}/.env` 缺失走既有 ENOENT 分支，仍 scrub hard-coded forbidden names；独立 `TMUX_TMPDIR` server 从 positive allowlist 出生。不复制生产 `.env`，也不为消日志新增空文件 |
| quota/account-heal defaults | 若动作触发，只使用 `${SLOT_DIR}` 下 profile/journal/lock/config |
| Codex account ledger/profile child | 若继承 env，只使用 `${SLOT_DIR}/codex-account-ledger` |
| direct Claude agent-team child | `ClaudeCodeAdapter.runtimeEnv()` 转发 `${SLOT_DIR}` |
| tmux Runner pane | `TmuxAdapter` positive allowlist 不含该变量，既有 Runner-side resolution 不变；本单不扩成 Runner 隔离改造 |
| 不受该变量治理的只读路径 | `plugin.ts` 的 flag/management env path 仍读 `homedir()/.flywheel/.env`，pool rebuild 的 `~/.claude.json` 同理；明确 out of scope。本单不宣称 Bridge 对生产 HOME 零读取，只保证 state-root writer 隔离 |

这也解释为何值不能是 `${SLOT_DIR}/state`：root consumer 会写成
`${SLOT_DIR}/state/state/*`，而 fleet/bin/manifests 查找整体错层。

## 实施步骤

### 1. RED：先建立会复现旧缺口的安全回归

在 `scripts/__tests__/test-deploy-generalized.test.sh` 的启动隔离契约区添加一个动态用例：

1. 在 suite 自带的 `TMP_ROOT` 下创建 `fake-production-state`、slot root 与只返回成功的
   fake `osascript`；不读取或写入真实 `~/.flywheel`。
2. fake production state 预置 sentinel，先用 `type -P shasum` 解析并钉住外部 binary（明确
   绕过 suite 内定义的 `shasum()` stub），再记录执行前所有文件的排序摘要。
3. 从 `scripts/test-deploy.sh` 抽取唯一的
   `BRIDGE_EXTRA_ENV+=("FLYWHEEL_STATE_DIR=...")` 语句；定义 `SLOT_DIR` 和空
   `BRIDGE_EXTRA_ENV` 后执行该 repo-owned 语句。
4. 增加 executable static guards：Bridge state assignment 计数严格为 1、它是最后一条
   `BRIDGE_EXTRA_ENV+=`、三个 Bridge 启动分支的数组展开计数严格为 3；这把真实组合与
   later-wins 顺序纳入 suite，不留作人工目检。
5. 让 `meta-alert.sh` 子进程先继承 fake production 的 `FLYWHEEL_STATE_DIR`，再展开
   `BRIDGE_EXTRA_ENV`，写 `fly2163_slot_state_probe` marker。
6. 断言 `${slot}/meta-alert` marker 存在、正文含唯一 probe、fake production 的外部
   `shasum` 文件摘要前后完全相等。
7. 在同一解析出的 env 下，于 repo root 使用 `pnpm exec tsx -e` 直接 import
   `packages/teamlead/src/bridge/bridge-exit-marker.ts` source（不走 package export、不依赖
   prebuilt/stale dist），调用真实 `bridgeMarkerPath()`；断言结果严格为
   `${slot}/state/bridge-running-marker.json`。这覆盖 majority ROOT-convention consumer，
   防止仅凭 meta-alert 的 raw-base 语义得出假结论。

先只提交测试改动并运行：

```bash
bash scripts/__tests__/test-deploy-generalized.test.sh
```

预期 RED：Bridge assignment 缺失；真实 writer 产物落 fake production 而非 slot，且 fake
production 摘要变化。这个失败必须发生在临时目录，不能触碰生产文件或弹桌面通知。

### 2. GREEN：最小生产修复

在所有 helper 与 extra-lead token 项组装完、Step 3 启动 Bridge 前，把下面一行作为
`BRIDGE_EXTRA_ENV` 的最后一项：

```bash
BRIDGE_EXTRA_ENV+=("FLYWHEEL_STATE_DIR=${SLOT_DIR}")
```

不在三个 Bridge 启动分支复制，不放进 `GENERALIZED`/`ALERTS` 条件，不写入
`LEAD_EXTRA_ENV`。最后一项位置利用 `env` 的 later-wins 语义压过任何动态 helper/token 名
误配出的同名项。重新运行同一个测试，要求全部 GREEN。

### 3. 聚焦验证与负面守卫

执行：

```bash
bash -n scripts/test-deploy.sh scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/test-deploy-multilead.test.sh
```

suite 必须自动检查：

- `scripts/test-deploy.sh` 中 Bridge state assignment 恰好一处；
- 三个 Bridge `env` 分支都仍展开 `BRIDGE_EXTRA_ENV`；
- state assignment 必须是最后一条数组 append；任何更晚直接或动态项都不能覆盖它；
- Lead manifest 的 `FLYWHEEL_STATE_DIR=${state}` 未改变；
- root consumer `bridgeMarkerPath()` 不出现 `state/state`；
- diff 不包含 writer、resolver、teardown 或配置变化；
- 测试中的 fake production 根位于 `TMP_ROOT`，且 fake `osascript` 阻断桌面副作用。

### 4. 全仓门与 review

按实现节点要求运行精确全仓命令：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

本方案不新建 `scripts/__tests__/*.test.sh`；修改的现有 shell suite 已在聚焦步骤和 CI 矩阵中
执行。随后通过 `codex:rescue` 做独立代码评审，注册 `review_code` gate 并轮询结构化 verdict。
任何 blocking finding 都先修复、重跑相关测试、推送新 head，再开新 gate/request-review 轮次。

### 5. 提交、PR 与阶段交接

提交保持小而可恢复：

1. DOC-FLOW exploration/research/approved plan；
2. RED/GREEN 测试与一行生产修复；
3. review 修复（如有）；
4. `engineering/doc/milestones/FLY-2163.md` 作为开 PR 前的字面最后提交。

PR 只面向 feature branch，不 merge、不 deploy、不触发 QA successor。创建 PR 后通过
`ask --report` 向 Lead 报告 commit、验证和 PR URL，再运行
`complete --route needs_review --pr <NUMBER>`。

## 验收矩阵

| 要求 | 权威证据 |
| --- | --- |
| 起房时 Bridge state root 指向 slot | `BRIDGE_EXTRA_ENV` 唯一 assignment + 三分支统一展开 |
| 不依赖 `--alerts` / generalized / Lead | assignment 位于所有条件外 |
| 房内 state writer 真写到 slot | 真实 `scripts/meta-alert.sh` 生成 `${slot}/meta-alert` marker |
| root 语义正确 | 真实 `bridgeMarkerPath()` 返回 `${slot}/state/bridge-running-marker.json` |
| 生产目录零变化 | fake production 全文件 external-`shasum` 前后严格相等（`type -P` 钉住 binary，不命中 suite stub） |
| 旧缺口可被测试抓住 | 删除 assignment 时 marker 落 fake production，测试 RED |
| Lead 隔离不回归 | 既有 `${SLOT_DIR}/q/<carrier-slot>` assertion 继续 GREEN |
| 仓库无连带回归 | lint/build/package tests 与相关 shell suites 全绿 |

## 回滚

若需回滚，成对撤销 production assignment 与对应动态回归。单独撤销 production 行会使测试
立即 RED；单独撤销测试会失去本单要求的阳性对照。该变更不迁移数据、不改 schema，也不触碰
生产 state 内容。
