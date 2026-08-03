# FLY-1608 529房既有缺陷×2:Lead 秒死 + boot drain 吞生产 marker — 探索

Issue: FLY-1608 (https://linear.app/geoforge3d/issue/FLY-1608/529房既有缺陷2-test-deploy-从仓库根起-lead-秒死729-起全坏-complete-marker-boot-drain)
日期: 2026-08-02
基于: 无

## 问题陈述

2026-08-02 FLY-1606 第六层 E2E 在 529 QA 房实测撞出两个**既有**缺陷(与 PR #760 无关):

1. **缺陷 ①(Lead 秒死)**:`test-deploy.sh` 从仓库根启动 test Lead 时,`claude-lead.sh:78` 的 FLY-1502 v2 守卫 `import("flywheel-v2-kernel")` 解析失败 → node 非零退出 → `set -e` 秒杀 Lead supervisor → 部署中止。7/29 守卫落地后,从仓库根跑的 529 部署一直是坏的。生产不受影响(生产 wrapper `~/.flywheel/bin/flywheel-lead-wrapper.sh:222/231` 先 `cd packages/teamlead`)。
2. **缺陷 ②(boot drain 不分 slot)**:slot Bridge 启动时的 complete-marker boot drain 扫描的是**生产**目录 `~/.flywheel/state/complete-failed/`,未随 slot 隔离。实测后果:生产的 FLY-1606 待重放 marker 被测试 Bridge 扫走 → 测试库 FSM 拒 → 移入生产 quarantine 目录(`scanned=1 reconciled=0 quarantined=1`)。测试活动改变了生产 pending 状态。

两个缺陷合起来 = 529 房(QA 主阵地)既起不来、起来了还会污染生产。房间坏 = QA 能力坏(feedback_qa_before_ship)。

## 为什么会有这两个缺陷(结构原因)

### 缺陷 ① 的结构原因:守卫的 module 解析依赖调用者 cwd

- `flywheel-v2-kernel` 是 workspace 包,只声明在 `packages/teamlead/package.json` 的 dependencies(`workspace:*`),pnpm 只把它 link 到 `packages/teamlead/node_modules/` — **仓库根 `node_modules/` 没有它**。
- 守卫用 `node --input-type=module -e 'import("flywheel-v2-kernel")...'`,bare specifier 的解析基准是 **node 进程的 cwd**。
- 生产 wrapper 恰好 `cd packages/teamlead` 再 exec → 解析成功;`test-deploy.sh:1158/1450` 直接 `bash .../claude-lead.sh`,继承调用者 cwd(通常是仓库根)→ `ERR_MODULE_NOT_FOUND` → 秒死。
- 这是一个"隐式 cwd 合同":claude-lead.sh 没有声明"必须从 packages/teamlead 跑",却在第 78 行悄悄依赖它。任何不知道这条隐式合同的调用者(529 房、未来的 ad-hoc 操作者)都会踩。

### 缺陷 ② 的结构原因:complete-failed 路径是 HOME 硬派生、无 env 缝

- 写入侧 `flywheel-comm complete.ts:writeMarker()` 与读取侧 `teamlead complete-marker-reconciler.ts:defaultMarkerDir()/defaultQuarantineDir()` 都是 `$HOME/.flywheel/state/complete-failed{,-quarantine}` 硬派生。
- 529 房已经给一批状态路径开了 env 缝(`TEAMLEAD_DB_PATH`、`FLYWHEEL_BIN_DIR`、`FLYWHEEL_HOOKS_DIR`、`FLYWHEEL_CLAIMS_DB`、`FLYWHEEL_ALERT_QUEUE_DIR/DEADLETTER_DIR`…),complete-failed 是漏网的一个。
- 同文件里已有完全同构的先例:`FLYWHEEL_GATE_MARKER_DIR`(gate marker 的 env 覆盖,FLY-123)。complete marker 没有对应物。

## 方案空间

### 缺陷 ① 的候选

| 方案 | 说明 | 评价 |
|---|---|---|
| **A1. 守卫自锚定(root cure)** | claude-lead.sh 守卫用 `$(dirname "$0")/..` 定位自己所在的 package 目录,在子 shell 里 `cd` 过去再跑 node。任何调用者 cwd 都能解析 | ✅ 治本:消灭隐式 cwd 合同,所有调用者(529 房、手工操作、未来脚本)一次修好。fail-closed 语义保留 |
| **A2. test-deploy 复刻生产 wrapper 的 cd** | 两个 Lead 启动位点(1158/1450)把子进程 cwd 钉到 `packages/teamlead` | ✅ 生产等价性(FLY-1389 教训:房间要精确复刻生产语义)。但单独做只修这一个调用者 |
| A3. 把 kernel 提升到仓库根 dependencies | root package.json 加 `flywheel-v2-kernel` | ❌ 为了一个守卫改依赖图;pnpm 根 node_modules 语义被守卫绑架;其他从更外层 cwd 的调用照样挂 |
| A4. 守卫改成绝对 file:// URL import | `import('file://<pkg>/node_modules/flywheel-v2-kernel/dist/index.js')` | ❌ 绕过 package exports 解析,硬编码 dist 布局,比 subshell-cd 更脆 |

**选择:A1 + A2 都做**(各自一小段 diff)。A1 治本 + 报错分流(module 装不上 vs v2 authority 拒绝,现在两种失败都糊成一个裸 ERR_MODULE_NOT_FOUND 栈);A2 让房间与生产 wrapper 语义逐字对齐,防未来任何 cwd 敏感代码再分叉。

### 缺陷 ② 的候选

| 方案 | 说明 | 评价 |
|---|---|---|
| **B1. 单 env 缝隔离(选定)** | 新 env `FLYWHEEL_COMPLETE_MARKER_DIR`,写入侧+读取侧都认;quarantine 恒等于 `<markerDir>-quarantine`(与现状字节兼容);test-deploy 给 Bridge/Lead 设 slot 路径;adapter 把它透传进 Runner env | ✅ 双向隔离(房间不吞生产 marker,slot Runner 的 fail-close marker 也不落生产);529 房保留 E2E 测 drain 本身的能力(FLY-1607 消费方需要);先例齐全(FLYWHEEL_GATE_MARKER_DIR / FLY-529 alert 目录) |
| B2. slot 模式跳过 boot drain | 加 `FLYWHEEL_SKIP_BOOT_DRAIN=1` | ❌ 只堵读方向:slot Runner 崩溃测试写的 marker 照样落生产目录,反向污染更糟(生产 Bridge 会重放测试 marker);房间永远测不了 drain 功能;skip flag 会烂 |
| B3. 广义 state root 隔离(`FLYWHEEL_STATE_DIR`) | 一个根 env 覆盖所有 HOME 派生路径 | ❌ 爆炸半径大(几十处 HOME 派生,claims/alert/misroute-archive 等已各有 env,重叠语义打架);本单 scope 只有 complete-failed |

**选择:B1**。一个 env 名,读写两侧 + Runner 透传三处接线,unset = 字节兼容现状。

## 关键约束

- **生产零行为变化**:env 未设时所有路径逐字节等于现状;守卫在生产 wrapper cwd 下行为不变。这是 529 房改动的铁律(FLY-529 同款 reverse-compat sentinel 模式)。
- **fail-closed 不得弱化**:FLY-1502 守卫"装不上/坏了就拒启"的语义保留 —— 修的是"解析环境错了导致把'检查器加载不了'误当'检查未过'",不是放宽检查。
- **不重复 FLY-1607**:被吞的 1606 marker 恢复归 FLY-1607 收敛步骤,本单不做。

## 未解问题(带入 research 验证)

1. 读取侧是否所有生产调用点都经 `defaultMarkerDir()/defaultQuarantineDir()` 收口?(boot drain / heartbeat reconcile / done-running sweep)
2. Runner env 是怎么构造的 —— slot Bridge 的 process env 会不会自动到 Runner tmux 窗口?(不会的话必须显式 `-e` 透传)
3. test-deploy 有没有现成的单点 env 注入位?(避免 Bridge 两个启动分支各改一遍)
