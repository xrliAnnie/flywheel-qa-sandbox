# FLY-1999 runner 环境白名单构造 — 实施计划

Issue: FLY-1999 (https://linear.app/geoforge3d/issue/FLY-1999/envbug-runnerlead-环境继承污染codex-home-指向-infra-botflywheel-codex-binpath)
日期: 2026-08-23
基于: research.md

## 0. 一句话

把 runner pane 的启动环境从"继承 tmux server 的全套 env − 6 个名字"改为"**从零白名单重建**":OS 基底 ∪ TMUX 身份 ∪ 本次 launch 显式注入的协议名——不在名单即不存在;辅以 server 出生点卫生与 Bridge boot 存量清扫,三层收口。

## 1. 范围与不变量

**改**:

- `packages/claude-runner/src/TmuxAdapter.ts` — `buildAmbientSafeWindowCommand` 由 denylist(`env -u` 六名)升级为 allowlist 重建(`env -i` + `${VAR+"VAR=$VAR"}` 逐名保留,**惯用法必须落在 sh 脚本文本内**,见 §2.2);入口 `execute()` 改经结构化 `appendPaneEnv(name, value)` helper 注入每窗 env——同一来源同时生成 tmux `-e` args 与 allowlist 名集合(不做事后 argv 解析)。
- v0.1.1 marker compat 路径:`FLYWHEEL_MARKER_DIR` 由 session `set-environment` 改为**每窗显式 `-e`** 注入(现状走 session env,洗法会静默丢弃它 → SessionEnd hook 回落默认目录而 watcher 看自定义目录,legacy completion 永不到达——R1 review 抓出的既有消费者)。
- `packages/claude-runner/src/codex-runner-tui-window.ts` — Codex runner TUI 窗命令套用同款洗前缀(其命令串内的显式 `CODEX_HOME="<per-runner home>"` 赋值在洗后 exec 层,天然保留;该 home 是共享账号凭据的隔离快照,不代表每 runner 独立账号/登录)。
- 三个 server 出生点的出生 env 卫生,**按调用面分型**(R1 review 修正,见 §2.3):rescue CLI 内部只对真正执行 tmux create 的 exec 应用 canonical env(rescue 自身的 `FLYWHEEL_TMUX_RESCUE_*` 控制契约保留);TS 侧两个非-rescue 出生点(`tui-window.ts`、`codex-runner-tui-window.ts`)提供 **replace-not-merge** 的 exec seam(现有 exec 封装把 `opts.env` merge 回 `process.env`,不能直接复用)。
- Bridge boot 幂等 scrub rider:范围 = global env + **全部受管 session**(`flywheel` + 从 projects 派生的每个 sanitized `runner-*` session——只清 global/flywheel 会漏生产 runner session 自己攒的 env);名单 = 读取 `show-environment` 现有名 → 变量名校验 → 按 exact names ∪ 禁止前缀(`FLYWHEEL_CODEX_LEAD_`/`FLYWHEEL_LEAD_`/`DISCORD_` 等——**前缀在读出的名字上过滤,`set-environment -u` 不吃 glob**)∪ `.env` 变量名解析(路径与 wrapper 一致取 `${FLYWHEEL_STATE_DIR}/.env`)过滤 − 保留集;逐 scope 清名 + 设 canonical PATH。挂点 = `startBridge()` 最早同步 boot 段、任何 runner/Lead child spawn 之前。目标 server 必须先由 Bridge 自身环境/受管 session 证明归属;证明不了就 fail-closed 跳过。**零新 timer、零新 flag**。

**不改(显式)**:

- Claude 路径的 launch 时序/gate token 机制/`-e` 注入语义逐字保留——只换 exec 前缀的 env 策略;
- `codex-tmux` daemon env(`buildDaemonEnv`,已是白名单)零改动;
- `~/.flywheel/.env` 的内容与 `set -a` 装载模式(Bridge/Lead 自身需要;瘦身归 FLY-39);
- `~/.local/bin/codex` symlink(运维复位,FLY-513/1955 域;runbook 一行);
- Claude runner 的 codex 共享 `~/.codex` 随 codex-profile 轮转的语义(per-execution 隔离归 FLY-1893);
- 无新 feature flag(Annie 铁律):洗法无条件生效,与 FLY-1715 同姿态。

## 2. 设计细节

### 2.1 pane allowlist(单一来源,导出常量 + 每 launch 动态段)

```
RUNNER_PANE_BASE_ALLOWLIST(静态,与 codex-home.ts SAFE_BASE_ENV 对齐并注明差异):
  PATH HOME SHELL USER LOGNAME LANG LANGUAGE TERM TZ TMPDIR TMP TEMP PWD
  COLUMNS LINES EDITOR VISUAL PAGER
  XDG_RUNTIME_DIR XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME
  LC_ALL LC_CTYPE LC_COLLATE LC_MESSAGES LC_MONETARY LC_NUMERIC LC_TIME
  TMUX TMUX_PANE
动态段 = 本次 execute()(经 appendPaneEnv)实际注入的 -e 名字集合
  (含 transportSpawnConfig.env keys、extraPaneEnv() keys、BASH_MAX_TIMEOUT_MS、
   PROJECT_NAME;置空注入名如 DISCORD_IDENTITY_MODE= 保持置空语义)
```

与 SAFE_BASE_ENV 的刻意差异:+`TMUX`/`TMUX_PANE`(pane 身份);不含 proxy 族(runner 生产环境无 proxy 依赖;若未来需要,走显式注入而非继承——比在 sh 里复刻 userinfo 洗净更简单安全);不含 `HOSTNAME`(macOS 不设)。`SSH_AUTH_SOCK` 明确不在(auth-capable,git=https 不需要)。

### 2.2 生成规则(注入面收口)

**展开位置铁律(R1 BLOCKER-1)**:`${VAR+"VAR=$VAR"}` 只有出现在 **sh 脚本文本**里才会被展开;放进位置参数(`exec "$@"` 的 argv)会原样传给 `env`——真实 `/bin/sh` 探针已证。因此两条路径的成品形状钉死为:

- **direct**:`sh -c 'exec env -i ${PATH+"PATH=$PATH"} … "$@"' <sentinel> <binary> <args…>` —— env 重建段在脚本文本,binary/args 仍只走位置参数;
- **gated**:在现有 gate 脚本文本内部,把末尾 `exec "$@" ["$p"]` 替换为 `exec env -i ${…} "$@" ["$p"]` —— gate 等 token/prompt-file 逻辑逐字保留。

其余规则:

- 逐名校验 `^[A-Za-z_][A-Za-z0-9_]*$`,不合格 **fail-loud 拒 launch**(只有校验过的**名字**进 shell source;值永不进模板/argv,由 pane shell 从自身 env 展开);
- unset 保持 unset(`${VAR+…}` 词消失),显式置空注入(`-e K=`)保持空串——两态语义有测试钉住;
- 名集合去重、排序(命令字节稳定,受 `TMUX_COMMAND_BUDGET_BYTES=12288` 校验;**静态 31 名段实测 955 bytes**(R1 实测,修正原 ~700B 估计),动态段/gate 脚本/长路径继续叠加——S1 用生产 envArgs 构造器生成全部动态名后对 direct/gated、Kimi 最大 `NODE_OPTIONS`、长合法 cwd/gate/prompt 路径分别跑既有 `assertLaunchCommandBudgets`,oversize 必须在 durable launch commit 前 fail-loud);
- gate 与非 gate 两条路径共用同一 env 重建段构造函数。

### 2.3 出生点卫生(R1 BLOCKER-3 修正:控制环境与出生环境分离)

canonical PATH 单一来源常量 = `<绝对 HOME>/.local/bin:<绝对 HOME>/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`(与 bridge-wrapper 现值一致;**用展开后的绝对 HOME,不用字面 `~`**)。按调用面分型:

- **rescue CLI 路径**(TmuxAdapter ensureSession):**不能**整体 wash rescue 的 spawn env——rescue 依赖 `FLYWHEEL_TMUX_RESCUE_*` 调优/告警契约,自身 export `_TMUX_RESCUE_*` 内部变量,且其 argv validator 要求 create argv 以 `tmux` 开头。改为在 rescue **内部**、仅对 `create_argv`/`guarded_create` 真正执行 tmux create 的 exec 应用 exact canonical env(显式扩展 rescue 的受测协议);rescue 控制项保留,内部 `_TMUX_RESCUE_*` 不得落入新 server global env(测试钉住)。
- **TS 侧两个非-rescue 出生点**(`tui-window.ts:136`、`codex-runner-tui-window.ts:749`):现有 exec 封装把 `opts.env` **merge** 回 `process.env`(TmuxAdapter.ts:2061-2078/2123-2138),`codex-runner-tui-window` 的 spawn options 甚至没有 env 参数——各自提供 **replace-not-merge** 的 exec seam,以 `env -i PATH=<canonical> HOME/SHELL/USER/LOGNAME/LANG/TERM/TMPDIR=<现值>` 语义起首条 `new-session`。fail-open 语义不变。
- 覆盖分支:server absent(出生走 washed env)与 server 已在(无副作用)两分支都有测试;显式 `-S` socket/`FLYWHEEL_TMUX_SOCKET_OVERRIDE` 不漂移。

### 2.4 Bridge boot scrub(存量,R1 HIGH-4 修正)

- **归属推导围栏(2026-08-23 QA 返工裁决)**:`FLYWHEEL_TMUX_SOCKET_OVERRIDE` 仅是绝对路径的显式运维改向授权,不是 scrub 生效前提;相对 override 直接拒绝。未设置时先从当前 `TMUX` 的绝对 socket,否则从绝对 `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default` 推导目标;随后只读 `list-sessions`,必须与本 Bridge projects 精确派生出的至少一个 `runner-<projectName>` session 相交才证明归属。证明失败时在读取 `.env` 或任何 `set-environment` 前 fail-closed 跳过并记日志。由此生产存量 default server 上的 `runner-flywheel` 可继续触发清扫;529 的 `runner-test-slot-*` 对生产 server 不相交,普通单测也不相交,天然拒绝。生产 wrapper 不再为了 scrub 人工写默认 override;QA slot 使用 tmux 原生 `TMUX_TMPDIR=${SLOT_DIR}` 路由,并在 Bridge launch boundary 清除继承的 `TMUX` 与 override,让 `ensureRunnerSession`、adapter、reaper 及 boot scrub 的所有 tmux 调用落在同一个 slot-local default socket。
- **范围**:global env + 全部受管 session = `flywheel` ∪ 从 projects 配置派生的每个 `sanitizeTmuxName("runner-<projectName>")`(run-infra.ts:975)。只清 global/flywheel 会漏生产 runner session 自己保存的 env(secrets/身份/旧 PATH 照样注入新窗)。
- **名单构成**:先 `show-environment`(对应 scope)读出**现有名字** → 逐名走同一变量名校验 → 命中即清,判据 = exact names(`AMBIENT_IDENTITY_DENYLIST` 六名、`CODEX_HOME`、`FLYWHEEL_CODEX_BIN` 等)∪ **禁止前缀**(`FLYWHEEL_CODEX_LEAD_`/`FLYWHEEL_CODEX_TUI_`/`FLYWHEEL_LEAD_`/`DISCORD_`——前缀是对读出名字的过滤逻辑,`set-environment -u` 不吃 glob)∪ `.env` 变量名解析(路径与 wrapper 一致:`${FLYWHEEL_STATE_DIR}/.env`,兼容 `export K=V`/`K=V`/引号值,**只读名**,值不进内存/日志)− 保留集(OS 基底);
- 每 scope 清名后设 canonical PATH(global 与各受管 session 都设——pane allowlist 会合法保留 PATH,所以 session 层旧 PATH 必须在这里修,否则 canonical PATH 兑现不了);尽可能单个 tmux command queue 完成每 scope;
- server 不存在/tmux 不可用 → 跳过(fail-open,记一行结构化日志);幂等(重复跑零 diff);
- 归属 probe + 全部 scope 读写共享一个 10 秒 wall-clock deadline;超时即停止剩余 scope,不为 scope 数量线性放大 boot 阻塞;
- **挂点**:`startBridge()` 最早同步 boot 段(plugin.ts:4243 入口内),任何 runner/Lead child spawn 之前;不进任何周期 tick。scrub 与并发 new-window 的竞态由 pane allowlist 兜底(最终 child boundary 始终安全)——测试覆盖该并发场景。

## 3. 实施步骤(TDD:每步 RED → GREEN)

1. **S1 allowlist 前缀生成**(单元,vitest):模板生成、名字校验拒绝集(空名/带 `=`/带 `-`/unicode)、`${+}` 惯用法形状、去重排序;字节预算:用**生产 envArgs 构造器**生成全部动态名后,对 direct/gated、Kimi 最大 `NODE_OPTIONS`、长合法 cwd/gate/prompt 路径分别跑既有 `assertLaunchCommandBudgets`(静态段实测 955B 为基线),oversize 必须在 durable launch commit 前 fail-loud。
2. **S2 真 sh 执行对照**(单元+集成):用 crafted 污染 env(镜像 research §1.2 名单、dummy 值)真实执行**三种成品命令形状**——direct、gated+prompt、gated-no-prompt——断言产出 env **精确等于**期望集(逐名相等,不是 absence 检查);空格/引号/换行值的协议变量存活;unset vs 置空两态;覆盖 macOS `/bin/sh`。
3. **S3 TmuxAdapter 接线**:`execute()` 改经 `appendPaneEnv(name, value)` 结构化注入(同一来源生成 `-e` args 与 allowlist 名集合);marker compat 改每窗 `-e FLYWHEEL_MARKER_DIR`(含无 hook server + 自定义 marker dir 的真实 child/hook 测试);**显式更新三处结构假设测试**:`TmuxAdapter.test.ts:65-130`(六名删除/未列秘密保留断言)、`KimiTmuxAdapter.test.ts:123-129` 与 `AntigravityTmuxAdapter.test.ts:69-75`(`launchedBinary` 解析器跳过 `env -u` 的假设);其余 Claude 路径测试回归(launch 时序/gate 逐字)。
4. **S4 codex-runner-tui-window 套用**:显式 CODEX_HOME 保留断言。
5. **S5 出生点卫生**(§2.3 分型):rescue 内部 create-exec 的 canonical env(真 tmux 隔离 `-S` socket:polluted rescue 进程出生 → server global env 精确集断言;`_TMUX_RESCUE_*` 内部变量不落入 global env;`FLYWHEEL_TMUX_RESCUE_*` 控制契约回归);TS 两位点 replace-not-merge seam;server absent/已在两分支;socket override 不漂移;阳性对照:不经卫生路径出生必须脏。
6. **S6 boot scrub**:.env fixture 名解析(值零泄漏断言——扫 scrub 全部输出/日志无 fixture 值);真 tmux 污染 server(global + 仿真 `runner-*` session env)→ scrub → 全 scope 名单清零 + PATH canonical + 幂等重跑零 diff;保留集不动(阴性对照);无 override + 自有默认 socket 阳性断言必须产生 `set-environment` 且命中秘密名,无 override + foreign/529 session 阴性断言必须零 mutation/零 `.env` 读取,相对 override 拒绝;10 秒聚合预算;scrub 与并发 new-window 竞态下 child boundary 仍安全。
7. **S7 dropped-name 消费者 sweep**(research §5 硬要求):**以 R1 已抓出的 `FLYWHEEL_MARKER_DIR`(scripts/hooks/flywheel-session-end.sh:21-24 + core/constants.ts:25-31)为第一行**,全仓三态结论表落 `qa/` 文档;发现"需补注入"名则回改 S3 名单。
8. **S8 真机 E2E(验收 1/2/3)**:按 research §7 表执行,含阳性/阴性对照;凭据用隔离假 home(`FLYWHEEL_CODEX_SOURCE_HOME`),不碰真 auth。
9. **S9 全仓门**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 相关 shell harness;宿主既有环境项(headless Terminal.app 等)如实留证不伪报。

## 4. 验收(= issue 四条,测试映射见 research §7)

1. 新 spawn runner 内 codex 实读凭据身份 == 预期身份(解码 auth email 断言)+ 阳性对照;
2. runner env 无 OPENAI_API_KEY 等非必需秘密:pane env 名集合 == allowlist 精确集(显式豁免清单之外零秘密);
3. `codex-profile use` 切号后新 spawn 随号;
4. 污染源头书面结论(exploration §3 + research §1-3,已交付)。

## 5. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| allowlist 漏真依赖 → runner spawn 挂/功能哑 | 中 | S7 全仓 sweep + S8 真机 E2E 全流程(onboard→comm→git push→codex 调用);失败形态是 session_failed 可见,不是静默 |
| `${+}` 展开位置放错(argv 而非脚本文本)→ 洗法形似而实哑 | 已消除 | §2.2 钉死两条路径成品形状(R1 BLOCKER-1);S2 对三种成品命令真实执行断言,不允许只匹配命令文本 |
| tmux 命令超 12KB 预算(名单加长) | 低 | 名字不带值,静态段实测 955B;S1 用生产构造器 + 最坏形状跑 `assertLaunchCommandBudgets`;超限走既有 LAUNCH_COMMAND_OVERSIZE fail-loud(durable commit 前) |
| scrub 误删 canonical 保留名 | 低 | 保留集扣除 + 阴性对照测试 |
| QA/单测 Bridge 误清生产默认 tmux server | 高(已被 QA 实证) | 未显式 absolute override 时先以本次 projects 的精确 `runner-*` session 证明归属;不相交即在读 `.env` 前拒绝;529 清除继承的 `TMUX`/override,以 slot-local `TMUX_TMPDIR` 统一路由所有 tmux 调用并精确 teardown |
| 存量已开 pane 带病(无法追溯) | 确定 | 诚实边界:等自然换代;ship 后独立 QA 只对**新 spawn** 断言 |
| founder 手动新窗从此拿最小 env(拿不到 .env 秘密) | 确定(行为变化) | 写入 ship note:需要时 `source ~/.flywheel/.env`;换来的是手动窗不再默认带 infra-bot 身份 |

## 6. Ship / QA 边界

- 合并生效面:pane 洗法随新 spawn 即生效(Blueprint/adapter 现读);boot scrub 需 Bridge 随班车重启后首跑——**不为本单投重启票**(FLY-1959:正常部署只来自 00:00/12:00 班车)。
- ship 后独立 QA(DAG QA 节点):不设 override 的生产式 Bridge boot 对自有 default socket 必须实际清扫,同时 529 slot/foreign socket 必须零 mutation;529 再从真实 Bridge spawn 一个 runner,断言 ensure/launch/teardown 都命中 `${SLOT_DIR}/tmux-<uid>/default`;复跑验收 1/2/3 断言 + `tmux show-environment -g` 复核 scrub 已跑;`~/.local/bin/codex` symlink 复位作为**运维 runbook 项**一并核(非代码验收)。
