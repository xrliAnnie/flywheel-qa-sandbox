# FLY-886 projects.json 编排层折干净：Sub 并入 tidal-echo — 实施计划

Issue: FLY-886 (https://linear.app/geoforge3d/issue/FLY-886/org722-收尾-projectsjson-编排层折干净-删独立-sub-projectasha-挂-tidal-echo-下终态sub)
日期: 2026-07-05
基于: research.md（Codex design review R1+R2 反馈已并入：agent_file 合同、dispatcher 顺序、manifest workspace、锁临界区、876 调用面、回滚表、Lead identity 落 root + 语义 sweep、manifest 原子写）

## 0. 目标与硬边界

**终态**：Sub 不再是独立 project；Asha（agentId `sub-lead` 保留）是 tidal-echo 下与 Ariel 平级的 content lead；Sub 全链路（Lead 认领 `Sub` label → runner 起在 tidal-echo worktree → 真走 sub 专属协议 → PR 到 tidal-echo repo）正常，**QA 实证后才算 done**。

**硬边界（Lead 指令 53875520 / gate 批复，overnight 生效）**：
- 今晚 = **只 prep**：备好精确 diff / apply 脚本 / repo PR / runbook，**绝不 apply projects.json、绝不 bootout/swap launchd、绝不重启 Bridge**。
- 激活 = 早上 founder merge 后、founder 在场的同一窗口（§4 runbook）。
- 绝不自 merge、绝不自 ship。
- 不碰 projects.json 其他 5 个 project 条目。

**三段式分工**：本 design session 只交付 docs（本文件夹，committed）；Implement phase（同 branch）把 §2 的 apply 脚本落成文件、开 §3 的 tidal-echo repo PR、开本仓 docs PR，全部 park 在 ship gate；激活与 QA 在早上窗口执行。

## 1. 交付物总览

| # | 交付物 | 形态 | 归属 |
|---|---|---|---|
| D1 | projects.json 精确改动 + apply 脚本（备份/整段加锁/断言/原子回滚） | `apply/fold-projects.sh`（本文件夹） | FLY-886 |
| D2 | tidal-echo repo PR：root config.yaml 融合 + sub executor 落 root agents 目录 + **Asha identity 落 root .lead/ 并语义 sweep** + 路径 sweep | tidal-echo repo PR | FLY-886（gate Q1=方案A） |
| D3 | Asha manifest 变换 + launchd 换轨 + 激活 runbook（早上窗口） | §4 | FLY-886 |
| D4 | FLY-876 对齐契约（6 plist + REPORT_CHANNEL + **cron 调用面 project 改名**） | §5 | 手递 876 |
| D5 | QA 终态实证清单 | §6 | FLY-886 |

## 2. D1 — projects.json 改动（runtime 手维护文件，无 repo 源 → 备 diff 不 apply）

### 2.1 语义 diff（三个动作，其余字节不动）

1. **删** `projects[]` 中 `projectName=="sub"` 整条（其 generalChannel `1511267947551653918` 的注册随条目消失 = #sub-core 作为夜报落点下线）。
2. **增** Asha lead 条目到 `tidal-echo.leads[]` 尾部 —— **逐字段平移**现 sub 条目（Lead 指令：一个都别漏或错）：

```json
{
  "agentId": "sub-lead",
  "chatChannel": "1511267947551653918",
  "alertChannel": "1511267947551653918",
  "match": { "labels": ["Sub"] },
  "botTokenEnv": "ASHA_BOT_TOKEN",
  "canSpawnRunners": true,
  "department": "content",
  "model": "claude-opus-4-8[1m]"
}
```

3. **并** tidal-echo `memoryAllowedUsers` += `["sub-lead", "sub"]`（Asha 记忆桶 + 历史项目桶）。

不动：tidal-echo 的 `generalChannel`（保持 `1517041708855197908` = #tidal-echo-core，已 cross-check 为注册值）、Triton/Ariel 条目、其他 5 个 project。

### 2.2 apply 脚本（implement phase 落成 `apply/fold-projects.sh`；早上窗口运行）

设计要点（Codex R1 #4）：**read→transform→assert→rename→schema 校验→回滚整段在一次 `config_write_locked` 里**（消除 read-check-write 竞态）；回滚也走同目录 tmp + `mv`（原子）；`trap` 清理；preflight 拒 `FLYWHEEL_PROJECTS` env 覆盖（loadProjects 会优先读它，校验对象会错位）+ 确认 teamlead dist 存在。

```bash
#!/usr/bin/env bash
# FLY-886: fold sub project into tidal-echo in ~/.flywheel/projects.json.
# Entire read-check-write critical section runs under ONE config_write_locked.
set -euo pipefail
PJ="$HOME/.flywheel/projects.json"
FLYWHEEL_REPO="${FLYWHEEL_REPO:-$HOME/Dev/flywheel}"

if [ "${1:-}" != "--locked" ]; then
  # preflights (read-only, outside lock)
  [ -z "${FLYWHEEL_PROJECTS:-}" ] || { echo "refusing: FLYWHEEL_PROJECTS env override is set (loadProjects would validate it instead of the file)" >&2; exit 1; }
  [ -f "$FLYWHEEL_REPO/packages/teamlead/dist/ProjectConfig.js" ] || { echo "refusing: teamlead dist missing — build flywheel first" >&2; exit 1; }
  source "$FLYWHEEL_REPO/scripts/flywheel-config-lock.sh"
  rc=0
  config_write_locked "${FLEET_CONFIG_LOCK_FILE:-$PJ.cfglock}" 30 \
    env FLYWHEEL_REPO="$FLYWHEEL_REPO" bash "$0" --locked || rc=$?
  [ "$rc" -eq 75 ] && echo "config lock busy (EX_TEMPFAIL 75) — retry later, do NOT force" >&2
  exit "$rc"
fi

# ---- locked critical section ----
TS=$(date +%Y%m%d-%H%M%S)
BAK="$PJ.bak-fly886-$TS"
TMP="$PJ.tmp-fly886-$$"          # same dir → rename(2) atomic
RTMP="$PJ.restore-fly886-$$"
trap 'rm -f "$TMP" "$RTMP"' EXIT

cp "$PJ" "$BAK"
echo "backup: $BAK"

jq '
  (first(.[] | select(.projectName=="sub")) | .leads[0]) as $asha
  | map(select(.projectName != "sub"))
  | map(if .projectName == "tidal-echo"
      then .leads += [$asha]
         | .memoryAllowedUsers += ["sub-lead","sub"]
      else . end)
' "$PJ" > "$TMP"

# structural asserts (fail = nothing written)
jq -e 'length == 6' "$TMP" >/dev/null
jq -e '[.[] | select(.projectName=="sub")] | length == 0' "$TMP" >/dev/null
jq -e 'first(.[] | select(.projectName=="tidal-echo")) | .leads | length == 3' "$TMP" >/dev/null
jq -e 'first(.[] | select(.projectName=="tidal-echo")) | .leads[2]
       | .agentId=="sub-lead" and .botTokenEnv=="ASHA_BOT_TOKEN"
         and .chatChannel=="1511267947551653918" and .department=="content"
         and .canSpawnRunners==true and .model=="claude-opus-4-8[1m]"
         and .match.labels==["Sub"]' "$TMP" >/dev/null
jq -e 'first(.[] | select(.projectName=="tidal-echo"))
       | .generalChannel=="1517041708855197908"
         and (.memoryAllowedUsers | index("sub-lead")) and (.memoryAllowedUsers | index("sub"))' "$TMP" >/dev/null

mv "$TMP" "$PJ"   # atomic swap, still under the lock

# full-schema gate; atomic restore on failure (still under the lock)
if ! node --input-type=module -e "
  import {loadProjects} from '$FLYWHEEL_REPO/packages/teamlead/dist/ProjectConfig.js';
  const p = loadProjects();
  if (p.length !== 6) throw new Error('expected 6 projects, got ' + p.length);
  console.log('loadProjects OK:', p.map(x => x.projectName).join(','));
"; then
  cp "$BAK" "$RTMP" && mv "$RTMP" "$PJ"
  echo "FAILED loadProjects — atomically restored from $BAK" >&2
  exit 1
fi
echo "projects.json folded (sub → tidal-echo). Backup kept: $BAK"
```

## 3. D2 — tidal-echo repo PR（runner 侧协议融合，gate Q1 = 方案 A）

**目的**：root `.flywheel/config.yaml`（Blueprint 唯一读取点）目前只有 Ariel 的 `content` agent（labels `["content"]`）。不融合则 Sub issue 的 runner 落到 `default_agent` = Ariel 的 generic executor，sub 专属协议（style-lint、audio_preview 门）**静默丢失** = 终态半残。

### 3.1 root `.flywheel/config.yaml` patch（基于 origin/main 版本）

两个合同约束（Codex R1 #1/#2，均已对源码亲验）：
- **agent_file 必须落 `.flywheel/agents/<dept>/` 且 dept 与 `department:` 一致**（ConfigLoader `validateAgentPath` + `parseAgentDept` 双向校验；指向 `sub/.flywheel/...` 会在 config load 时直接 throw）→ sub executor **复制**到 `.flywheel/agents/content/sub-content-executor.md`（PR 内新文件，sweep 后版本）。
- **AgentDispatcher 按 YAML 插入顺序首匹配**（`Object.entries(agents)`）→ `sub-content` 必须排在 `content` **前面**，否则同带 `Sub`+`content` 双 label 的 issue 会先命中 Ariel。

```yaml
agents:
  sub-content:
    agent_file: .flywheel/agents/content/sub-content-executor.md
    department: content
    match:
      labels: ["Sub"]
  content:
    agent_file: .flywheel/agents/content/content-executor.md
    department: content
    match:
      labels: ["content"]
default_agent: content
```

**匹配决策：`sub-content` 只匹配 `["Sub"]`**，不平移 sub 旧 config 的内容类 label 表（affirmation/pack/copy/publishing/research/audio/肯定语/文案/调研）。理由：每个 Sub issue 必带 `Sub`（路由 label，与 Asha 的 `match.labels` 同源）→ 命中充分；旧表的泛用 label（research/audio/copy）在共享 project 里会把 Ariel 的 issue 误路由。`default_agent: content` 保持 = tidal-echo 泛内容仍归 Ariel。

### 3.2 executor 落地 + 路径 sweep（同一 PR 内）

- 以合并树 `sub/.flywheel/agents/content-executor.md` 为底本**复制**出 `.flywheel/agents/content/sub-content-executor.md`（root 副本 = 活协议；`sub/.flywheel/` 快照不动、只作历史）。
- **sweep 范围 = 副本内全部 repo-root 相对引用**（Codex R1 #3，不止 `content/`）：`content/...`、`./content/...`、`AGENTS.md`、`.agents/`（skills 引用）、反引号内路径、以及副本直接引用的 sub 协议文档 —— 全部改指 `sub/` 前缀下的真实位置（如 `sub/content/scripts/style-lint.sh`、`sub/AGENTS.md`、`sub/.agents/skills/sub-create/...`）。
- **有意例外**：doc_flow 的过程文档落点 `content/doc/<ISSUE>-<slug>/`（root 层，与 Ariel 共用 dept 文件夹）是接受的现状（§3.3），**不 sweep**。
- sweep 后 grep-zero 验证（多形态；FLY-205 教训），范围限定副本文件自身。
- **D2 QA 门（Codex R1 #1）**：PR 里跑真 ConfigLoader 对 resulting `.flywheel/config.yaml` 做 load 校验（agent_file 存在性 + dept 一致性 + labels 合法），不许只靠 YAML 目检。

### 3.3 Asha Lead identity 落 root `.lead/` + 语义 sweep（Codex R2 #1/#2，blocker）

**机制（已亲验）**：`claude-lead.sh:500-535` 从 `${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md`（→ agent.md → fail-fast `exit 1`）解析 Lead persona。projectDir 切到 `~/Dev/tidal-echo` 后，root `.lead/` 只有 Triton/Ariel —— Asha 的 identity 只在 `sub/.lead/sub-lead/identity.md`，**不复制则新 daemon 启动即挂**（"Agent source not found"，launchd crash-loop）。

本 PR 内：
- **复制** `sub/.lead/sub-lead/identity.md` → root `.lead/sub-lead/identity.md`（root 副本 = 活 persona；`sub/.lead/` 归历史快照，与 executor 同一纪律）。
- **语义 sweep（不是纯路径 sweep）**——旧 identity 写着 `generalChannel == chatChannel == #sub`、"顶层 issue-bearing 更新发 #sub"。折后这是错的：`tools.ts` 频道分类先看 project.generalChannel，reply-guard 只豁免 core-channel → Asha 照旧 identity 发顶层帖会被 `channel-top-level` 拒。副本改为：
  - `#sub`（`1511267947551653918`）仍是 Asha 的 chat / audio-preview / Q&A / alert 频道（留守）；
  - **顶层 issue-bearing 报告/主动更新 → `#tidal-echo-core`（`1517041708855197908`，注册 generalChannel）**；
  - 删除 `generalChannel == chatChannel` 及"Sub 是独立 project"相关表述；顺带更新旧 executor 路径引用（`.flywheel/agents/content-executor.md` → 新副本路径）与过时的 department 说明。
- **QA 门**：激活前 `test -f ~/Dev/tidal-echo/.lead/sub-lead/identity.md`（pull 后），并对副本 grep 无 `generalChannel = #sub` / `generalChannel == chatChannel` / "顶层…#sub" 残句。

### 3.4 已知行为 delta（接受并记录，不在本 PR 解决）

- **skills 注入**：sub 旧 config 的 `skills.test_command`（style-lint）是 per-project 的，搬到 tidal-echo root 会波及 Ariel 的 runner → **不搬**。style-lint 本来就是 executor 协议内置的 pre-PR 步骤，协议文档保住即可。delta：SkillInjector 不再给 sub runner 注入 test_command。
- **doc_flow 文件夹混用**：两项目 doc_flow 都是 department=content → Sub runner 的过程文档落 root `content/doc/<ISSUE>-<slug>/`（与 Ariel 同层）。过程文档而已，接受；分流是后续独立议题。
- **checkpoints**：两边完全相同（brainstorm fail-close / question fail-open）→ 零改动。audio_preview 门是 executor-driven（`gate audio_preview --lead sub-lead`），agentId 保留后命令继续有效。
- **双副本**：root 副本是唯一活 executor；`sub/.flywheel/` 整目录为历史快照，QA grep 时排除并注明 intentional。
- `~/Dev/tidal-echo` 工作区有未提交的本地 `roles.runner` 改动（机器本地运营改）：本 PR 基于 origin/main 写，**不吸收**；与本 patch 无行冲突。

## 4. D3 — Asha manifest 变换 + 激活 runbook（早上窗口，founder 在场；今晚零执行）

前置依赖：founder merge D2（tidal-echo PR）+ 本仓 docs PR；FLY-876 同窗口协同。

**manifest 生成方式（Codex R1 #5，已对源码亲验）**：**不用** `materialize-lead-manifests.sh` —— 它把 `.workspace` 写成 project dir（`$pdir`），wrapper 会把它导出成 `LEAD_WORKSPACE`，Asha 会被丢进 `~/Dev/tidal-echo` 而不是她的隔离 workspace。改用**旧 manifest 定向变换**（保 workspace/botTokenEnv/model/backend/chrome/mcp，全部字段延续，只改 projectName/projectDir、去掉 runtime-only pid）。

| # | 步骤 | 命令/要点 | 校验 |
|---|---|---|---|
| 0 | 本地 clone 对齐 | `cd ~/Dev/tidal-echo && git pull --ff-only`（gate Q2：必须真 ff，divergence → 停下上报） | `sub/` 树存在；D2 patch 在 HEAD；`test -f .lead/sub-lead/identity.md`（§3.3 门，缺 = 新 daemon 必挂，停） |
| 1 | drain check + 安静窗口 | 无 active/awaiting 的 sub session；避开 cron 触发点（1:00 / 3:07；早上窗口天然安全） | Bridge dashboard / StateStore |
| 2 | 折 projects.json | 运行 `apply/fold-projects.sh`（§2.2） | 脚本自带断言 + loadProjects OK |
| 3 | 变换生成新 manifest | 下方代码块（原子：同目录 tmp + `jq empty` + 断言 + `mv`，Codex R2 #3） | 断言内嵌于代码块 |
| 4 | 下线旧 identity | `scripts/flywheel-daemon.sh uninstall sub-sub-lead`（bootout + 删 plist）；**必须**归档旧 manifest：`mv ~/.flywheel/manifests/sub-sub-lead.json{,.bak-fly886-$TS}` | 遗留 manifest 会被 `install --all`/restart-services 复活旧 identity —— 归档是必需项非清洁项 |
| 5 | 上线新 identity | `scripts/flywheel-daemon.sh install tidal-echo-sub-lead`（生成 plist + bootstrap，Asha 以新 identity 起） | `flywheel-daemon.sh status`；`/tmp/flywheel-lead-tidal-echo-sub-lead.log` |
| 6 | Bridge 重启 | 批量窗口（Annie 纪律；与 team-lead 对齐当批 PR） | Bridge 读新 projects.json |
| 7 | QA | §6 全跑 | 全 PASS 才报 done |

步骤 3 的可复制命令（表格外，防转义走样）：

```bash
out="$HOME/.flywheel/manifests/tidal-echo-sub-lead.json"
tmp="${out}.tmp.$$"
jq '.projectName="tidal-echo" | .projectDir=(env.HOME+"/Dev/tidal-echo") | del(.pid)' \
  "$HOME/.flywheel/manifests/sub-sub-lead.json" > "$tmp"
jq empty "$tmp"
jq -e '.workspace == env.HOME+"/.flywheel/lead-workspace/sub-lead"
       and .botTokenEnv=="ASHA_BOT_TOKEN"
       and .model=="claude-opus-4-8[1m]"
       and .leadBackend.backendId=="claude-code"
       and (has("pid")|not)' "$tmp" >/dev/null
mv "$tmp" "$out"
```

（直接 `>` 落最终路径会在中断/jq 出错时把半成品留在 manifest 目录，之后的 `install --all` 按文件名枚举会踩雷 —— 同目录 tmp + `mv` 消除该类。）

**会话身份说明（有意为之，非事故）**：exact key 从 `sub-sub-lead` 变 `tidal-echo-sub-lead` → PID/session 文件按新 key 全新开始 = Asha 的 Claude session 在 cutover 时**有意 fresh start**（不迁移旧 session-id 文件）；长期记忆走 mem0（bucket 按 leadId `sub-lead` 键）不受影响，QA §6.7 验证。

顺序不可换：**projects.json → manifest → Asha 换轨 → Bridge 重启**（research §3：Bridge 按 projectName+agentId 找 lead window/CommDB identity，Asha 进程与 Bridge 配置必须同窗口对齐，否则 identity 分裂）。

## 5. D4 — FLY-876 对齐契约（同早上窗口 merge/执行；本 issue 不代做，但契约必须完整）

Codex R1 #6 抓的关键缺口：**cron 调用面不只是路径和频道 —— tick 脚本按 `projectName: "sub"` 调 Bridge/comm，project 删除后会 `project_unknown` 直接失败。** 完整契约如下：

1. **REPORT_CHANNEL → `1517041708855197908`（#tidal-echo-core）**：`sub-create-nightly-tick.sh` 与 `sub-daily-loop-tick.sh`（改合并树 `~/Dev/tidal-echo/sub/content/scripts/` 下的版本）。硬不变量：REPORT_CHANNEL == 已注册 generalChannel，否则夜报被 reply-guard 静默拒。已核实 `1517041708855197908` 是 tidal-echo 注册的 generalChannel（Cass 验证 + 本 runner cross-check 一致）；**无需新建频道/新增注册**（Cass drop-in）。
2. **cron/plist 重指全家族 = 6 个 plist**（本审计新发现，876 文本只列 2 个，漏 4 = 静默断）：sub-create-nightly、sub-daily-loop、growth-improve、growth-learn、growth-report、growth-retro → tick 脚本路径全部从 `~/Dev/sub/content/scripts/` 改指 `~/Dev/tidal-echo/sub/content/scripts/`。
3. **cron 调用面 project 改名（新增，Codex R1 #6）**：全部活跃 tick/growth 脚本与配置里的 `PROJECT="sub"`、`/api/runs/start` POST body `"projectName":"sub"`、`flywheel-comm send/ask --project sub`、growth 侧 `"project": "sub"`、以及残留旧频道 ID `1511267947551653918` → 一律改 `tidal-echo` / `1517041708855197908`。
4. **grep-zero QA（876 验收，范围要准 — Codex R2 #2）**：对**活跃调用面**（tick/growth 脚本、LaunchAgents、growth 配置）扫 `PROJECT="sub"`、`"projectName":"sub"`、`--project sub`、`"project": "sub"` 全零；`1511267947551653918` **只**在 cron/growth 的 report-channel 与 project 调用面里禁（它仍是 Asha 合法的 chat/alert 频道，不能全树全禁）；另对活 identity（root `.lead/sub-lead/identity.md`）单独 grep 无 `generalChannel = #sub` / `generalChannel == chatChannel` / 顶层发 #sub 残句。历史快照（`sub/.flywheel/`、`sub/.lead/`）排除并注明 intentional。
5. **`~/Dev/sub` 处置**：以上全部完成 + 夜报真产出验证之前**不能** archived/失效；之后本地目录标 archived、GitHub repo `xrliAnnie/sub` 标 archived（founder 点头后做，可逆）。

## 6. D5 — QA 终态实证清单（gate 批复原文要求：实证，非自报）

1. Asha 在线为 tidal-echo lead：绿点 + #sub（1511267947551653918）回话；`flywheel-daemon.sh status` 有 `tidal-echo-sub-lead`、无 `sub-sub-lead`。
2. 残留 grep-zero：projects.json 无 `"projectName": "sub"`；manifests/ 与 LaunchAgents/ 无 active 的 `sub-sub-lead`。
3. **派一个真 `Sub` label 的 issue** → 路由到 Asha → runner 起在 `~/Dev/tidal-echo` worktree → Blueprint 选中 `sub-content` agent（evidence/prompt 里 agent_file = `.flywheel/agents/content/sub-content-executor.md`）→ 协议在场（style-lint / audio_preview 门出现在 runner prompt），**不是** Ariel 的 generic executor。
4. **dispatcher 顺序断言（Codex R1 #2）**：构造 `Sub`+`content` 双 label 的用例 → 选中 `sub-content`（YAML 顺序保障生效）。
5. **D2 config load 门**：真 ConfigLoader 对合并后 `.flywheel/config.yaml` load 通过（§3.2）。
6. **identity 门（Codex R2 #1/#2）**：pull 后 `test -f ~/Dev/tidal-echo/.lead/sub-lead/identity.md`；副本语义 sweep 生效（grep 无 §5.4 列的残句）；`tidal-echo-sub-lead` daemon 启动日志无 "Agent source not found"。
7. Triton / Ariel 不受影响（各自频道 spot-check 回话；Ariel 派活正常）。
8. 记忆延续：Asha 能读回折前的 mem0 记忆（bucket 按 leadId `sub-lead` 键，应无损）；同时确认 fresh session 符合 §4 预期。
9. **Asha 顶层发帖路由**：Asha 发一条带 issue token 的顶层更新到 #tidal-echo-core → reply-guard 放行；（对照）确认她知道顶层 issue-bearing 帖不再发 #sub。
10. 夜报链路（876 完成后）：下一次 nightly 真产出投递 **#tidal-echo-core**，reply-guard 放行（顶层帖带 LEARN issue ID 不被静默拒）。
11. 边界用例记录：同带 `Sub`+`Tidal-Echo` 双 label 的 issue → runs-route 判 `multiple` 拒（既有语义，不算回归）。

## 7. 回滚（按激活步骤逐级，覆盖 876 联动面 — Codex R1 #7）

| 已执行到 | 回滚动作 | 回滚后校验 |
|---|---|---|
| §4 步骤 2（projects.json） | 同目录 tmp+`mv` 原子还原 `$PJ.bak-fly886-$TS`（同 §2.2 restore 纪律，走 config lock） | `loadProjects` OK = 7 projects 含 sub |
| §4 步骤 3（新 manifest 已生成） | `rm ~/.flywheel/manifests/tidal-echo-sub-lead.json` | manifests/ 只有 sub-sub-lead |
| §4 步骤 4（旧 identity 已下线） | 还原旧 manifest（`.bak-fly886-$TS` 改回）→ `flywheel-daemon.sh install sub-sub-lead` | `status` 有 sub-sub-lead；Asha 回 #sub |
| §4 步骤 5（新 identity 已上线） | `flywheel-daemon.sh uninstall tidal-echo-sub-lead` + 上一行 | 同上，且无 tidal-echo-sub-lead 残留 |
| §4 步骤 6（Bridge 已重启） | Bridge 再重启一次（读还原后的 projects.json） | Bridge 路由 sub project 恢复 |
| 876 联动（plist/cron/PROJECT/频道 已改） | 逐项还原：plist 路径 → `~/Dev/sub/...`、`PROJECT`/`projectName`/`--project` → `sub`、REPORT_CHANNEL → `1511267947551653918`；`~/Dev/sub` 的 archived 标记撤销 | §5.4 的 grep 模式反向验证（全部指回 sub）+ 下一次 cron 真跑通 |
| tidal-echo PR | revert（config + executor 副本 + identity 副本；identity revert 须与 launchd 回滚同做，否则新 daemon 无 persona） | ConfigLoader load OK（回到 content 单 agent）；回滚后 sub-sub-lead daemon 起得来 |

回滚决策权在 founder/Lead；runner 不自决（FLY-350 M-2 教训）。

## 8. 风险与开放项

| 风险 | 处置 |
|---|---|
| Bridge/Asha 不同步重启 → identity 分裂 | §4 顺序硬约束，同窗口 |
| 旧 manifest 未归档 → `install --all` 复活旧 Asha | §4 步骤 4 是必需项 |
| materialize 误用 → Asha workspace 丢失 | §4 明确禁用 materialize，用旧 manifest 变换（Codex R1 #5） |
| agent_file 指 sub/ 快照 → config load throw | §3.1 副本落 `.flywheel/agents/content/`（Codex R1 #1） |
| root `.lead/sub-lead/identity.md` 缺失 → 新 daemon 启动 fail-fast crash-loop | §3.3 identity 复制 + §4 步骤 0 门（Codex R2 #1） |
| 旧 identity 语义（顶层发 #sub）→ reply-guard 拒 Asha 顶层帖 | §3.3 语义 sweep + §6.9 实测（Codex R2 #2） |
| manifest 半写残留 → `install --all` 踩雷 | §4 步骤 3 原子写（Codex R2 #3） |
| dispatcher 顺序 → Sub+content 误路由 Ariel | §3.1 sub-content 排前 + §6.4 断言（Codex R1 #2） |
| 876 漏 growth-* 4 plist / 漏 project 改名 → 静默断 / project_unknown | §5.2/5.3 显式契约 + §5.4 grep-zero（Codex R1 #6） |
| Ariel 泛用 label 误路由到 sub executor | §3.1 收窄 match 到 `["Sub"]` |
| `git pull` 非 ff | gate Q2：停下上报，不强推 |
| 双 label（Sub+Tidal-Echo）判 multiple | 既有语义，QA 记录（§6.11） |
| apply 脚本竞态/半写 | §2.2 整段单锁 + 原子 swap/restore + trap（Codex R1 #4） |

## 9. 明确不做

- 不改 Asha 的 bot token / 频道 ID / model / canSpawnRunners / agentId。
- 不动 tidal-echo generalChannel、Triton/Ariel 条目、其他 5 个 project。
- 不在本 issue 执行 cron 重指与 ~/Dev/sub 处置（876 归属，§5 契约对齐）。
- 不把 sub 的 `skills.*` 搬进 tidal-echo root config（§3.3 rationale）。
- 不迁移 Asha 的 Claude session-id 文件（§4：有意 fresh start；mem0 记忆不受影响）。
- 不吸收 tidal-echo 工作区未提交的 `roles.runner` 本地改动。
- 今晚不 apply、不重启任何东西（§0 硬边界）。
