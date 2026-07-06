# FLY-886 projects.json 编排层折干净：Sub 并入 tidal-echo — 探索

Issue: FLY-886 (https://linear.app/geoforge3d/issue/FLY-886/org722-收尾-projectsjson-编排层折干净-删独立-sub-projectasha-挂-tidal-echo-下终态sub)
日期: 2026-07-05
基于: 无

## 1. 问题定义

FLY-722 把 Sub 的代码合进了 `tidal-echo/sub/`（PR #21，2026-07-05 01:05Z merged），Discord 频道也已挪到 tidal-echo 分类下。但**编排层没折**：`~/.flywheel/projects.json` 里 `sub` 仍是独立 project（projectRoot=`~/Dev/sub`），Asha（sub-lead）仍作为独立 project 的 lead 挂着。这就是 Annie 看到的「没完全并进去」。

终态（Annie 要的）：**Sub 是 tidal-echo 下与 Ariel 平级的 content lead，不是独立 project。**

⚠️ 红线背景：722 曾误报 done（org 层完就报）。本收尾**必须 QA 确认终态**才算完。

## 2. 已验证的现状（全部实机核实，非猜）

### 2.1 projects.json（`~/.flywheel/projects.json`，数组共 7 个条目）

**`projects[1] = sub`（待删）**：

```json
{
  "projectName": "sub",
  "projectRoot": "/Users/xiaorongli/Dev/sub",
  "projectRepo": "xrliAnnie/sub",
  "memoryAllowedUsers": ["annie", "sub-lead", "sub"],
  "leads": [{
    "agentId": "sub-lead",
    "chatChannel": "1511267947551653918",
    "alertChannel": "1511267947551653918",
    "match": { "labels": ["Sub"] },
    "botTokenEnv": "ASHA_BOT_TOKEN",
    "canSpawnRunners": true,
    "department": "content",
    "model": "claude-opus-4-8[1m]"
  }],
  "generalChannel": "1511267947551653918"
}
```

**`projects[6] = tidal-echo`（目标宿主）**：已有 tidal-echo-cos-lead（Triton，labels `Tidal-Echo-Triage`，canSpawnRunners=false）+ tidal-echo-content-lead（Ariel，labels `Tidal-Echo`，department=content，canSpawnRunners=true）。`memoryAllowedUsers: ["annie", "tidal-echo-cos-lead", "tidal-echo-content-lead", "tidal-echo"]`，generalChannel=Triton 频道 `1517041708855197908`。

### 2.2 Asha 的运行链（launchd → wrapper → manifest → claude-lead.sh）

- plist：`~/Library/LaunchAgents/com.flywheel.lead.sub-sub-lead.plist` → `flywheel-lead-wrapper.sh ~/.flywheel/manifests/sub-sub-lead.json`
- manifest `sub-sub-lead.json`：`projectDir=/Users/xiaorongli/Dev/sub`、`projectName=sub`、`workspace=~/.flywheel/lead-workspace/sub-lead`（Lead 实际 CWD 是这个隔离 workspace，**不在** product repo 里）、`botTokenEnv=ASHA_BOT_TOKEN`、`model=claude-opus-4-8[1m]`
- 命名合同（`ProjectConfig.ts` R5#6）：exact key `${projectName}-${agentId}` 是 manifest / plist / evidence 的文件系统路径组件 → 折进后变 `tidal-echo-sub-lead`，manifest+plist 必须换名重建
- Bridge 侧 `lookupLeadWindowId(projectName, agentId)`（plugin.ts:447）、CommDB runtime 要求 leadId+projectName 一致 → **Bridge 重启（读新 projects.json）与 Asha 重启（读新 manifest）必须同窗口做**，否则 identity 分裂

### 2.3 tidal-echo 本地 clone 落后（阻塞项）

`~/Dev/tidal-echo` HEAD=`b3d0632`，origin/main 已有 `b27229c feat(FLY-722): merge Sub codebase into tidal-echo/sub/ (#21)` **未 pull** —— 本地没有 `sub/` 树。且 `.flywheel/config.yaml` 有未提交的本地改动（加了 `roles.runner: model claude-opus-4-8 / effort high / backend claude-tmux`，机器本地运营改动）。cutover 前必须先 pull（FLY-876 交付 2），pull 与本地 dirty 文件不冲突（722 PR 未碰该文件），但要留神。

### 2.4 repo 侧 Runner 配置未融合（发现的缺口）

tidal-echo root `.flywheel/config.yaml`（origin/main）的 `agents:` 只有 `content`（labels `["content"]`，agent_file=`.flywheel/agents/content/content-executor.md`=Ariel 的 executor）。Sub 的 runner 侧配置（agents 匹配 `affirmation/pack/copy/publishing/research/audio/肯定语/文案/调研`、style-lint skills、audio_preview executor 协议、`--lead sub-lead` gate 命令）只作为快照留在 `sub/.flywheel/` 下，**Blueprint 只读 `<projectRoot>/.flywheel/config.yaml`**，不会读子目录快照。

→ 后果：折完后 Sub 的 issue 由 Asha 派 Runner 时，Blueprint 按 tidal-echo root config 匹配 agent，Sub 的内容类 label 全都不匹配 → 落到 `default_agent: content` = **Ariel 的 executor**，Sub 专属协议（style-lint、audio_preview 门）丢失。

### 2.5 指向 ~/Dev/sub 的活引用全量盘点（去重后）

| 引用 | 归属 |
|---|---|
| `~/.flywheel/projects.json` sub 条目 | **FLY-886（本 issue）** |
| `~/.flywheel/manifests/sub-sub-lead.json` projectDir | **FLY-886** |
| `com.flywheel.sub-create-nightly.plist` → `~/Dev/sub/content/scripts/sub-create-nightly-tick.sh` | FLY-876 |
| `com.flywheel.sub-daily-loop.plist` → `~/Dev/sub/content/scripts/sub-daily-loop-tick.sh` | FLY-876 |
| `com.flywheel.growth-{improve,learn,report,retro}.plist` → `~/Dev/sub/content/scripts/growth-*-tick.sh` | **FLY-876（issue 文本未列，本审计新发现，要同步给 876）** |
| `~/.flywheel/qa-fly684-cfg/...` | QA 残渣，忽略 |

growth-* 4 个 plist 也吃 ~/Dev/sub —— FLY-876 的「先盘点全部引用」家族是 **6 个 plist** 而不是 2 个。~/Dev/sub 在全部重指完成前不能失效。

### 2.6 其他核实点

- Lead workspace `~/.flywheel/lead-workspace/sub-lead/` 按 **leadId** 键 → agentId 不变则零迁移（内含 vault、gemini-video-output）。
- Gate 路由（`flywheel-comm gate --lead sub-lead`）、`.inbox-ready-<agentId>`、mem0 memory bucket 都按 leadId → agentId 不变则全部延续。
- `DepartmentRegistry.classifyIssue`：折后 tidal-echo 三个 lead 的 labels（`Tidal-Echo-Triage` / `Tidal-Echo` / `Sub`）互不相交，单标签 issue 唯一匹配；同时带 `Sub`+`Tidal-Echo` 两标签 → `"multiple"` → runs-route 拒（既有语义，可接受，QA 注意）。
- sub 项目的 `generalChannel`（#sub）随条目删除消失；#sub 变为 Asha 的 chatChannel/alertChannel（Lead 自有频道语义，reply-guard 不受影响；tidal-echo 的 generalChannel 仍是 Triton 频道，不动）。
- Linear 侧：sub config `team_id: LEARN`、tidal-echo `TIDE`，两者都「schema-required 但非 runtime ingestion filter」，真正的路由是 issue label `Sub` + run-start gate → 折后 `Sub` label 在 tidal-echo 项目下唯一命中 Asha，成立。

## 3. 与 FLY-876 的边界（同窗口、分归属）

FLY-876（Backlog，owner=flywheel-eng-lead）= 运营 cutover：cron/plist 重指、`~/Dev/tidal-echo` pull、Asha 工作目录切换、~/Dev/sub 处置、nightly 验证。与本 issue 交付 3/4 重叠。

**划界原则：FLY-886 拥有一切按 lead exact-key 键的东西（projects.json、Asha manifest/plist/重启）+ Bridge 重启 + 终态 QA；FLY-876 拥有内容/growth cron 重指 + 本地 clone pull + ~/Dev/sub 目录处置 + nightly 真产出验证。** 两者同一个安静窗口执行（cutover 时段避开 cron 触发点）。FLY-886 执行依赖「tidal-echo 已 pull」——若 876 未先行，本 issue 执行时把 pull 作为前置步骤代做（纯 fast-forward，无风险）。

## 4. 方案

### 4.1 agentId：保留 `sub-lead`（推荐，不改名）

「保留/规范化」二选一里选**保留**：
- 保留 → lead-workspace、mem0 bucket、gate 路由、Discord bot(ASHA_BOT_TOKEN)、agent registry 名全部零迁移；exact key 自然变为 `tidal-echo-sub-lead`（manifest/plist 换名即可）。
- 改名（如 `tidal-echo-sub-lead`）→ exact key 变 `tidal-echo-tidal-echo-sub-lead`，workspace/memory/gate 全要迁，纯增风险零收益。

### 4.2 projects.json 原子改（备份先行）

一次 jq/脚本事务完成三件事，其余条目字节不动：
1. `sub` 的 lead 条目原样搬进 `tidal-echo.leads[]`（第 3 个 lead）：agentId=`sub-lead`、chatChannel/alertChannel=`1511267947551653918`（#sub，频道已在 tidal-echo 分类下）、`match.labels=["Sub"]`、`botTokenEnv=ASHA_BOT_TOKEN`、`department=content`、`canSpawnRunners=true`、`model=claude-opus-4-8[1m]` —— 全部保持。
2. tidal-echo `memoryAllowedUsers` 并入 `"sub-lead"` 与 `"sub"`（保 Asha 记忆桶 + 历史项目桶可读）。
3. 删除 `projects[1]`（sub 整条）。

改完跑 `loadProjects` 校验（exact-key 冲突、duplicate projectName、SAFE_ID 全过）再落盘。

### 4.3 Asha launchd 换轨

1. 新 manifest `~/.flywheel/manifests/tidal-echo-sub-lead.json`：`projectName=tidal-echo`、`projectDir=~/Dev/tidal-echo`、`workspace=~/.flywheel/lead-workspace/sub-lead`（不变）、其余字段（botTokenEnv/model/leadBackend/mcpExclude/chromeEnabled）从旧 manifest 原样带过。
2. 新 plist `com.flywheel.lead.tidal-echo-sub-lead.plist`（flywheel-daemon.sh 从 manifest 生成，与 Ariel 的同构）。
3. `launchctl bootout` 旧 label → bootstrap 新 label；旧 manifest+plist 备份后移除（不留双驱动）。
4. 顺序：projects.json 落盘 → Asha 换轨重启 → Bridge 重启（同窗口，见 4.5）。

关于「工作目录指到 tidal-echo/sub/」的澄清：Lead 实际 CWD 是隔离 workspace（GEO-286），不是 repo；真正要指对的是 manifest 的 `projectDir`（→ `~/Dev/tidal-echo`）。Runner 干活目录由 projectRoot 决定 → worktrees off `~/Dev/tidal-echo`，代码在 `sub/` 子树 —— 正是终态。

### 4.4 repo 侧 Runner 配置融合（scope 问题，需 Lead 拍板）

§2.4 的缺口两个选项：

- **方案 A（推荐）**：本 issue 加一个小的 tidal-echo repo PR —— root `.flywheel/config.yaml` 增加 `sub-content` agent 条目（labels = `["Sub", "affirmation", "pack", ...]` 沿用 sub 的匹配表，agent_file 指向合并树内的 sub content-executor，department=content），`default_agent` 保持 Ariel 的 content 不变。理由：Annie 红线是「终态必须 QA 确认」——Lead 层认领了但 Runner 派下去拿错 executor 协议，终态就不完整，等于再一次「org 层完就报 done」。
- **方案 B**：只做 projects.json（issue 字面 scope），repo 配置融合开 follow-up issue。风险：折完后第一个 Sub runner 用 Ariel 的 generic executor 跑，style-lint / audio_preview 门丢失，且缺口是静默的。

### 4.5 激活与 QA

- 激活随下次**批量** Bridge 重启（Annie 纪律：多 PR 攒一次重启；863/867-D/869 已 merge，跟 team-lead 对齐批次窗口）。重启顺序：projects.json + Asha 换轨完成后 → Bridge 重启。
- QA（终态确认，全部实测非自报）：Asha 以 tidal-echo lead 身份在线（绿点 + #sub 回话）、`Sub` label issue 正确路由 Asha、runner 起在 tidal-echo worktree、无 `sub` project 残留（projects.json + manifests + plists 三处 grep 零）、无重复 lead、Triton/Ariel 不受影响、六个 cron plist 状态与 876 对账。
- ~/Dev/sub 处置 + GitHub repo `xrliAnnie/sub` 标 archived：QA 过后、founder 点头后做（876 协同项）。

## 5. 明确不做

- 不碰 projects.json 其他 5 个 project 条目（红线）。
- 不改 Asha 的 bot token、频道 ID、model、canSpawnRunners。
- 不动 tidal-echo 的 generalChannel / Triton / Ariel 条目。
- 不在本 issue 里执行 cron 重指（876 归属，同窗口协同）。
- 不删 ~/Dev/sub 目录、不删 GitHub repo（只标 archived，且在 QA 后、founder-gated）。

## 6. 开放问题（brainstorm gate 提给 Lead）

1. §4.4 scope：repo 侧 runner 配置融合进本 issue（方案 A）还是开 follow-up（方案 B）？
2. FLY-876 尚在 Backlog：本 issue 的 implement 阶段是否连带把「~/Dev/tidal-echo pull」作为前置代做？（推荐：是，纯 fast-forward。）growth-* 4 plist 新发现同步给 876。
3. 批量 Bridge 重启窗口：由 team-lead 排（本 issue 只声明依赖），确认。
