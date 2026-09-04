# FLY-2284 slot Bridge 环境隔离 — 实施计划
Issue: FLY-2284 (https://linear.app/geoforge3d/issue/FLY-2284/529-房隔离-test-deploysh-起的-slot-bridge-继承调用-shell-全部-env包括生产-flywheel)
日期: 2026-09-04
基于: research.md

> **执行合同：** 当前 implement DAG 节点内 inline 执行；每项行为修改严格 RED → GREEN →
> REFACTOR。禁止 dispatch successor、merge、deploy 或修改本计划通过 design-review 后的 blob。

> **本计划取代 exploration/research 的锁定设计：** Lead 在 R2 裁决不采用
> `exploration.md`“三分支从空环境启动”的条目，并以模式化 identity/state-axis deny 取代其中对方案 C
> 的逐名黑名单否决；`research.md` 结论里的 `env -i`/fail-closed 正向环境同样作废。
> `research.md` CommDB §3（原 48–55 行）的 HOME 同账结论仍为权威，明确取代 R2 草稿曾提出的第二个
> slot-tree CommDB root。

**Goal:** 让 529 slot Bridge、它的 replay 与所有派生进程保留普通 caller compatibility，同时不继承
任何可能指向生产的 identity/state coordinate；CommDB 保持 Lead/Bridge 同一本 slot-owned 账，其余
state/secret/Codex identity 坐标确定性覆盖到 slot tree。

**Architecture:** `test-deploy.sh` 是业务配置权威：保留普通 caller env，但在三条 capture branch 之前
动态枚举并 deny 所有 `FLYWHEEL_*|DELIVERY_*|*_DB|*_DIR|*_TOKEN` 与 `CODEX_HOME` 危险坐标（但命名
exception list 保留 `GH_TOKEN|GITHUB_TOKEN`），再按 slot/mode allowlist
显式 SET 共同环境、mode-specific assignments 与极窄 fixture allowlist。`qa-slot-bridge-spec.mjs` 继续
完整 capture 最终 child env，不承担业务过滤；同一 spec 继续驱动初次启动与 cycle replay。

**Tech Stack:** Bash 3.2-compatible shell、Node.js、jq、launch-spec JSON、hermetic shell tests。

---

## Design review 修正：fixture + 真实 caller 环境清单与分类

在修改 subject 前，已连续两次运行现有 `test-deploy-fly1389.test.sh`，均为 `15 passed, 0 failed`，并从
E/default、A/alerts、I/reply-by-issue、N/no-lead 四个 arm 的真实 `bridge-launch.json` 记录 pre-change
环境。默认 arm 的环境名集合包括 `DISCORD_*`、`TEAMLEAD_*`、`FLYWHEEL_*`、fixture-only
`FLY1389_*`/`FLYWHEEL_QA_*`、`TEST_*` 与 OS 基座；这是 hermetic fixture inventory，不冒充真实 caller。
另在当前 resident Runner pane 做 name-only audit，实际发现 `CODEX_HOME`、`GH_TOKEN`、
`OPENAI_API_KEY`、`LINEAR_API_KEY`、`SUPABASE_KEY`/`SUPABASE_URL`、`TMPDIR`、locale/pager/tooling 名称及
多项 `FLYWHEEL_*` 坐标。mode arm 另增加各自显式坐标。修改后的分类如下：

默认 E arm 的完整 observed name inventory（值未写入文档，避免 secret material）为：

```text
CLAUDE_CONFIG_DIR DISCORD_BOT_TOKEN DISCORD_OWNER_USER_ID
FLY1389_ENV_DUMP_NODE FLY1389_LAUNCHCTL_STATE FLY1389_REAL_CURL
FLYWHEEL_BIN_DIR FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE
FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT FLYWHEEL_CODEX_HOMES_ROOT
FLYWHEEL_CODEX_SESSION_DIR FLYWHEEL_COMPLETE_MARKER_DIR
FLYWHEEL_DELIVERY_SECRET_PATH FLYWHEEL_DONE_THREAD_RECONCILE
FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH FLYWHEEL_HOOKS_DIR
FLYWHEEL_LEAD_EFFORT FLYWHEEL_LEAD_MODEL FLYWHEEL_LOOP_DIAGNOSTICS_DIR
FLYWHEEL_NOVEL_WEBHOOK_TOKEN FLYWHEEL_PROJECTS FLYWHEEL_PROJECTS_FILE
FLYWHEEL_QA_LAUNCHCTL FLYWHEEL_QA_LAUNCHD_POLL_INTERVAL
FLYWHEEL_QA_LEAD_VERIFY_INTERVAL FLYWHEEL_QA_LEAD_VERIFY_POLLS
FLYWHEEL_QA_LEAD_WRAPPER FLYWHEEL_QA_TMUX FLYWHEEL_REPORTS_DIR
FLYWHEEL_RUNNER_START_POINT FLYWHEEL_SANDBOX_REMOTE_URL FLYWHEEL_STATE_DIR
FLYWHEEL_SUMMARY_CONFIG_HOME HOME LEAD_WORKSPACE LINEAR_API_KEY PATH PWD
TEAMLEAD_DB_PATH TEAMLEAD_DEFAULT_LEAD_AGENT TEAMLEAD_PORT TEAMLEAD_URL
TEST_API_TOKEN TEST_BOT_TOKEN_31 TEST_LEAD_CLAUDE_CONFIG_DIR
TEST_REPLY_BY_ISSUE TEST_SKIP_PLUGIN_FORK_CHECK
TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR TMPDIR TMUX_STUB_LOG
TMUX_STUB_WINDOW TMUX_TMPDIR __CF_USER_TEXT_ENCODING
```

当前 resident Runner pane 的真实 caller name-only inventory（`env | cut -d= -f1 | sort`，无值）为：

| 类别 | 观测到的名字 |
|---|---|
| Runner/工作流 | `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`, `CODEX_CI`, `CODEX_HOME`, `CODEX_SANDBOX`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `FLYWHEEL_AGENT_NAME`, `FLYWHEEL_AGENT_TEAM_NAME`, `FLYWHEEL_BRIDGE_URL`, `FLYWHEEL_COMM_CLI`, `FLYWHEEL_COMM_DB`, `FLYWHEEL_EXEC_ID`, `FLYWHEEL_GATE_MARKER_DIR`, `FLYWHEEL_INGEST_TOKEN`, `FLYWHEEL_ISSUE_ID`, `FLYWHEEL_LEAD_ID`, `FLYWHEEL_PROGRESS_PATH`, `FLYWHEEL_PROJECT_NAME`, `FLYWHEEL_RUNNER_BACKEND_ID`, `FLYWHEEL_RUNNER_VENDOR_ID`, `FLYWHEEL_STATE_DB_PATH`, `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED`, `MAX_THINKING_TOKENS`, `TEAMLEAD_NOTIFICATION_CHANNEL`, `TEAMLEAD_OWNS_SLACK`, `TEAMLEAD_URL` |
| Credentials/services | `ELEVENLABS_API_KEY`, `FISH_API_KEY`, `GH_TOKEN`, `GOG_ACCOUNT`, `GOOGLE_API_KEY`, `LINEAR_API_KEY`, `MINIMAX_API_KEY`, `NANOBANANA_GEMINI_API_KEY`, `NANOBANANA_MODEL`, `OPENAI_API_KEY`, `OPENCLAW_DISCORD_TOKEN`, `OPENCLAW_HOOKS_TOKEN`, `SUPABASE_KEY`, `SUPABASE_URL` |
| Shell/tooling | `COLORTERM`, `EDITOR`, `FPATH`, `GH_PAGER`, `GIT_PAGER`, `HOME`, `HOMEBREW_CELLAR`, `HOMEBREW_PREFIX`, `HOMEBREW_REPOSITORY`, `INFOPATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LOGNAME`, `NODE_EXTRA_CA_CERTS`, `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`, `NO_COLOR`, `OLDPWD`, `PAGER`, `PATH`, `PWD`, `PYENV_ROOT`, `PYENV_SHELL`, `SHELL`, `SHLVL`, `TERM`, `TMPDIR`, `USER`, `_`, `__CF_USER_TEXT_ENCODING` |

A/alerts delta 是 alert/claims 显式变量；I/reply delta 是 `TEAMLEAD_API_TOKEN`、reply flags 与
`VERCEL_TOKEN`；N/no-lead delta 是 `GEOFORGE3D_LEAD_RULES_SRC`。这些 mode delta 逐项沿用现有
branch-specific assignments，除标为 parent/test-only 的值外不靠 ambient inheritance。

| 分类 | 环境变量 | 决策 |
|---|---|---|
| 非危险 caller 环境 | `HOME`, `PATH` 及不匹配危险命名规则的普通调用方环境 | 继续继承；`PWD` 由 capture helper 按 cwd 合成，不从空环境重建 |
| 已显式业务坐标 | `DISCORD_BOT_TOKEN`, `DISCORD_OWNER_USER_ID`, dynamic `TEST_BOT_TOKEN_N`, `LINEAR_API_KEY`, branch-specific `TEAMLEAD_*`, 现有全部 `BRIDGE_EXTRA_ENV` | 保持现有显式投影 |
| R1 新发现的真实依赖 | `DISCORD_GUILD_ID`, `TEAMLEAD_ISSUE_PREFIXES` | 从已解析配置显式投影；前者用 `GUILD_ID`，后者默认 `FLY,GEO`。两者均由真实 `~/.flywheel/.env` 提供并被 `config.ts` 消费 |
| 动态 deny 集合 | 每个现存的 `FLYWHEEL_*`, `DELIVERY_*`, `*_DB`, `*_DIR`, `*_TOKEN` key，以及 `CODEX_HOME` | 在任何 assignment 之前转成 `env -u <key>`；`GH_TOKEN`/`GITHUB_TOKEN` 是命名 exception，不进入 deny args |
| 本 issue 强制 slot SET | `FLYWHEEL_STATE_DIR`, `FLYWHEEL_DELIVERY_SECRET_PATH`, `CODEX_HOME` 以及现有 slot `BRIDGE_EXTRA_ENV` | 指向 `${SLOT_DIR}` 下资源；deny 后显式恢复 |
| CommDB 同账例外 | `FLYWHEEL_COMM_DB` | 显式设为 `${HOME}/.flywheel/comm/${TEST_PROJECT_NAME}/comm.db`；不设置 `FLYWHEEL_COMM_DIR/ROOT`，避免与 hard-export HOME 路径的 Lead 分账 |
| credential 边界 | `GH_TOKEN`, `GITHUB_TOKEN` 显式 exception；其他 `*_KEY|*_SECRET|*_PASSWORD|*_URL` | credentials 不在本 issue 的 identity/state 隔离目标；不新增对这些名字族的 deny。记录事实：`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ELEVENLABS_API_KEY`, `MINIMAX_API_KEY`, `FISH_API_KEY`, `NANOBANANA_GEMINI_API_KEY`, `SUPABASE_KEY`, `SUPABASE_URL` 会继续继承；现有 `LINEAR_API_KEY` 与 bot/TeamLead token assignments 不变 |
| 必须丢弃的 ambient/test-only 值 | `CLAUDE_CONFIG_DIR`, `LEAD_WORKSPACE`, `FLYWHEEL_LEAD_MODEL`, `FLYWHEEL_LEAD_EFFORT`, `FLYWHEEL_NOVEL_WEBHOOK_TOKEN`, `FLYWHEEL_QA_*`, `FLYWHEEL_SANDBOX_REMOTE_URL`, `FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE`, parent-only `TEST_*`, `TMUX_STUB_*`, `GEOFORGE3D_LEAD_RULES_SRC`, `__CF_USER_TEXT_ENCODING` 及其他未获显式恢复的危险变量 | 危险命名集合经 deny 后不再继承；普通非危险值保持 caller compatibility |
| fixture allowlist | `FLY1389_ENV_DUMP_NODE`（以及实现审计发现确实由 child stub 消费的同类 key） | 作为命名的极窄 allowlist 在 deny 后显式恢复；不得把整组 `FLY1389_*` 放行 |

`FLY1389_ENV_DUMP_NODE` 目前只供 stub `npx` 寻找 Node；它不是 Bridge 业务依赖，但必须作为 hermetic
carrier control 被显式恢复。fixture sweep 确认其余 `FLY1389_REAL_CURL`、
`FLY1389_LAUNCHCTL_STATE`、`TMUX_STUB_*` 与 `FLYWHEEL_QA_*` 只由 parent deploy/teardown/launchctl
使用，不是 Bridge child 启动依赖，因此不加入 child allowlist。

---

## 文件职责

| 文件 | 责任 | 计划动作 |
|---|---|---|
| `scripts/test-deploy.sh` | 529 slot 组装与三条 Bridge launch boundary | 动态危险-key denylist；显式 slot 坐标；三条 branch 在 scrub 后重建业务环境；generalized 内恢复已校验 ingest token |
| `scripts/__tests__/test-deploy-fly1389.test.sh` | 真实 subject + stub carrier/Bridge 的 hermetic E2E | 注入 production 坐标/未知 FLYWHEEL secret，先 RED；显式 fixture/GH exception controls；断言 mandatory env、slot override、spec/live/replay；不把 universal-200 stub 当 availability gate |
| `scripts/__tests__/test-deploy-launch-boundary.test.sh` | 三条 launch source 防漂移 | 断言三条 branch 消费同一动态 deny args，显式 slot 坐标只组装一次 |
| `scripts/__tests__/test-deploy-generalized.test.sh` | generalized helper/source contract 与 pinned-last assertion | 保持 hermetic helper runtime；把 literal-final `BRIDGE_EXTRA_ENV` 断言调整为容纳新增 CommDB/Codex append，同时继续锁定 state append 顺序 |
| `engineering/doc/FLY-2284-slot-bridge-env-isolation/progress.md` | restart cursor | 每个 meaningful batch 更新，review approval 后停止更新 |
| `engineering/doc/milestones/FLY-2284.md` | PR 里程碑 | 所有实现与验证完成后作为 literal last commit 新建 |

## Task 1：RED — 复现 production CommDB 与未知 FLYWHEEL 变量穿透

**Files:**

- Modify: `scripts/__tests__/test-deploy-fly1389.test.sh`
- Modify: `scripts/__tests__/test-deploy-launch-boundary.test.sh`
- Modify: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 0: 锁定 fixture child control allowlist**

保留 stub `npx` 对 `FLY1389_ENV_DUMP_NODE` 的硬依赖，并让 production subject 在危险-key deny 后从
命名 allowlist 显式恢复该值。逐项 sweep fixture：`FLY1389_REAL_CURL`、`FLY1389_LAUNCHCTL_STATE`、
`TMUX_STUB_*`、`FLYWHEEL_QA_*` 均只服务 parent 或 launchctl，不加入 Bridge child allowlist。RED 必须
到达 Bridge health，不能把缺少 fixture control 导致的 health timeout 当作隔离失败。

- [ ] **Step 1: 让 fixture 父环境携带 production CommDB**

在 `run_deploy` 的外层 `env -i` fixture 输入加入：

```bash
FLYWHEEL_COMM_DB="${FLYWHEEL_COMM_DB:-}" \
FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-}" \
FLYWHEEL_DELIVERY_SECRET_PATH="${FLYWHEEL_DELIVERY_SECRET_PATH:-}" \
CODEX_HOME="${CODEX_HOME:-}" \
GH_TOKEN="${GH_TOKEN:-}" \
GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
```

E arm 调用加上：

```bash
FLYWHEEL_COMM_DB="$SB/production-comm/flywheel/comm.db" \
FLYWHEEL_STATE_DIR="$SB/production-state" \
FLYWHEEL_DELIVERY_SECRET_PATH="$SB/production-delivery/secret" \
CODEX_HOME="$SB/production-codex-home" \
GH_TOKEN="fixture-gh-token" \
GITHUB_TOKEN="fixture-github-token" \
DISCORD_GUILD_ID="g-fixture" \
TEAMLEAD_ISSUE_PREFIXES="FLY,GEO,LEARN" \
FLY1389_SAFE_SENTINEL="ordinary-caller-value" \
```

保留已有 `FLYWHEEL_NOVEL_WEBHOOK_TOKEN=fixture-novel-webhook-secret` 作为未知 secret-shaped
`FLYWHEEL_*` 负控。

- [ ] **Step 2: 反转旧“未知变量应 capture”期望**

把 E arm schema assertion 中对 `FLYWHEEL_NOVEL_WEBHOOK_TOKEN` 的正向要求改为 absent：

```jq
([.secretEnvironment[].name] | index("FLYWHEEL_NOVEL_WEBHOOK_TOKEN") == null)
```

删除读取 novel sidecar 并比较 secret bytes 的旧断言，改为同时检查：

```bash
! grep -Fq 'fixture-novel-webhook-secret' "$E_BRIDGE_SPEC"
! grep -Fq 'fixture-novel-webhook-secret' "$E_SLOT_DIR/bridge-env.txt"
! grep -R -Fq 'fixture-novel-webhook-secret' "$E_SLOT_DIR/state/bridge-env-secrets"
```

目录为空/不存在均视为通过；命令错误必须显式区分，不能把 unreadable 当 absent。

- [ ] **Step 3: 添加危险集合负控与 mandatory env 正控**

期望 spec 和 live env 恰好包含：

```text
FLYWHEEL_COMM_DB=${FH1}/.flywheel/comm/test-slot-31/comm.db
FLYWHEEL_STATE_DIR=${E_SLOT_DIR}
FLYWHEEL_DELIVERY_SECRET_PATH=${E_SLOT_DIR}/state/delivery-secret
CODEX_HOME=${E_SLOT_DIR}/state/codex-home
DISCORD_GUILD_ID=g-fixture
TEAMLEAD_ISSUE_PREFIXES=FLY,GEO,LEARN
FLY1389_ENV_DUMP_NODE=${FLY1389_REAL_NODE}
FLY1389_SAFE_SENTINEL=ordinary-caller-value
GH_TOKEN=fixture-gh-token
GITHUB_TOKEN=fixture-github-token
```

用 Node 读取 spec 重建 env map：枚举危险命名集合，断言没有任何 value 含 `$SB/production-`，并逐项
断言上述 slot values；同时证明普通 caller sentinel 仍继承、未知 `FLYWHEEL_NOVEL_WEBHOOK_TOKEN`
消失、fixture Node 是 deny 后的显式 allow control。该枚举先断言至少观察到一项 `FLYWHEEL_*`，避免
空集合假绿。命名的 GH/GitHub/fixture controls 必须保留。以上是 env assertion，不是 availability gate；
fly1389 stub 对任意 GET 都返回 200，因此任何针对该 stub 的 HTTP 请求都不得声称证明 Bridge 可用。

- [ ] **Step 4: 添加 source 防漂移断言**

`test-deploy-launch-boundary.test.sh` 先把三条 capture branch 的源码区间提取为
`bridge_launch_block`，再分别要求三条都展开共同 `BRIDGE_ENV_UNSET_ARGS`，且 slot SET 只组装一次：

```bash
[[ "$(rg -F -c 'BRIDGE_ENV_UNSET_ARGS[@]' <<<"$bridge_launch_block")" == "3" ]]
[[ "$(rg -F -c 'BRIDGE_EXTRA_ENV+=("FLYWHEEL_COMM_DB=' "$DEPLOY")" == "1" ]]
```

另逐项精确检查新的 slot SET 与 `DISCORD_GUILD_ID`/`TEAMLEAD_ISSUE_PREFIXES` 共同 append 只出现一次。
静态 discriminator 不依赖源码布局；权威 runtime regression 是“所有危险值均不含 production prefix，
且所有声明的 slot 坐标均等于 slot value”。mutation self-check 从临时 subject 删除一处 deny args
expansion 后，第一项 count 必须从 3 变成 2 并失败。

- [ ] **Step 5: 运行 RED 并核对失败原因**

```bash
bash scripts/__tests__/test-deploy-launch-boundary.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
```

Expected：runtime E arm 因 production 危险坐标未被 scrub/slot SET 及 novel variable 仍在 snapshot/live
env 而失败；fixture 必须仍走到 env dump。不得接受 fixture setup、health、launchd 或 cleanup 错误作为 RED。

## Task 2：GREEN — 三条 Bridge boundary 统一动态 deny + 显式 slot SET

**Files:**

- Modify: `scripts/test-deploy.sh`

- [ ] **Step 1: 在 slot 解析后构造共同动态 deny args**

在 `SLOT_DIR`/arrays 初始化区枚举当前 exported env 的 key；匹配以下任一规则的名字加入
`BRIDGE_ENV_UNSET_ARGS=(-u name ...)`：

```bash
FLYWHEEL_* | DELIVERY_* | *_DB | *_DIR | *_TOKEN | CODEX_HOME
```

fixture allowlist 的名字也先加入 unset args，再在共同 assignments 最后显式恢复，保证“继承普通 caller
env → deny 危险/特殊 key → explicit SET”的顺序可由 spec 证明。名字必须先验证为 shell env identifier；
不使用 `eval`。命名 exception list 明确包含 `GH_TOKEN`, `GITHUB_TOKEN`，使其不进入 deny args。
credentials 不在本 issue 的 identity/state-axis 隔离目标，因此不新增 `*_KEY|*_SECRET|*_PASSWORD|*_URL`
deny。普通 `HOME`/`PATH`/locale/tooling env 保持 caller compatibility。

- [ ] **Step 2: 显式覆盖全部已知 slot coordinate**

在共同 `BRIDGE_EXTRA_ENV` isolation block 加入：

```bash
BRIDGE_EXTRA_ENV+=("DISCORD_GUILD_ID=${GUILD_ID}")
BRIDGE_EXTRA_ENV+=("TEAMLEAD_ISSUE_PREFIXES=${TEAMLEAD_ISSUE_PREFIXES:-FLY,GEO}")
BRIDGE_EXTRA_ENV+=("FLYWHEEL_COMM_DB=${HOME}/.flywheel/comm/${TEST_PROJECT_NAME}/comm.db")
BRIDGE_EXTRA_ENV+=("CODEX_HOME=${SLOT_DIR}/state/codex-home")
BRIDGE_EXTRA_ENV+=("FLYWHEEL_STATE_DIR=${SLOT_DIR}")
```

CommDB root stays at HOME so Lead（`claude-lead.sh:676` hard export）、Bridge 与 Runner 共用一本 DB；只
pin per-project `FLYWHEEL_COMM_DB` path。不设置 `FLYWHEEL_COMM_DIR` 或 `FLYWHEEL_COMM_ROOT`：dynamic deny
删除 caller override 后，Bridge resolver 回到 `${HOME}/.flywheel/comm/<project>/comm.db`，与 teardown 同账。
既有 `FLYWHEEL_DELIVERY_SECRET_PATH` 继续指向 slot delivery secret。新增 slot Codex home 先以 mode 0700
创建。所有新增项插在现有 state append 之前；`test-deploy-generalized.test.sh` 当前把
`FLYWHEEL_STATE_DIR=${SLOT_DIR}` 锁为 literal final append，该 assertion 文件必须随新 append 一起审计，
并继续保证 state 是共同 array 的最后一项。
slot `CODEX_HOME` 只用于阻断继承，不承载 Bridge-internal codex exec：per-execution homes 从
`FLYWHEEL_CODEX_HOMES_ROOT` 派生，tmux scrub 会删除 `CODEX_HOME`；不复制或 provision auth material。

- [ ] **Step 3: 改三条 capture branch**

generalized、reply-by-issue、default 三条都改为：

```bash
env \
  ${BRIDGE_ENV_UNSET_ARGS[@]+"${BRIDGE_ENV_UNSET_ARGS[@]}"} \
  ...all other -u options... \
  ...explicit assignments...
```

所有动态 token env 继续只从已有显式 arrays 投影。macOS/BSD `env` 要求所有 `-u` option 位于第一条
`name=value` 之前；三条 branch 都必须严格使用 `env` → dynamic deny args → mode-specific `-u` →
共同/mode assignments 的顺序，删除任何 assignment 后才出现的 `-u`。数组 expansion 必须使用上述
Bash 3.2 nounset guard；空 deny array 也不得 abort。

- [ ] **Step 4: clean generalized env 内恢复 slot ingest token**

在 generalized branch 的 scrubbed assignments 中显式加入：

```bash
TEAMLEAD_INGEST_TOKEN="${TEST_TEAMLEAD_INGEST_TOKEN}" \
```

外层 `qa_generalized_exec_with_ingest_token` 继续承担 token 校验和 PID-preserving exec 合同；内层 deny
会移除 helper 注入的 token，因此 assignment 必须只恢复这份已校验 slot token，不能恢复 ambient value。

- [ ] **Step 5: 运行 GREEN**

```bash
bash scripts/__tests__/test-deploy-launch-boundary.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
```

Expected：两条 0 failure；E arm 的 env assertions 证明 production parent value/unknown secret 消失、
同账 slot CommDB 与其他 mandatory coordinates 存在、initial/replay 完整 env 相等；不把 stub HTTP 当
availability gate。

## Task 3：REFACTOR 与相邻回归

**Files:**

- Modify only if a GREEN-preserving clarity fix is necessary:
  `scripts/test-deploy.sh`, `scripts/__tests__/test-deploy-fly1389.test.sh`,
  `scripts/__tests__/test-deploy-launch-boundary.test.sh`,
  `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: 检查三 branch 是否共享同一 deny boundary**

搜索所有 capture site，确认没有一条 branch 缺少共同 deny args；mode 差异只存在于已有 explicit
unsets/assignments/arrays。

`test-deploy-generalized.test.sh` 继续用 hermetic helper runtime 证明 generalized ingest-token contract；
fly1389 runtime env equality 加三 branch source binding 防止 generalized capture 漂移。真实 Bridge 的
availability probe 不进入这些自动套件，交由下面单列的 QA-manual 步骤。

- [ ] **Step 2: 运行所有直接相关 shell tests**

```bash
bash scripts/__tests__/test-deploy-launch-boundary.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash scripts/__tests__/test-cycle-bridge.test.sh
```

Expected：全部 exit 0；任何 SKIP 算未验证，不伪记 PASS。

- [ ] **Step 3: mutation self-check**

在临时副本移除一条共同 deny-args expansion 或 slot CommDB override，运行对应聚焦断言，必须得到 RED；随后删除临时
副本并确认工作树 subject 未改变。不得在被 review/commit 的真实文件上留下 mutation。

- [ ] **Step 4: 提交实现 batch 并更新 ledger**

```bash
git add scripts/test-deploy.sh \
  scripts/__tests__/test-deploy-fly1389.test.sh \
  scripts/__tests__/test-deploy-launch-boundary.test.sh \
  scripts/__tests__/test-deploy-generalized.test.sh
git commit -m "fix(qa): isolate slot Bridge launch environment (FLY-2284)"
```

## QA node 手工 real-Bridge availability verification（不属于 implement 自动 gate）

自动 GREEN 只证明 env assertions 与 hermetic replay，不声称 Bridge availability。QA node 如具备
`~/.flywheel/.env` 内的 `TEST_BOT_TOKEN_N` 与 `~/.flywheel/test-slots.json`，从配置中选择一个当前空闲
slot，把其数字 id export 为 `N`，然后执行以下带强制 finally 的完整步骤：

```bash
set -euo pipefail
: "${N:?QA must export the selected free slot id}"
SLOT_PORT=$(jq -er --argjson n "$N" '.slots[] | select(.id == $n) | .bridgePort' \
  "$HOME/.flywheel/test-slots.json")
CAPACITY_BODY=$(mktemp)
cleanup_real_bridge_probe() {
  rc=$?
  trap - EXIT
  set +e
  scripts/test-teardown.sh "$N"
  teardown_rc=$?
  rm -f "$CAPACITY_BODY"
  if [[ -e "/tmp/flywheel-test-slot-${N}.lock" || "$teardown_rc" -ne 0 ]]; then
    echo "real-Bridge teardown/lock-release verification failed" >&2
    exit 1
  fi
  exit "$rc"
}
trap cleanup_real_bridge_probe EXIT
scripts/test-deploy.sh "$N" --generalized --stub-runner --no-lead
SLOT_TOKEN=$(cat "/tmp/flywheel-test-slot-${N}/state/api-token")
CAPACITY_CODE=$(curl -sS -o "$CAPACITY_BODY" -w '%{http_code}' \
  -H "Authorization: Bearer ${SLOT_TOKEN}" \
  "http://127.0.0.1:${SLOT_PORT}/api/capacity")
[[ "$CAPACITY_CODE" == "200" ]]
jq -e '.generatedAt | type == "string" and length > 0' "$CAPACITY_BODY"
```

probe 必须得到 HTTP 200，且 JSON 的 `generatedAt` 为非空字符串。无论 deploy/probe 成功或失败，都必须
在 shell trap/finally 中执行 `scripts/test-teardown.sh N`，随后断言
`/tmp/flywheel-test-slot-N.lock` 不存在。若 QA machine 缺少上述 prerequisites，QA 必须记录
`real-Bridge probe: not run (prerequisites absent)`；这是诚实的验证缺口，不记作 PASS，也不属于自动套件
的 SKIP。

## Task 4：验证、PR、code review 与 bounded handoff

- [ ] **Step 1: 打开 early PR**

按 Lead 指令在 implementation commit 后尽早 push 并创建 target=`main` 的非 draft PR；body 必须含
Linear link、变更摘要与 test plan。review active 期间不得 push。

- [ ] **Step 2: 单 package / targeted gates**

Lead 已明确禁止 `pnpm -r` 与 packages-wide test。所有 Vitest 命令必须带：

```bash
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1
```

并显式排除 `packages/core/test/tmux-viewer.macos.test.ts`。本改动只有 shell subject，权威 gates 是 Task 3
列出的五条 direct tests；如需 TypeScript build/test，只能运行 `flywheel-teamlead` 单 package 命令。

- [ ] **Step 3: code review**

进入 `code_review` stage。按节点合同尝试 `codex:rescue` review-only 路径，绝不 raw `codex exec`；
有效 gate 按 request-driven 协议注册：

```bash
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead \
  --exec-id f864d584-f8cc-43e5-9a98-b48f4efed3ba --no-block \
  "Code review requested for FLY-2284"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <questionId>
node "$FLYWHEEL_COMM_CLI" check <questionId>
```

`CHANGES_REQUESTED`：批量修 blocking findings，复测、一个 push、开新 question/review；review 在跑时不
push。`APPROVED`：不再产生任何 head-moving commit 或 progress update，advisory 只报告 Lead。

- [ ] **Step 4: milestone literal last commit**

在发起最终 code review 之前创建 `engineering/doc/milestones/FLY-2284.md`，内容含 version、issue、PR、
实现与验证摘要；它必须是 review head 的 literal last commit。不要修改 `CLAUDE.md`。

- [ ] **Step 5: completion audit 与 handoff**

核对 exact reviewed head、PR head、CI、五条 shell gates、设计每项判据与 inbox。用唯一报告通道发送
`DONE: [lead-instruction 21290c3c-7614-4745-ac51-98a529fef399] ...`，随后：

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>
```

不 dispatch QA、不请求 ship approval、不 merge、不 deploy。

## 自审

- Spec coverage：动态危险-key denylist、fixture/真实 caller inventory、显式 CommDB/state/secret/Codex home、未知
  `FLYWHEEL_*` 负控、普通 caller 正控、fixture/GH exception controls、无开关、真实 generalized `/api/capacity`、replay fidelity、
  BSD `env` ordering、PR/review/handoff 均有对应 task。
- Generalized coverage：implement 自动 gate 保持 hermetic（helper runtime + 三 branch source binding）；
  真 Bridge `--generalized --stub-runner --no-lead` availability 属于 QA-manual，带 token 验证 200 +
  `generatedAt`，并在所有路径 teardown/证明 lock 消失。
- Placeholder scan：`<questionId>`/`<NUMBER>` 只能在运行时由 gate/PR 回执替换，不是设计未决项。
- Scope：不修改 capture schema、Bridge product resolver、Lead launcher 或生产配置。
- 类型/名称：统一使用 `BRIDGE_ENV_UNSET_ARGS`、`BRIDGE_EXTRA_ENV`、`TEST_TEAMLEAD_INGEST_TOKEN`、
  `FLYWHEEL_COMM_DB`。
