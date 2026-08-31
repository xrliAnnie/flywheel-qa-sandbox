# FLY-2163 slot Bridge state 隔离 — 调研
Issue: FLY-2163 (https://linear.app/geoforge3d/issue/FLY-2163/529隔离漏-slot-bridge-不隔离-flywheel-state-dir测试房覆写了生产-meta-alert-文件134502)
日期: 2026-08-30
基于: exploration.md

## 读路径与写路径

仓库里存在两种历史命名，但显式 env 的生产约定是确定的。Bridge wrapper、host config、daemon、
fleet、lead wrapper、push guard 与 account ledger 都把 `FLYWHEEL_STATE_DIR` 当作
`~/.flywheel` **根**；消费者自行追加 `state/`、`manifests/`、`bin/` 等子目录。
`packages/agent-team-transport/src/path-helpers.ts` 与 `scripts/meta-alert.sh` 的 fallback 名字看似
“state 子目录”，但只要 env 存在就原样采用它。生产和 runner 的实值是
`/Users/xiaorongli/.flywheel`，这正好解释了被覆写的真实路径
`~/.flywheel/meta-alert/alert_unreachable_config.txt`。

因此改 `HOME` 或单独改 `TEAMLEAD_DB_PATH` 都不能覆盖 runner 会话里已经存在的生产
`FLYWHEEL_STATE_DIR`；而正确隔离值必须复制 root 语义：`${SLOT_DIR}`，不是
`${SLOT_DIR}/state`。后者会让 root-convention consumer 产生 `state/state` 双嵌套。

FLY-2103 QA 在 2026-08-29 13:45:02 已观察到隔离 Bridge 覆写生产
`~/.flywheel/meta-alert/alert_unreachable_config.txt`。FLY-2155 后续又证明不带
`--alerts` 的 generalized/no-lead 房会把 dead-letter 与 `alert_dead_lettered` marker 写到
生产目录；带 `--alerts` 也不能作为完整隔离证据，因为仍有 lease-audit 路径从 Bridge 的
全局 state root 落盘。这些现象共同指向启动边界，而非某一个 writer。

## 启动边界

`scripts/test-deploy.sh` 在确定 `SLOT_DIR` 后创建 `LEAD_EXTRA_ENV` 与
`BRIDGE_EXTRA_ENV`。Bridge 已有的 slot-local 项包括：

- `FLYWHEEL_COMPLETE_MARKER_DIR=${SLOT_DIR}/state/complete-failed`
- `FLYWHEEL_LOOP_DIAGNOSTICS_DIR=${SLOT_DIR}/state/loop-diagnostics`
- `FLYWHEEL_DELIVERY_SECRET_PATH=${SLOT_DIR}/state/delivery-secret`
- `FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH=${SLOT_DIR}/state/founder-consent-audit.db`
- `TMUX_TMPDIR=${SLOT_DIR}`

三个 Bridge 启动分支都在 `env` 命令中展开同一个 `BRIDGE_EXTRA_ENV`。所以无需修改每个
分支，也无需把隔离绑到 `GENERALIZED` 或 `ALERTS` 条件：在所有 helper 与 extra-lead token
已经追加完、Step 3 启动 Bridge 之前，把 `FLYWHEEL_STATE_DIR=${SLOT_DIR}` 作为数组的最后一项
无条件追加，即覆盖普通、roundtable、alerts、generalized、stub/no-lead 的组合。放在最后还会
利用 `env` 的 later-wins 语义压过任何动态 helper/token 名误配出的同名项。

Lead 侧不同：`qa_launchd_start_lead()` 已把 `FLYWHEEL_STATE_DIR=${state}` 写入每个 carrier
manifest，其中 `state=${SLOT_DIR}/q/<carrier-slot>`。把 Bridge 的值同时塞进
`LEAD_EXTRA_ENV` 会把更细粒度的 Lead 隔离降级为房级共享，既无必要也不正确。

## Bridge consumer 全量影响

以下是 live code 中**由 `FLYWHEEL_STATE_DIR` 解析**的 Bridge 进程读取结果。目标不是保持
读取生产目录，而是把这一组全部限制在 slot；没有被 Bridge 启动/运行调用的安装与 onboard
shell 不在本表。

| consumer | `${SLOT_DIR}` 后的路径/行为 | 结论 |
| --- | --- | --- |
| `MetaAlertNotifier`、`scripts/meta-alert.sh` | `${SLOT_DIR}/meta-alert/*` | 本事故目标；writer 自建目录 |
| transport `getStateDir()`：founder reply cursor、structured inbox、adapter state | `${SLOT_DIR}/founder-reply-cursor.json`、`${SLOT_DIR}/inbox-structured/*` | 历史 raw-base 语义，但完整留在 slot |
| `bridgeMarkerPath()` | `${SLOT_DIR}/state/bridge-running-marker.json` | root 语义；必须用动态断言钉住，防 `state/state` |
| `EventLoopAttribution` | 仍由更高优先级显式值落 `${SLOT_DIR}/state/loop-diagnostics` | 此变量变更不改变它 |
| `WorktreeManager` / push guard | `${SLOT_DIR}/state/push-guard/*` | root 语义，正确留在 slot |
| `FleetPoller` / `locateConfiguredLeadWindow` | 查 `${SLOT_DIR}/manifests/*` 与 `${SLOT_DIR}/bin/*` | 房内 v2 Lead manifest 实际在 `launchd/*`；因此 test lead 继续是 external/null。接受这个 test-only 可见性降级，优于误读生产 manifest |
| `tmux-environment-scrub` | 尝试读 `${SLOT_DIR}/.env`；该文件有意不存在 | 进入已设计的 ENOENT 分支，仍按 hard-coded forbidden names 与 positive allowlist scrub。slot 使用独立 `TMUX_TMPDIR`，不会读取生产 `.env`；不为消除一条日志复制生产 secret 名单 |
| quota/account-heal 默认路径 | `${SLOT_DIR}/claude-profiles`、journal、lock、quota config | 仅在对应运维动作触发时使用；redirect 是所需隔离 |
| Codex account ledger/profile 子进程 | `${SLOT_DIR}/codex-account-ledger` | 仅收到该 env 的子进程采用；留在 slot |
| `ClaudeCodeAdapter.runtimeEnv()` | 把 `${SLOT_DIR}` 转发给 direct Claude agent-team child | 该 child 继续隔离在 slot |
| `TmuxAdapter` runner pane | positive allowlist 不含 `FLYWHEEL_STATE_DIR`，不继承 | 本单只修 Bridge；tmux Runner 的既有 HOME/显式路径策略不变 |
| 不受本变量治理的只读路径 | `plugin.ts` 的 flag/management env path 仍读 `homedir()/.flywheel/.env`；pool rebuild 的 `~/.claude.json` 同理 | 明确 out of scope；本单不宣称 Bridge 对生产 HOME 零读取，只保证 state-root writer 隔离 |

另有 `flywheel-comm` 等 Bridge child 会继承 env；它们若读取 state root，同样从生产根改为 slot
根，这是租户隔离的预期结果。无需为这些 consumer 新增专用 env，因为那会重新制造分裂。

## 测试缺口与正反对照

已有 `scripts/__tests__/test-deploy-generalized.test.sh` 的开头只静态断言
`FLYWHEEL_STATE_DIR=${state}` 存在于 Lead manifest。它没有：

1. 区分该字符串来自 Lead 还是 Bridge；
2. 证明三个 Bridge `env` 分支仍统一展开数组，且数组没有重复 state assignment；
3. 调用任何 state writer；
4. 检查生产根目录没有变化。

最小且安全的动态测试可复用该 shell suite 与真实 `scripts/meta-alert.sh`：

1. 在 `TMP_ROOT` 下建立 fake production state 与 slot root，fake production 预置 sentinel；
2. 从 `scripts/test-deploy.sh` 读取唯一的
   `BRIDGE_EXTRA_ENV+=("FLYWHEEL_STATE_DIR=...")` 语句，在定义好的 `SLOT_DIR` 与空数组上
   执行这条可信 repo 语句；
3. 子进程先继承 `FLYWHEEL_STATE_DIR=<fake-production>`，再把数组作为 `env` 参数展开；
4. 调用真实 `meta-alert.sh` 写唯一 marker，并用 fake `osascript` 禁止桌面副作用；
5. 用 `type -P shasum` 解析并钉住外部 binary，绕过 suite 内的同名 stub；断言 marker 只出现在
   `${slot}/meta-alert`、正文匹配，fake production 的全文件摘要前后相等；
6. 在 repo root 用 `pnpm exec tsx -e` 直接 import source 文件（不依赖 package export 或
   prebuilt dist），调用真实 `bridgeMarkerPath()` 并断言 root-convention 路径为
   `${slot}/state/bridge-running-marker.json`，并静态断言三处数组展开、唯一 assignment，且
   state assignment 是最后一条 `BRIDGE_EXTRA_ENV+=`。

删除修复行时，同一测试会安全地把 marker 写进 fake production，导致 slot 缺产物与生产摘要
变化两条断言同时失败。它既是阳性对照，也是旧缺口的负面对照，不需要启动 Discord、Bridge
或真实 529 slot。

## 方案比较

| 方案 | 覆盖 | 代价与结论 |
| --- | --- | --- |
| 只给 meta-alert 增加专用路径 | 只遮住一个症状 | 其他 state writer 仍污染；不满足租户隔离 |
| 修改 `getStateDir()` 忽略继承 env | 影响全产品 | 破坏显式部署配置；范围错误 |
| 每个 Bridge 分支各写一次 env | 能修复 | 三份重复，未来分支容易再漏 |
| 在 `BRIDGE_EXTRA_ENV` 无条件追加 slot root | 覆盖所有房型 | 一行生产改动，沿用现有注入点；采用 |

## 风险与验证

- 路径兼容：`${SLOT_DIR}` 是现有 bin/hooks/alert queue/deadletter 的房级根；root consumer
  再追加 `state/`，raw-base consumer 留在房根，均不产生双嵌套。
- 顺序：数组在 Bridge `env` 命令的固定参数之后展开，state root 又是数组最后一项；显式值
  同时覆盖进程继承值与更早的动态 helper/token 项。测试钉住唯一同名 assignment、最后一项
  位置和三个分支各展开一次。
- `.env`：不创建 `${SLOT_DIR}/.env`。isolated tmux server 从 allowlist 出生；scrubber 对缺文件
  有显式降级并继续移除 hard-coded forbidden names。复制生产 `.env` 或其 secrets 反而违反隔离。
- 清理：slot teardown 已按房根清理/保留诊断，新增文件自然属于同一所有权边界。
- 回归范围：聚焦 shell suite、shell syntax、全仓 lint/build/package tests，以及所有新增
  `scripts/__tests__/*.test.sh`（本方案不新建测试文件）。
