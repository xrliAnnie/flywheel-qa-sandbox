# FLY-2301 529 房台架支持 Codex 形状常驻 Lead — 调研
Issue: FLY-2301 (https://linear.app/geoforge3d/issue/FLY-2301/529-房台架能力-slot-常驻-lead-台架支持-codexcloud-形状raya-脑一族plist-argvenv)
日期: 2026-09-03
基于: exploration.md

## 1. 调研目的

exploration.md 选定「形状分支 + 通用 `codex-lead.sh` + 模板渲染 slot 固定 wrapper」(选项 B)。本文逐条核实该方案依赖的事实、量出硬边界、锁定实现合同,给 plan.md 直接引用。

## 2. 逐条核实(文件:行 + 结论)

### 2.1 Codex TUI runtime 的必填环境(决定 slot `.env` 最小集)

`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:531-543` `req(...)`:
`FLYWHEEL_LEAD_ID / FLYWHEEL_PROJECT_NAME / FLYWHEEL_LEAD_KEY / FLYWHEEL_LEAD_BACKEND / FLYWHEEL_LEAD_IDENTITY_DIGEST / DISCORD_EXPECTED_BOT_USER_ID / DISCORD_BOT_TOKEN`(以上 7 个由 `canonical-lead-identity.sh` 从 projects 行解析后 export,launcher 不需外供)、`FLYWHEEL_LEAD_CHAT_CHANNEL_ID`、`FLYWHEEL_CODEX_LEAD_STATE_DIR`(codex-lead.sh 自算)、`FLYWHEEL_CODEX_BIN`、`CODEX_HOME`、`FLYWHEEL_COMM_DB`;`RAYA_METRICS_DIR` 仅 leadId==raya。TUI 入口再加 `FLYWHEEL_CODEX_TUI_CWD`(`codex-lead-tui-runtime.ts:118`)。`FLYWHEEL_BRIDGE_URL/FLYWHEEL_API_TOKEN` 仅 outbound=bridge 必填。
`canonical-lead-identity.sh:49-70`:必须有可读的 `FLYWHEEL_COMM_CLI`;`:136-138` 断言 `FLYWHEEL_LEAD_MODEL/EFFORT/MODEL_CONTEXT_WINDOW` 若已设必须等于 canonical(slot 行不写 model → 不设)。
`codex-lead-tui-runtime.ts:442-448` `requirePersona`:`FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES` 至少一个可读非空文件。
`codex-lead.sh:145-146`:tui 模式 `FLYWHEEL_CODEX_TUI_CWD` 必填,先 `ensure-home` 再 `ensure-daemon`。

⇒ **slot `.env`(codex 形状)最小外供集**:`TEST_BOT_TOKEN_N`(既有)、`FLYWHEEL_PROJECTS_FILE`、`FLYWHEEL_COMM_CLI`、`FLYWHEEL_COMM_DB`、`FLYWHEEL_LEAD_CHAT_CHANNEL_ID`、`CODEX_HOME`、`FLYWHEEL_CODEX_BIN`、`FLYWHEEL_CODEX_LEAD_MODE=tui`、`FLYWHEEL_CODEX_TUI_CWD`、`FLYWHEEL_CODEX_LEAD_OUTBOUND=direct`、`FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES`,再加既有 `qa_slot_launch_env_json` 环境图(BRIDGE_URL / TEAMLEAD_* / FLYWHEEL_STATE_DIR / FLYWHEEL_DELIVERY_SECRET_PATH / LEAD_WORKSPACE / 告警隔离 env / generalized scrub 名)。**不得**含 `LEAD_ID/PROJECT_NAME`(`codex-lead-runtime.ts:590-599` 冲突即抛)与 `FLYWHEEL_PROJECTS`。

### 2.2 能力层级(tier)与 projects 行形状

- `ProjectConfig.ts:789-812`:`codexProfile ∈ {companion, write-capable, full-access}`;认可层级 = `companion === true` 或显式 `codexProfile`。
- `resident-codex-lead-roster.ts:12-31`:心跳观察者只在 `codexResidencyPatrol:true && backend:"codex-app-server" && canSpawnRunners:false && (companion||codexProfile)` 时武装。
- 生产实况(`~/.flywheel/projects.json`):Mufasa = `companion:true, canSpawnRunners:false, codexResidencyPatrol:true`(read-only 陪伴层);codex-infra-bot = `codexProfile:"full-access"`。
- `codex-lead-runtime.ts:754`:`FLYWHEEL_CODEX_LEAD_PROFILE` 缺省 `companion`;`:778-792` full-access 必须 `sandbox=workspace-write`;`:814` full-access 还要 `FLYWHEEL_CODEX_LEAD_PROJECT_DIR`(codex-lead.sh 已 export)与 lead-actions MCP(`codex-lead-tui-home.sh:513-533` 要 `FLYWHEEL_LEAD_ACTIONS_MAIN_JS/NODE_BIN/STATE_DIR`);`resolveFullAccessProjectRoot`(`:455-509`)拒绝 project root 与 `~/.flywheel`/state dir/CODEX_HOME 重叠 —— slot 的 `lead-workspace`、`cdxh/<agent>`、`q/<slot>/state/...` 互为兄弟,不重叠。
- `lead-identity.ts:262-263`:`companion:true` ⇒ role=companion。

⇒ **锁定**:codex 形状 slot 行 = `backend:"codex-app-server", canSpawnRunners:false, codexResidencyPatrol:true` + 层级字段;层级由 slot 条目 `codexProfile` 决定,缺省 `companion`(写 `companion:true`,Mufasa 同形,零额外依赖);`full-access` 时写 `codexProfile:"full-access"` 并在 `.env` 追加 `FLYWHEEL_CODEX_LEAD_PROFILE=full-access`、`FLYWHEEL_CODEX_LEAD_SANDBOX=workspace-write`、`FLYWHEEL_LEAD_ACTIONS_MAIN_JS=${REPO_ROOT}/packages/teamlead/dist/lead-backends/codex/lead-actions/lead-actions-main.js`、`FLYWHEEL_LEAD_ACTIONS_NODE_BIN=$(command -v node)`、`FLYWHEEL_LEAD_ACTIONS_STATE_DIR=<state dir>`。真机验收跑 companion;full-access 只做 hermetic 投影断言(边界写进 plan)。

### 2.3 state dir 与 `FLYWHEEL_STATE_DIR`

- `codex-lead.sh:81`:`STATE_DIR="${HOME}/.flywheel/state/codex-lead/${SAFE_PROJECT}__${SAFE_LEAD}-${IDENTITY_HEX}"`。
- 生产 `~/.flywheel/.env` **无** `FLYWHEEL_STATE_DIR` 键(`grep -n '^FLYWHEEL_STATE_DIR=' ~/.flywheel/.env` 空);生产三个 Codex launcher 各自硬编码 state dir 且不经 codex-lead.sh;`codex-lead.sh` 自述「Dormant direct launcher retained for operator QA」。
- 改为 `STATE_ROOT="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"` 后,生产路径逐字节不变;slot(plist 注入 `FLYWHEEL_STATE_DIR=${SLOT_DIR}/q/<slot>`)落 `${SLOT_DIR}/q/<slot>/state/codex-lead/<key>`。台架能用同一 hex 算法预知该目录(验活/就绪要读 `brain/heartbeat.json`)。

### 2.4 exact identity 探针可行性

- 生产判据 `resident-codex-lead-recover.sh:108-160`:`ps -p P -o command=` 恰一个 token 以 `/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js` 结尾且前一 token basename 为 `node`;`ps eww -p P -o command=` 的空白分词里含 `CODEX_HOME=<expected>`。
- 本机实测:对生产 Mufasa runtime(launchd 子进程)`ps eww -p <pid> -o command= | tr ' ' '\n' | grep -c '^CODEX_HOME='` = 1 ✅;对本会话沙箱内自起的子进程 = 0(Claude Bash 工具沙箱限制 `KERN_PROCARGS2`,与 launchd 子进程无关)。⇒ 529 房内(launchd 起的进程)探针成立;**hermetic 测试不能依赖执行者 shell 未被沙箱**。
- CI 全部 job `runs-on: ubuntu-latest`(`ci.yml` 9 处):Linux 下 `/proc/<pid>/environ` 可读。⇒ 探针 helper 先试 `/proc/P/environ`(NUL 分隔),不存在再 `ps eww`。两条路径的输出都规范化为「NAME=value 行集合」再匹配。

### 2.5 CODEX_HOME 铸造

- `codex-lead-tui-home.sh:577`:`auth.json` 必须已存在,脚本**绝不拷凭据**;`:580-582`:daemon 只认 `$CODEX_HOME/packages/standalone/current/codex`,绝不自动安装;`:770`:zombie 恢复路径按 `$HOME_DIR/packages/standalone/` 前缀识别自家 daemon 可执行文件 ⇒ realpath 必须在 slot home 内,符号链接到源 home 不满足。
- `~/.codex-259-qa`:standalone `releases/0.140.0-aarch64-apple-darwin`(436M),`current` 是绝对路径 symlink;`auth.json` 2026-06-15 之后未写。
- `/tmp` 与 `/Users` 同一 APFS 卷(`/dev/disk3s5`);`cp -Rc`(clonefile)本机实测目录克隆 OK,零额外空间。Linux `cp` 无 `-c` ⇒ 先 `cp -Rc`,失败回落 `cp -R`。
- **AF_UNIX 路径上限 103 字节**:`${SLOT_DIR}/state/codex-lead-home/<agent>/app-server-control/app-server-control.sock` = 106 ✗。改为 `${SLOT_DIR}/cdxh/<agent>` → `/tmp/flywheel-test-slot-4/cdxh/flywheel-test-4/app-server-control/app-server-control.sock` = 90 ✓;铸造时对最终 socket 路径长度做 ≤100 的 fail-loud 守卫。
- 生产 Lead 凭据拒绝集:`~/.codex-mufasa`、`~/.codex-infra-bot`、`~/.flywheel/raya/codex-home`(与 `resident-codex-lead-recover.sh:85-95` 的 `EXPECTED_CODEX_HOME` 集合一致)。`~/.codex`(founder 个人 / runner 源 home)不在拒绝集但不作缺省 —— `codexSourceHome` 必须显式给出。

### 2.6 tmux 路由与可见窗口

- `tui-window.ts:149-165`:`tmux new-session -Ad -s flywheel` + `new-window -n <project>-<leadId>`,server 由 `buildTmuxServerBirthEnvironment()` 决定,后者读 `TMUX_TMPDIR`(`tmux-environment-scrub.ts:91`)。
- 529 slot Bridge 已用 `TMUX_TMPDIR=${SLOT_DIR}` 把一切 tmux 调用钉在 slot server(`test-deploy.sh:812`);slot server socket = `${SLOT_DIR}/tmux-$(id -u)/default`(`test-teardown.sh:666`),拆房时被退役(`:951`)。
- ⇒ codex 形状 plist env 必含 `TMUX_TMPDIR=${SLOT_DIR}`;窗口断言 = `tmux -S ${SLOT_DIR}/tmux-<uid>/default list-windows -t =flywheel -F '#{window_name}'` 含 `<project>-<agent>`。

### 2.7 就绪与心跳

- Codex 后端不写 `.inbox-ready-*` lease(`grep -rn inbox-ready packages/teamlead/src/lead-backends/codex/` 为空)。
- `codex-lead-tui-runtime.ts:884` 线程就绪后 `residencyLifecycle?.online()`;`resident-codex-lead-lifecycle.ts:93,213-232` 原子写 `<stateDir>/brain/heartbeat.json`(`v:1, generationId, threadId, processPid, carrierInstanceId, state, updatedAt…`)。`carrierInstanceId` runtime 自产(`codex-lead-runtime.ts:1537`)。
- ⇒ codex 就绪判据 = heartbeat `.state=="online" && .processPid==launchd pid`;验活判据 = exact identity(2.4)+ heartbeat `.processPid==P`;收敛判据(演练)= 新 pid/lstart + `generationId` 与 `carrierInstanceId` 均变化(`resident-codex-lead-recover.sh:256-273` 同式)。

### 2.8 host tmux 选择门

`host-tmux-selection-gate.sh:197-200`:`gate|verify <carrier>`,carrier 仅限字符集校验,无闭合集(闭合集只在 census)。`FLYWHEEL_HOST_TMUX_MOUNT_POINT` 仅入收据。Claude slot 今日已用 slot state dir 过 `gate lead`。⇒ slot codex wrapper 用 `gate codex-tui` / `verify codex-tui`,mount point 写模板路径。

### 2.9 拆除面

- `qa_launchd_stop_registry`(`qa-launchd-lead.sh:198-204`)只 bootout。runtime 退出会 `killTuiWindow`(`codex-lead-tui-runtime.ts:1078,1096`),但 **不停 daemon**;daemon socket 在 CODEX_HOME 内,FLY-2174 的 Bridge 收割器只盘点 `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT`(`test-deploy.sh:808-810`)看不见它。
- `codex-lead-tui-home.sh:951`:停法 = `CODEX_HOME=<home> <bin> remote-control stop --json`。
- ⇒ registry 条目加 `carrier` + `codexHome` + `codexBin`;stop 时对 codex 条目先 bootout(runtime 退,窗口收)再 `remote-control stop`,最后既有 `rm -rf SLOT_DIR` 带走 home。旧条目缺新键 → 原路径。

### 2.10 既有守卫与 CI 挂点

- `fly1663-qa-launchd.test.sh`(`ci.yml:352`):stub launchctl/tmux,断言 plist 片段而非全文。
- `test-deploy-fly1389.test.sh`(`ci.yml:592`):真 test-deploy/teardown + 假仓 + python `launchctl` 替身(`:330-372`,真的 `Popen(job["ProgramArguments"], env=EnvironmentVariables)`)+ stub `flywheel-lead-wrapper-v2.sh` + stub `claude-lead.sh`。codex 形状可完全复用:加 slot 条目 + stub `codex-lead.sh`(`exec node <假 runtime.js>`,假 runtime 写 heartbeat 并驻留)。
- `test-deploy-multilead.test.sh` A1/A2:`qa_multilead_build_projects` 9 参调用与参考 jq 逐字节相同 —— 新增第 12 个可选参数不影响。
- `host-tmux-selection-s0-scope.test.sh:14-25` / `path-hygiene.sh:150-175`:列出的文件必须含 native-first PATH 声明;新增 wrapper 模板若含 PATH 声明需加入两处清单(生产三个 Codex wrapper 均在列)。
- `raya-resident-carrier.test.sh` 断言生产 Raya carrier 闭合集;本单不动那三处权威。

### 2.11 FLY-2224 / FLY-2259 关系确认

- FLY-2224「529 造不出 codex 工人」是 runner 派工链(design gate → implement 节点)的问题(memory `MEMORY-qa-recipes.md:99-116`),与常驻 Lead 载体无关;本单不解决也不阻塞。
- FLY-2259 B 路线(退旧脑、生产单实例切换)不进本单;本单交付后 FLY-2259 可在 529 房用 codex 形状 slot 验证 carrier 级行为。

## 3. 量化边界

| 项 | 值 | 出处 |
|---|---|---|
| daemon 控制 socket 路径 | ≤ 100 字节(留 3 字节余量) | AF_UNIX 103;2.5 |
| slot codex home 位置 | `${SLOT_DIR}/cdxh/<agent>` | 2.5 |
| standalone 克隆 | `cp -Rc` → 回落 `cp -R`;436M | 2.5 |
| plist env(codex) | 恰 5 键:HOME PATH FLYWHEEL_DIR FLYWHEEL_STATE_DIR TMUX_TMPDIR | 2.6 + exploration 2.2 |
| plist argv(codex) | 恰 2:`/bin/bash`, `<slot wrapper>` | exploration 2.2 |
| plist(claude) | 与今日字节相同(黄金快照) | 2.10 |
| 验活轮询 | 复用 `QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT=60 / INTERVAL=1` | qa-launchd-lead.sh:12-13 |
| 就绪预算 | 复用 `LEAD_READY_TIMEOUT_SEC`(缺省 120s) | test-deploy.sh |
| ThrottleInterval | 3s(既有) | qa-launchd-lead.sh:94 |

## 4. 决策锁定(供 plan 引用)

1. 形状来源:projects 行 `backend`;slot 条目字段 `backend` / `codexSourceHome` / `codexProfile`(可选)。
2. launcher:`packages/teamlead/scripts/codex-lead.sh`(改 1 行 state root)。
3. wrapper:`scripts/lib/qa-codex-lead-wrapper.template.sh` 渲染到 `${SLOT_DIR}/launchd/<agent>/codex-lead-wrapper.sh`;占位符仅 `@@PROJECT@@ @@LEAD_ID@@ @@PROJECT_DIR@@`,三者先过 `^[A-Za-z0-9][A-Za-z0-9._-]*$` / 绝对路径无控制字符校验。
4. 环境图单一来源:`qa_slot_launch_env_json`;claude 投影进 manifest,codex 投影进 `.env`。
5. 验活/就绪/收敛判据:2.4 / 2.7。
6. 拆除:2.9。
7. 守卫:claude plist 黄金快照 + codex 形状 hermetic E2E + 单元断言;CI 挂在既有两个 step。

## 5. 残余风险

- `~/.codex-259-qa` auth 过期 → 真机验收前操作者 `CODEX_HOME=~/.codex-259-qa codex login`;台架 `ensure-daemon` 会 fail-loud 并分类为 auth revoked(`codex-lead-tui-home.sh:984`)。
- 本会话 Bash 沙箱看不到子进程环境 ⇒ 我在本 worktree 里跑 codex 形状的 hermetic E2E 可能因探针假阴性失败;`/proc` 回落只救 Linux CI。plan 里把「探针不可用」作为显式失败原因输出(不是静默降级),并把该 E2E 标为需在非沙箱 shell(QA runner pane / CI)执行。
- `cp -Rc` 回落 `cp -R` 时 436M 拷贝约十几秒,在 `qa_slot_start_lead` 之前完成,不占验活预算。
