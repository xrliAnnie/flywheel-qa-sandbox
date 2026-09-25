# FLY-2695 宿主 shim + converge 收敛 — 探索

Issue: FLY-2695 (https://linear.app/geoforge3d/issue/FLY-2695/raya-并仓s2-宿主-shim-converge-收敛raya-cosshl1-加载路径实机验证-codex-full-access)
日期: 2026-09-24
基于: 无(施工依据是已合入 main 的 `engineering/doc/FLY-2680-raya-merge-plan/plan.md`,PR #1239;S1 已合入,PR #1253)

> 本节点**只设计**。不改代码、不动生产、不碰 Raya 仓、不重启、不申请 ship。
> 本单是 Epic FLY-2679 的 **S2**:给 Raya 人设一个稳定的宿主入口 `~/.flywheel/bin/raya-cos.sh`,
> 由现有 `converge-flywheel-bin.sh` 分发与守护,并把 plan §10.2 注要求的 retired/residue 合同落地。
> 上游 plan 已把加载路径(§6.2)、packaged 排除(§6.2 🔴)、回滚合同(§10.2 注)、QA 判据(§12 S2 行)写定;
> 本文档的任务不是重新设计,而是把 plan 落到 file:line 级施工书,并把 plan 自己标为「未验证」的
> 第 7 条(Codex full-access 沙箱能否执行 shim)在设计阶段就用可复现的方法核掉。

## 1. 工单要求(逐条对照上游 plan)

| 工单原文 | 上游 plan 出处 | 本单动作 |
|---|---|---|
| 按 §6.2 推荐的 L1「收敛 shim」实现加载路径 | plan §6.2 | 新增 `scripts/raya-cos.sh`(复制安装,不是符号链接),加进 `converge-flywheel-bin.sh:81` 的 monorepo `FILES` 与 `:155` 首次采纳白名单。**不加** `:92` 的 packaged 分支 |
| QA ①:隔离 `FLYWHEEL_STATE_DIR` 夹具里跑收敛器,断言 shim 出现、mode 555、校验和等于 repo 源 | plan §12 S2 ① / §6.2「为什么这条路对」第 3 条 | 沿用 `scripts/__tests__/converge-flywheel-bin.test.sh` 的 hermetic 形态加 C13–C16;设计阶段已在 scratchpad 跑通(research §6) |
| QA ②:无 `host.json` 时解析到 `$HOME/Dev/flywheel` | plan §6.2「为什么这条路对」第 1 条;`host-config.sh:104-106` | 新增 `scripts/__tests__/raya-cos-shim.test.sh`,用假 `HOME` + stub `cli.js` 断言 exec 目标路径(不依赖真 dist) |
| QA ③:`raya-cos.sh status` 返回 `{"operations":[]}` | plan §12 S2 ③ / §10.2 A2 | **精度更正**:真实输出是 `{"schemaVersion":2,"operations":[]}`(`business-round.ts:132-145`,S1 的 `raya-cos-cli-dist.test.mjs:52-55` 已钉住)。判据写成「`.schemaVersion==2 && .operations==[]`」,见 §3.2 |
| QA ④:实机验证 Codex full-access 沙箱能执行它(§13 第 7 条,本单核心风险) | plan §6.2 末段、§13.7 | 设计阶段已用 **Raya 实际运行的 Codex 0.156.1 二进制里逐字节提取的 Seatbelt 策略**做无凭据复演,含正/负对照(research §5);施工阶段再补一次带凭据的真 `codex exec`(隔离 `CODEX_HOME`)作为第二层证据 |
| QA ⑤:packaged 阴性对照 —— 根带 `.flywheel-prebuilt` 时收敛后 shim **不存在**且不报 `srcmissing` | plan §6.2 🔴「阴性测试不能用空夹具」 | 预置-再断言删除:先放 555 的旧 shim + adoption marker + 一个无关普通文件,再跑 packaged 收敛,断言前两者被精确删除、无关文件保留、零 `srcmissing` |
| QA ⑥:retired/residue 合同已落地(§10.2 注) | plan §10.2「S2 的回滚合同」+「forward rollback」 | 收敛器新增精确的 `RETIRED_FILES` 清单 + 主动删除 + 验证删除(复用 FLY-1577 的 `strict_discard`);packaged 分支当前版本即把 `raya-cos.sh` 视为 retired |
| §14 点名的位置按修订后文字施工 | plan §14 | §14 六条修订落在 §12 S4 行 / §12 S3 行 / §7A 三节点表 / §11 合计行 / §10.4 / §10.5,**没有一条触及 §6.2、§10.2 注、§12 S2 行**。PR 描述写明「已逐条核对 §14,不涉及 S2」 |
| §13 未验证清单不当事实 | plan §13 | 与 S2 相关的只有第 7 条(沙箱)与第 9 条(packaged 是否跑 `update-flywheel.sh`)。第 7 条本单核掉;第 9 条与本单无关(shim 不进 packaged) |
| 现场更新:旧壳已 bootout+disable;FLY-2657 独立推进 | 工单「必须知道的三件事」第 3 条 | 现场比工单写的又往前走了一步:**FLY-2657(PR #1241)已于 2026-09-18 合入并完成过一次切换**,见 §2 |

## 2. 现场基线(设计时读到的,2026-09-24)

| 对象 | 值 | 读法 |
|---|---|---|
| 本 worktree HEAD | `637752fcc`(`FLY-2775 … (#1295)`) | `git log -1` |
| S1 状态 | **已合入**:PR #1253 `FLY-2694: land Raya CoS package` merged 2026-09-18T16:35Z;`packages/raya-cos/` 在 main,包名 `flywheel-raya-cos`,`bin.raya-cos=./dist/cli.js` | `gh pr list`;`packages/raya-cos/package.json` |
| 生产 checkout 的 dist | `~/Dev/flywheel/packages/raya-cos/dist/cli.js` **存在**;`~/.flywheel/deployed-sha` = `637752fcc…`(与本 worktree HEAD 同) | `ls`;`cat` |
| 本 worktree 的 dist | **不存在**(未 build;实施节点跑测试前需 `pnpm --filter flywheel-raya-cos build`) | `ls packages/raya-cos/dist` |
| `~/.flywheel/host.json` | **不存在** ⇒ `FLYWHEEL_DIR` 走默认 `$HOME/Dev/flywheel` | `cat` |
| `~/.flywheel/bin/lib/host-config.sh` | 存在(mode 644,由 `provision-fleet-host.sh:373` 安装,不在收敛器 `FILES` 里) | `ls -la` |
| Lead 子进程 PATH | `~/.local/bin:~/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH`,**不含** `~/.flywheel/bin` | `scripts/flywheel-lead.sh:8` |
| 活 Raya Lead | `com.flywheel.lead.raya-raya` → `/bin/bash ~/.flywheel/bin/flywheel-lead.sh ~/.flywheel/manifests/raya-raya.json`;PID 26815 = `codex-lead-tui-runtime.js`;manifest `leadBackend.backendId=codex-app-server`,`workspace=/Users/xiaorongli/Dev/raya-lead-workspace`,`model=gpt-6-astra` | `plutil -p`;`ps`;manifest |
| Codex 二进制 | `~/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex`(0.156.1) | `ps`;`codex --version` |
| 沙箱形态 | `sandbox_mode="workspace-write"`,`network_access=true`,`writable_roots=[<workspace>]`(full-access 合同) | `codex-lead-tui-home.sh:576-580`;`codex-lead-runtime.ts:411-413` |
| 旧壳 | `launchctl list \| grep -i raya` 只剩 `com.flywheel.lead.raya-raya`;`com.xrli.raya.{brain,voice}.plist` 文件仍在 `~/Library/LaunchAgents`(与工单一致:bootout+disable,plist 未动) | `launchctl list`;`ls` |
| **FLY-2657** | **PR #1241 已 merged(2026-09-18T16:34Z)**,且班车已切换过一次:活工作区有 `business/current -> .flywheel-managed/versions/90e433e87a68…`(2026-09-19 00:08),活 `identity.md`(17866 B,sha256 `ca1240f1…`)已含「Durable business commands」段,写的是 `node business/current/packages/cos/dist/cli.js …` | `ls -la`;`shasum`;`grep -n business/current` |
| cos 是否在生产被调用 | **是**:`~/Dev/raya-lead-workspace/state/cos/`(2026-09-22 起)有 `operations/` 4 条、`status-latest.json`(09-24 11:03) | `ls -la` |
| 宿主 bin 残留 | `~/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh`(555,09-01)+ `~/.flywheel/state/converge-adoptions/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh` marker —— 曾被收敛器管理,后从 `FILES` 摘掉却没人删,正是 plan §12.1 第 2 条的实例;plist **不引用**它 | `ls`;`plutil -p` |

## 3. plan 与现实的四处偏差(必须回报 Lead;本单按现实施工)

### 3.1 🔴 plan §6.2 那份 8 行 shim 会被收敛器当 stub 拒装

`scripts/lib/script-sanity.sh:24` 的 `FLYWHEEL_SCRIPT_MIN_BYTES=1024` 是**不可调**的写入门槛
(Codex R1#4 明确拒绝 env 旋钮),`install_script_atomic` 先跑 `assert_sane_script_source`。
plan §6.2 的示例 shim 约 350 B ⇒ 收敛器会走「repo source insane → alert only, NEVER repair」分支
(`converge-flywheel-bin.sh:246-252`),**shim 永远装不上,还每次 Lead 启动都拉一条 severe 告警**。

处置:shim 必须 ≥1024 B,靠**实质性文档注释**(是什么 / 为什么是 copy 不是 PATH / 不变量)撑起体积,
逻辑仍是 plan 的那几行。设计阶段原型 2429 B,已在夹具里被收敛器正常安装(research §6 B1)。

### 3.2 `status` 的精确形状

plan §12 ③ 与 §10.2 A2 写「`{"operations":[]}` 形状」。真实输出 `{"schemaVersion":2,"operations":[]}`
(`packages/raya-cos/src/business-round.ts:132-145`)。QA 判据改为 jq 断言
`.schemaVersion==2 and .operations==[]`,避免 QA 拿字面串 diff 判红。

### 3.3 §9.4 走的是第一行,不是第二行

工单写「FLY-2657 在独立推进,本 Epic 不等它」。现场:2657 已合入并**成功切换过一次**
(§2 表)。这落在 plan §9.4 第一行「2657 落地并成功完成一次切换」。对 S2 的含义:

- 今天 Raya 通过 `business/current`(→ raya@`90e433e8`)在跑 cos;S1 搬进 Flywheel 的正是同一个 sha 的 `packages/cos`(`packages/raya-cos/package.json` description)。**两条路径指向同一份代码、同一种 `state/cos/` 布局,cos 是 cwd-scoped**,所以 S3 把人设从 `business/current/...` 改成 `~/.flywheel/bin/raya-cos.sh` 时不需要迁移任何状态;
- S2 本身仍是纯增量:装一个没人调用的文件。**S2 合入 + 部署后,生产 Raya 行为零变化**(人设还指着 `business/current`);
- 旧壳的 `launchctl` 现状与工单一致,S2 不碰。

### 3.4 `FILES=` 行数被测试钉死为 2

`scripts/__tests__/flywheel-lead-packaging.test.sh:50-63` 断言收敛器里 `^[[:space:]]*FILES=` **恰好 2 行**,
且每行都匹配 `*lib/lead-host-tmux-gate.sh*lib/raya-standard-migration.sh*lib/codex-quota-summary.mjs*`。
⇒ 只能把 `raya-cos.sh` **追加到 monorepo 那一行字面量末尾**,不能写 `FILES="$FILES raya-cos.sh"` 第三行;
retired 清单用另一个变量名(`RETIRED_FILES=`)。设计阶段已验证追加后两条模式都仍匹配(research §6 C2)。

## 4. 方案空间

### 4.1 加载路径(plan 已裁定 L1,本单只确认没有更好的)

| 选项 | 内容 | 判定 |
|---|---|---|
| **L1 收敛 shim(plan of record)** | `scripts/raya-cos.sh` 复制到 `<state>/bin/`,收敛器守「sha==repo 源 && mode 555」;shim 内用 host-config 解析 `FLYWHEEL_DIR` 后 `exec node $FLYWHEEL_DIR/packages/raya-cos/dist/cli.js "$@"` | **采用**。载体零改动;沙箱复演通过(research §5);回滚有合同(§4.2) |
| L1′ 符号链接 lane | 像 `agent-team-transport` 那样在 bin 放 symlink 指向 `packages/raya-cos/dist/cli.js` | **否**:symlink lane 的目标是 `.js`,人设需要 `node <path>` 形式;且 symlink lane 只在「信任根」下修复(`converge-flywheel-bin.sh:~389`),worktree/临时根下不管;还绕开了 host-config 的 ENV>host.json>默认解析 |
| L2 物化 dist 到工作区固定目录 | 由 Flywheel 班车把 dist 写到 `<workspace>/…` | **仅作 L1 失败退路**(plan §6.3)。复演已证明 L1 可行,不启用 |
| L3 载体 import cos | — | plan §6.3 已否 |

### 4.2 retired/residue 合同(plan §10.2 注已裁定 (a) + forward rollback)

| 选项 | 内容 | 判定 |
|---|---|---|
| **(a) 精确 `RETIRED_FILES` 清单 + 主动删 + 验证删** | 收敛器新增一段:对清单里每个名字,若 `<bin>/<name>` 存在(普通文件或 symlink)则 `strict_discard`(FLY-1577 现成函数,`rm` 成功且 lstat 确证消失才算),同时删 `<state>/state/converge-adoptions/<name>` marker;删成功打一行日志 + 一次 alert;删不掉 → alert + rc=1 | **采用**。与 plan 一致;复用现成的「证明删除」原语 |
| (b) 推到 T6 | — | plan 已否:S2 可能在 T6 之前就要回滚 |
| (c) 泛化「不在 FILES 就删」 | 扫 bin 目录删未知普通文件 | **否**:bin 里有大量人手留下的 `.bak-*`、`.tmp.*`、`__pycache__`、`discord-reply-enforcer.py` 等非收敛器所有的文件(§2 实测 68 项),泛删是事故;hygiene 扫描本来就是只读 |

**packaged 分支的 retired 语义**:plan §10.2 注末段「packaged 分支可以在当前版本就把这个名字视为 retired」——
本单把 `raya-cos.sh` 写进 packaged 分支的 `RETIRED_FILES`,monorepo 分支的 `RETIRED_FILES` 初始为空
(forward rollback 时才把 `raya-cos.sh` 从 `FILES` 挪进去)。这样 ⑤ 的阴性测试直接由 retired 段实现,
不是靠「不列就不管」的 vacuous pass。

### 4.3 ④ 实机验证怎么做才算「实机」

| 层 | 方法 | 证明了什么 | 证明不了什么 |
|---|---|---|---|
| **A 策略复演(设计阶段已做)** | 从 `~/.codex-raya/.../0.156.1/bin/codex` 按字节切出内嵌 `seatbelt_base_policy`(311 行),按 Codex 的 workspace-write 组合规则拼上 `(allow file-read*)` + `WRITABLE_ROOT_0` + network,用 `/usr/bin/sandbox-exec -f` 在临时工作区 cwd 下跑 shim | 该版本沙箱的**文件系统策略**允许:exec `<state>/bin/raya-cos.sh`、读 `~/Dev/flywheel/packages/raya-cos/dist/**`、写 cwd 下 `state/cos/`;并用负对照证明策略在生效(写 `$HOME`、写 `~/Dev/flywheel` 被拒) | Codex 进程自己在策略之外做的事(如 `shell_environment_policy` 对 PATH 的裁剪、approval 流程)。这两点分别由 `flywheel-lead.sh:8` 的 PATH 与 full-access 的 `default_tools_approval_mode="approve"` 覆盖,但**不是本复演证明的** |
| **B 真 `codex exec`(实施/QA 阶段)** | 隔离 `CODEX_HOME`(池快照,不动共享 auth)+ `-s workspace-write -C <临时工作区>`,让模型执行 `~/.flywheel/bin/raya-cos.sh status` 并原样回显 | 模型侧一次完整回合能跑通 shim(含 PATH/env 策略) | 不是 Raya 本体的 CODEX_HOME / MCP 配置 |
| **C 生产证据(不属于 S2)** | S3 激活后,cos operation store 出现经 shim 产生的新条目 | 真 Raya 真用上了 | 只属于 plan §10.2 B5 / §9.1 前置 3,**不能写进 S2 验收**(否则重造依赖环,与 R4#2 同病) |

本单验收 ④ = A(设计已做,施工时按 research §5 的脚本复跑并留档)+ B。

## 5. 未决点(非阻塞,已用 `ask` 交 Lead;默认按下面的处置继续)

1. **`flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh` 要不要在 S2 就进 `RETIRED_FILES`?**
   plan §10.2 注说 retired 机制「同时解决 §12.1 第 2 条」(就是这个文件),但 plan §9.2 T6 又把
   删它列为「宿主侧收尾,需 founder 授权」。两处不一致。**默认:S2 不列它**(范围纪律;T6 一行即可加),
   S2 只交付框架 + `raya-cos.sh` 在 packaged 分支的 retired 条目。Lead 若裁定「现在就列」,
   实施节点加一个名字、一条测试即可。
2. **测试文件放哪**:扩展 `converge-flywheel-bin.test.sh`(C13–C16)覆盖收敛/retired;新建
   `scripts/__tests__/raya-cos-shim.test.sh` 覆盖 shim 自身解析,并在 `ci.yml` FLY-1389 批次里字面登记
   (`ci-shell-suite-enumeration.test.sh` 要求)。不是 Lead 问题,本单直接定。

## 6. 本单明确不做

- 不改 Raya 仓、不改人设(S3);不改 `persona-projection`(S4,已由 FLY-2696 落地 dormant);
- 不碰 `updater-raya-deploy.sh` / `raya-standard-migration.sh` / 巡检(T1–T5);不动 launchd(T6);
- 不把 `raya-cos` 加进 `PO_PACKAGES` / packaged allowlist / compat mirror(plan §6.2 🔴 裁定);
- 不部署、不重启:S2 合入后由既有班车(`update-flywheel.sh:1567 updater_converge_bin` /
  `restart-services.sh:3297-3299` pre-kickstart)把 shim 收敛进 `~/.flywheel/bin`,无需任何人手动作。
