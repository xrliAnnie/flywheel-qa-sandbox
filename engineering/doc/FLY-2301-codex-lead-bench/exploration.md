# FLY-2301 529 房台架支持 Codex 形状常驻 Lead — 探索
Issue: FLY-2301 (https://linear.app/geoforge3d/issue/FLY-2301/529-房台架能力-slot-常驻-lead-台架支持-codexcloud-形状raya-脑一族plist-argvenv)
日期: 2026-09-03
基于: 无

## 1. 问题陈述

529 房(`scripts/test-deploy.sh` + `scripts/lib/qa-launchd-lead.sh`)的 slot 常驻 Lead 台架只会一种载体形状:**Claude wrapper-v2**。FLY-2259 QA(e906bf0b)只读核出三处与生产 Codex 常驻 Lead(Mufasa / codex-infra-bot / Raya,统称「Raya 脑一族」)的形状差异,导致任何 Codex/Cloud 形状的常驻 Lead 都进不了 529 房,也就无法在隔离房里验证 FLY-2259 这类「脑迁常驻」改动。

founder 直令(2026-09-03):做 A —— 改 529 台架,让它以后能测 CloudLead;不加开关;退旧脑那一半归 FLY-2259 B 路线。

## 2. 现状审计(逐处原文核过)

### 2.1 Claude 形状(既有,必须逐字节不变)

| 环节 | 文件:行 | 事实 |
|---|---|---|
| plist argv | `scripts/lib/qa-launchd-lead.sh:81` | `<wrapper> <manifest>` 两参(**没有** `/bin/bash` 前缀;生产 Claude plist 是 `/bin/bash <wrapper> <manifest>` 三参,见 `com.flywheel.lead.flywheel-flywheel-eng-lead.plist`) |
| plist env | `qa-launchd-lead.sh:82-92` | 恰 7 键:HOME / PATH / FLYWHEEL_DIR / FLYWHEEL_STATE_DIR / FLYWHEEL_PROJECTS_FILE / FLYWHEEL_WRAPPER_ENV_FILE / FLYWHEEL_SUMMARY_CONFIG_HOME(可选) |
| 其余 Lead 环境 | `test-deploy.sh:1441-1452` | 走 manifest 的 `launchEnvironment`(BRIDGE_URL / TEAMLEAD_API_TOKEN / FLYWHEEL_COMM… 等),由 wrapper-v2 经 `env -i` 投影进私有 tmux server |
| 令牌 | `test-deploy.sh:1435` | `${state}/.env` 只写一行 `TEST_BOT_TOKEN_N=...`,由 `FLYWHEEL_WRAPPER_ENV_FILE` 指到 |
| 验活 | `qa-launchd-lead.sh:151-174` | manifest 里 `pid` + `socketPath`(wrapper-v2 `publish_runtime_fields` 写入)且 `pid == launchctl print pid`,再 `tmux -S <socket> has-session -t '=main'` |
| 就绪 | `test-deploy.sh:1541-1557` | 等 `~/.flywheel/comm/<project>/.inbox-ready-<agent>` lease(claude-lead.sh 写) |
| 拆除 | `qa-launchd-lead.sh:198-204` + `test-teardown.sh:734` | registry `launchd-leads.json` 逐 label `bootout` |
| 守卫 | `scripts/__tests__/fly1663-qa-launchd.test.sh`(CI `ci.yml:352`)、`test-deploy-fly1389.test.sh`(CI `ci.yml:592`,hermetic 真 test-deploy + python launchctl 替身 + stub carrier) | 现有守卫断言 plist 含 KeepAlive/STATE_DIR/SUMMARY_CONFIG_HOME,但**没有**逐字节快照 |

### 2.2 生产 Codex 形状(目标形状)

| 环节 | 文件 | 事实 |
|---|---|---|
| plist argv | `~/Library/LaunchAgents/com.flywheel.lead.growth-mufasa-lead.plist`、`packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist` | `/bin/bash <fixed-wrapper>` **两参,无 manifest** |
| plist env | 同上 | Mufasa 只有 `FLYWHEEL_LEAD_RULES_BUNDLE=legacy`;Raya 模板**零** env。Codex 一族 env 全部来自 wrapper `set -a; source ${FLYWHEEL_STATE_DIR}/.env` + launcher 内硬编码 |
| wrapper | `scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh` | 读 `${FLYWHEEL_STATE_DIR}/.env`(**不读** `FLYWHEEL_WRAPPER_ENV_FILE`),跑 host tmux 选择门 `gate codex-raya`,`exec /bin/bash <launcher>` |
| launcher | `packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh` | 硬编码 `canonical_lead_identity_resolve "raya" "raya"`、`FLYWHEEL_CODEX_LEAD_STATE_DIR=${HOME}/.flywheel/state/codex-lead/raya`(**不可覆盖**)、`CODEX_HOME` 缺省 `~/.flywheel/raya/codex-home`、跨部门频道缺省=生产 roundtable、要求 Raya 的 IDENTITY.md/MEMORY.md/metrics 目录;最后 `exec node codex-lead-tui-runtime.js` |
| 通用 launcher | `packages/teamlead/scripts/codex-lead.sh` | 「Dormant direct launcher retained for operator QA」:任意 `<lead-id> <project-dir> <project-name>`,从 `FLYWHEEL_PROJECTS_FILE` 解析 canonical 身份,state dir = `${HOME}/.flywheel/state/codex-lead/<SAFE>__<SAFE>-<hex>`(`codex-lead.sh:81`,**也绑在 HOME 上**),`FLYWHEEL_CODEX_LEAD_MODE=tui` 时先 `codex-lead-tui-home.sh ensure-home/ensure-daemon` 再 `exec node codex-lead-tui-runtime.js`。FLY-259 QA 前例 `qa-fly259-mufasa-tui-slot.sh` 就是用它在隔离 `~/.codex-259-qa` 起过 Codex TUI Lead |
| 进程拓扑 | `exec` 链 | launchd pid **就是** `node …/codex-lead-tui-runtime.js`(wrapper→launcher→runtime 全 exec),没有 manifest、没有私有 tmux socket、没有 `=main` |
| 可见窗口 | `packages/teamlead/src/lead-backends/codex/tui-window.ts:149-165` | runtime 在**默认 tmux server** 的 `flywheel` session 开 `<project>-<leadId>` 窗口跑 `codex resume --remote`;server 由 `TMUX_TMPDIR` 路由(`tmux-environment-scrub.ts:91`)。fail-open:tmux 缺失 Lead 照常服务 |
| 生产验活 | `scripts/resident-codex-lead-recover.sh:108-160` | `capture_process`:launchctl pid → `ps -o command=` 恰一个 token 以 `codex-lead-tui-runtime.js` 结尾且前一个 token basename 是 `node`,`ps eww` 环境含 `CODEX_HOME=<期望值>`;收敛判据(`:256-273`):新 pid/lstart + `brain/heartbeat.json` 的 `processPid==新pid` 且 `generationId/carrierInstanceId` 变了 |
| 心跳 | `resident-codex-lead-lifecycle.ts:93` + `codex-lead-tui-runtime.ts:124-147` | `<FLYWHEEL_CODEX_LEAD_STATE_DIR>/brain/heartbeat.json`;只有 projects 行满足 `codexResidencyPatrol:true && backend:codex-app-server && canSpawnRunners:false && (codexProfile 或 companion)`(`resident-codex-lead-roster.ts`)时才武装;`carrierInstanceId` 由 runtime 自己随机生成(`codex-lead-runtime.ts:1537`) |
| 假死自愈 | `raya-brain-patrol`(Bridge GatePoller rider,FLY-2216)→ `resident-codex-lead-recover.sh --recover` → `launchctl kickstart -k` | 权威链绑死在 `~/.flywheel/projects.json` + `~/.flywheel/manifests/<key>.json` + `~/Library/LaunchAgents/<label>.plist` + 三个固定 wrapper basename(各自硬编码 `EXPECTED_CODEX_HOME`)。**无法**对 slot 身份运行 |
| 重启权威 | `scripts/lib/lead-restart-lifecycle.sh:529-593` | 按 wrapper basename 闭合集合分支:v2 → 3 参 + manifest;三个 codex wrapper → 恰 2 参 + 固定 project/lead;未知 wrapper 一律拒绝 |

### 2.3 三处差异的准确定位

1. **argv**:529 是 `<wrapper> <manifest>`;Codex 生产是 `/bin/bash <wrapper>`。
2. **env 注入集**:529 把 Lead 环境放进 manifest.launchEnvironment,只有 wrapper-v2 / lead-body.sh 会读;Codex wrapper 只读 `${FLYWHEEL_STATE_DIR}/.env`。而 529 的 `env_file="${state}/.env"` 恰好**就是** `${FLYWHEEL_STATE_DIR}/.env`(`state` 被作为 FLYWHEEL_STATE_DIR 注入 plist)——所以 Codex 形状的注入点天然存在,只是现在只写了一行 token。
3. **拓扑校验**:529 要 manifest pid+socketPath+`=main`;Codex 形状要「launchd pid = node runtime 进程 + 环境里的 CODEX_HOME 精确匹配 + heartbeat.processPid 一致」。

### 2.4 隔离性事实(决定「不碰生产」怎么落)

- 529 slot 的 HOME 是真 HOME(`qa_slot_start_lead` 传 `"$HOME"`),`~/.flywheel/comm/test-slot-N/` 等本来就落在真 `~/.flywheel` 下(slot 身份唯一)。
- `codex-lead.sh:81` 的 state dir 绑 HOME,不是 FLYWHEEL_STATE_DIR;生产 `~/.flywheel/.env` **没有** `FLYWHEEL_STATE_DIR` 键(已核),生产 Codex Lead 也不走 codex-lead.sh(走各自 launcher 且各自硬编码 state dir)。
- Codex TUI 的 tmux 窗口默认开在**默认 tmux server** 的 `flywheel` session —— 那正是 cmux 同步的生产 session。slot 内不设 `TMUX_TMPDIR=${SLOT_DIR}` 就会把测试窗口开进生产 cmux。Bridge 侧已有同样的路由约定(`test-deploy.sh:812`)。
- `codex-lead-tui-home.sh:577-581`:CODEX_HOME 必须自带 `auth.json` 与 `packages/standalone/current/codex`(daemon 只认 standalone);脚本明说**绝不**拷凭据、**绝不**自动安装。机器上现成的隔离 home:`~/.codex-259-qa`(standalone 0.140.0,school 账号,auth 文件 6-15 之后未更新,可能需重登)。standalone 目录 436M。
- Bridge 的 Codex 孤儿收割器(FLY-2174)只盘点 `FLYWHEEL_CODEX_HOMES_ROOT/SESSION_DIR/DAEMON_SOCKET_ROOT` 三个 slot 目录;Lead 的 `codex remote-control` daemon socket 在 CODEX_HOME 内,收割器看不见 → 拆房必须自己 `remote-control stop`。

## 3. 目标与非目标

**目标**
- 台架按 Lead **载体形状**分支:`claude-v2`(既有,逐字节不变)与 `codex-tui`(新),plist argv / env 注入集 / 验活判据 / 就绪判据 / 拆除各自成立;再加形状只加分支不改既有分支。
- 形状**不是开关**,而是 Lead 身份数据:与生产一致,由 projects 行的 `backend` 决定(wrapper-v2 已按 `backend` 拒绝非 claude-code;lead-restart-lifecycle 已按 backend 分支)。
- 验收:529 房起一个 Codex 形状受管常驻 Lead(slot 身份、隔离 CODEX_HOME / state / tmux server,不碰生产),RunAtLoad+KeepAlive 生效,验活通过,崩溃与 `kickstart -k` 后按生产同判据收敛;既有 Claude 房 slot 启动 / 验活回归全绿,且有守卫证明 Claude 分支产物逐字节不变。

**非目标**
- 退旧脑 / 生产单实例切换(FLY-2259 B)。
- Bridge 侧 RayaBrainPatrol / `resident-codex-lead-recover.sh` 对 slot 身份生效(它们是 HOME 与固定 wrapper 绑定的生产权威;改它们等于改生产自愈边界)。
- 让 529 房造 Codex **工人**(FLY-2224 域)。
- 改 `flywheel-daemon.sh::classify_plist_lead_carrier`、restart-services、host-tmux 的闭合 carrier 集。

## 4. 方案选项

### 选项 A:复用 Raya 生产 wrapper + launcher 原样进房
- 做法:plist 指向 `scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh`,slot projects.json 塞一个 `raya/raya` 行,靠 .env 覆盖坐标。
- 否决理由:launcher 硬编码 `FLYWHEEL_CODEX_LEAD_STATE_DIR=~/.flywheel/state/codex-lead/raya`(生产路径,不可覆盖),跨部门频道缺省是生产 roundtable(空值会回落到缺省),还要求 Raya 的 IDENTITY/MEMORY/metrics 文件;要么改生产 launcher 加一串「仅测试可覆盖」的口子(与 FLY-2216「不能从 manifest/env 注入路径」的安全决策对撞),要么房里出现一个叫 raya 的假身份和 slot Bridge 的 test-slot-N 身份打架。收益(逐字复用 Raya 链)抵不上它把 Raya 专有耦合带进通用台架。

### 选项 B(推荐):形状分支 + 通用 Codex launcher + 模板渲染的 slot 固定 wrapper
- **形状来源**:`~/.flywheel/test-slots.json` slot 条目可选字段 `backend: "codex-app-server"` 与 `codexSourceHome: <隔离 home 路径>`;`qa_multilead_slot_fields` 带出,`qa_multilead_build_projects` 把该 Lead 行渲染成 `backend/codexProfile:"full-access"/canSpawnRunners:false/codexResidencyPatrol:true`;缺省不写任何新键 → 现有 A1/A2 字节守卫照旧通过。`qa_slot_start_lead` 读 lead_row.backend 决定形状。主 Lead 与 `--extra-lead` 共用这一个分支点。
- **argv**:`qa_launchd_render_plist` 拆成「公共外壳 + 按形状的 argv/env 片段」;claude 片段原样搬出(字节不变),codex 片段渲染 `<string>/bin/bash</string><string><wrapper></string>`。
- **wrapper**:新增 `scripts/lib/qa-codex-lead-wrapper.template.sh`,镜像生产三份 Codex wrapper 的骨架(`set -a; source ${FLYWHEEL_STATE_DIR}/.env`、PATH、host tmux 门 `gate codex-tui`、`exec /bin/bash ${FLYWHEEL_DIR}/packages/teamlead/scripts/codex-lead.sh <project> <lead> <project-dir>`),台架用 3 个已校验的标识符渲染到 `${runtime}/codex-lead-wrapper.sh`(mode 700)。选择器烘焙在 wrapper 里,与生产「固定 wrapper、身份不可 env 注入」一致;hermetic 测试可用 `FLYWHEEL_QA_CODEX_LEAD_WRAPPER_TEMPLATE` 换替身。
- **env 注入集**:同一份 `qa_slot_launch_env_json` 环境图,两种投影 —— claude 进 manifest.launchEnvironment(不变),codex 追加为 `${state}/.env` 的 `NAME=%q` 行(wrapper `set -a` 源入)。codex 形状另加 Codex 一族:`CODEX_HOME`(slot 本地铸造的 home)、`FLYWHEEL_CODEX_BIN`、`FLYWHEEL_CODEX_LEAD_MODE=tui`、`FLYWHEEL_CODEX_TUI_CWD=<lead workspace>`、`FLYWHEEL_CODEX_LEAD_PROFILE=full-access`、`FLYWHEEL_CODEX_LEAD_OUTBOUND=direct`、`FLYWHEEL_LEAD_CHAT_CHANNEL_ID=<slot 频道>`、`FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES=<slot identity>`、`FLYWHEEL_COMM_DB/FLYWHEEL_COMM_CLI`;plist env 为 HOME / PATH / FLYWHEEL_DIR / FLYWHEEL_STATE_DIR / **TMUX_TMPDIR=${SLOT_DIR}**(窗口路由到 slot tmux server)。
- **CODEX_HOME 铸造**:`${SLOT_DIR}/state/codex-lead-home/<agent>`:从 `codexSourceHome` 拷 `auth.json`(mode 600),`packages/standalone/releases/<current>` 用 APFS clonefile(`cp -Rc`,同卷零拷贝,跨卷回落 `cp -R`)并重建 `current` 链接 → realpath 在 slot 内,daemon 身份检查(`codex-lead-tui-home.sh:770` 前缀匹配)成立;`config.toml` 交给 `ensure-home` 自己写。拒绝 `codexSourceHome` 命中 `~/.codex-mufasa`、`~/.codex-infra-bot`、`~/.flywheel/raya/codex-home`(生产 Lead 凭据)。
- **state dir**:`codex-lead.sh:81` 改为 `STATE_ROOT="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"`。生产 `.env` 无此键、生产 Codex Lead 不经此脚本 → 字节兼容;slot 内一切 state 落 `${SLOT_DIR}/q/<slot>/state/codex-lead/...`。这是本单**唯一**的 `packages/` 改动。
- **验活**(新 `qa_launchd_codex_lead_verify`):launchd pid P;`ps -p P -o command=` 末 token 以 `codex-lead-tui-runtime.js` 结尾且前一 token basename 为 `node`;`ps eww -p P` 含 `CODEX_HOME=<slot home>`;`<stateDir>/brain/heartbeat.json` 的 `processPid==P` —— 与 `resident-codex-lead-recover.sh` 的 exact identity 同一判据。输出 `P<TAB><stateDir>`。既有 `qa_launchd_lead_verify` 一字不动。
- **就绪**:test-deploy 步骤 2 按形状分支:codex 等 heartbeat `state=="online"`(不等 `.inbox-ready` lease,Codex runtime 不写它);`confirm_dev_channels_prompt` 只对 claude 形状运行。
- **窗口**:就绪后探 `tmux -S ${SLOT_DIR}/tmux-<uid>/default list-windows -t =flywheel` 是否有 `<project>-<agent>`,写进 launch-manifest `leadTuiWindow: present|absent`。不作为硬门(runtime 对窗口 fail-open 且自带 `tui_window_lost` 守卫),留给 QA 断言。
- **拆除**:registry 条目扩为 `{label, plist, manifest, carrier, codexHome}`;`qa_launchd_stop_registry` bootout 后对带 `codexHome` 的条目 `CODEX_HOME=<home> <bin> remote-control stop --json`,再由既有 `rm -rf SLOT_DIR` 收尾。旧条目无新键 → 行为不变。
- **自愈演练**(新 `qa_launchd_lead_respawn_drill <label> <carrier> crash|kickstart`):记录旧 pid/lstart/generationId;`kill -9` 或 `launchctl kickstart -k`;等 ThrottleInterval 后按形状重验并断言 pid/lstart 变了、heartbeat generationId 变了(生产收敛判据)。
- **守卫**:① `fly1663-qa-launchd.test.sh` 加 claude plist **逐字节黄金快照**(固定输入 → 期望文本);② codex plist 渲染断言(恰 2 argv、`/bin/bash`、无 manifest、env 恰 5 键);③ codex 验活/拆除/演练用 launchctl+ps 替身;④ `test-deploy-fly1389.test.sh` 在 `make_slots_json` 加一个 codex 形状 slot,替身 `codex-lead.sh` 在 FLYWHEEL_STATE_DIR 下写 heartbeat 并驻留,复用现有 python launchctl 替身跑 `ProgramArguments`,断言 Claude slot 的 plist/.env/manifest 与快照逐字节相同、codex slot 起得来验得过拆得净。

### 选项 C:把 Codex 一族 env 也塞进 plist EnvironmentVariables
- 否决理由:与生产形状背离(生产 Codex plist 几乎零 env,一切走 .env+launcher);测的不是生产链。

## 5. 关键取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 形状怎么声明 | slot 身份数据(`backend`),不是 CLI flag | founder 不加开关;与生产「backend 决定载体」同源 |
| 跑哪个 launcher | 通用 `codex-lead.sh` | 唯一不绑死具体 Lead 的生产 launcher;FLY-259 QA 已用它起过隔离 TUI Lead |
| wrapper 从哪来 | 模板渲染的 slot 固定 wrapper | 保住「2 参 argv + 身份不可 env 注入」;避免新增第 4 个生产固定 wrapper 及三处 carrier 闭合集扩散 |
| 假死自愈边界 | launchd 层(crash / kickstart -k)+ 生产收敛判据 | Bridge 巡逻链是生产 HOME/固定 wrapper 权威,进本单等于改生产自愈边界 |
| `packages/` 改动 | 仅 `codex-lead.sh` state root 一处 | 其余全在台架;字节兼容有证据(生产 .env 无键、生产不经此脚本) |

## 6. 风险与开放问题

- **auth 有效性**:`~/.codex-259-qa` 的 auth.json 可能已过期;验收前需 `CODEX_HOME=~/.codex-259-qa codex login`(操作者步骤,台架 fail-loud 不代劳)。这是验收的外部前置,不是台架缺陷。
- **standalone 版本**:0.140.0;runtime 有 `FLYWHEEL_CODEX_CLI_VERSION_ALLOWLIST`,research 阶段要核该版本在允许集内。
- **full-access 门**:codex-lead.sh 在 `FLYWHEEL_CODEX_LEAD_PROFILE=full-access` 时要 governance bundle 与 lead-actions MCP dist;slot 的 FLYWHEEL_DIR 指向脚本仓 checkout(已 build)。research 核 `req(...)` 必填 env 全集。
- **canSpawnRunners:false**:Codex 形状 slot Lead 与 Raya 同为非派工常驻体;需要派工的 Codex Lead 是另一层(超出本单)。
- **`FLYWHEEL_STATE_DIR` 语义**:codex-lead.sh 改后,任何把 FLYWHEEL_STATE_DIR 写进 .env 的操作者都会搬迁 Codex state —— 与 wrapper-v2 对 Claude 的既有暴露面同类,不新增类别。
- 已向 Lead 发出非阻塞确认(question eb231cf9):上述三条解释性取舍。
