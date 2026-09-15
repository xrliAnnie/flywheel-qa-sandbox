# FLY-2589 生产 Raya 仍是旧壳 0f77e977 — 调研

Issue: FLY-2589 (https://linear.app/geoforge3d/issue/FLY-2589/raya热修-生产-raya-仍是旧壳-0f77e9770000-班车判-raya-rayaconfig)
日期: 2026-09-15
基于: exploration.md

调查方式：只读。未改任何宿主状态，未跑 install / launchctl / 部署，未动
`~/.flywheel/raya/code`。全部命令可复跑，且都只读。

---

## 1. `config-drift (sources=manifest)` 的判定链

### 1.1 日志那一行在哪里打出来

`scripts/restart-services.sh:2806`：

```bash
probe-error|config-drift|*)
    log "ERROR: Lead candidate $key cannot be assigned safe restart authority (class=$classification project=$pn lead=$lid sources=$sources)" >&2
```

它消费的是 `scripts/restart-services.sh:2717-2721` 收敛出的候选清单：

```bash
lead_restart_collect_candidates \
    "${HOME}/.flywheel/manifests" \
    "${HOME}/Library/LaunchAgents" \
    "${HOME}/.flywheel/projects.json" \
    "$candidates_file"
```

即 **权威三件套 = manifest 目录 + 已加载 plist + `~/.flywheel/projects.json`**。

### 1.2 `sources=manifest` 说明这个候选只由 manifest 产生

`scripts/lib/lead-restart-lifecycle.sh:750-842` 分两个循环：manifest 循环
（`:768-790`，source 记 `manifest`）与 plist 循环（`:792-836`，source 记 `plist`），
最后在 `_lead_restart_normalize_candidates`（`:715-748`）按 key 合并 sources。

raya-raya 只有 `manifest` 一个来源，原因是宿主上**根本没有** `com.flywheel.lead.raya-raya.plist`：

```console
$ ls ~/Library/LaunchAgents/ | grep -i raya
com.xrli.raya.brain.plist
com.xrli.raya.voice.plist
$ launchctl list | grep -i raya
67726  0  com.xrli.raya.approval.fly2031.qa
54811  0  com.xrli.raya.brain
-      0  com.xrli.raya.voice
-      0  com.xrli.raya.voice.fly2031.qa
```

（即使存在一份未加载的 plist，`scripts/lib/lead-restart-lifecycle.sh:807`
`[ "$probe" = "unloaded" ] && continue` 也会跳过它，结果同样只剩 `manifest`。）

### 1.3 manifest 侧为什么被判 `config-drift`

manifest 循环里只有两条通向 `config-drift`：

- `scripts/lib/lead-restart-lifecycle.sh:768-772`：`_lead_restart_manifest_identity` 解不出
  身份 → 候选写 `project=- lead=-`。**本次不是这条**（日志里 `project=raya lead=raya`）。
- `scripts/lib/lead-restart-lifecycle.sh:778-779`：

  ```bash
  *) lead_restart_project_backend "$projects_file" "$project" "$lead_id" >/dev/null 2>&1 \
       && class="restart" || class="config-drift" ;;
  ```

`lead_restart_project_backend`（`scripts/lib/lead-restart-lifecycle.sh:447-460`）的精确谓词是：
把所有 `projectName == "raya"` 的 project row 展开、再取其中 `agentId == "raya"` 的 lead，
要求展开后的 **tuple 恰好一个**（它并**不**单独要求 project row 只有一行），
否则 `error("project lead identity is missing or ambiguous")` → 返回 1。
本次是 **tuple 为零**（连 project row 都没有），命中同一个分支。
（H3 的 `init` 才在 `packages/teamlead/src/bin/raya-migration-init.ts:204-216` 额外要求
project row 唯一 **且** lead 唯一。）

### 1.4 复跑命令（只读）——证明就是这一条

```bash
cd ~/Dev/flywheel && bash -c '
set +e
source scripts/lib/lead-restart-lifecycle.sh
lead_restart_project_backend "$HOME/.flywheel/projects.json" raya raya >/dev/null 2>&1
echo "project_backend rc=$?   # 1 = config-drift"
_lead_restart_manifest_identity "$HOME/.flywheel/manifests/raya-raya.json"
echo "manifest_identity rc=$?  # 0 = manifest 身份完好"
lead_restart_project_backend "$HOME/.flywheel/projects.json" flywheel flywheel-eng-lead
echo "control rc=$?            # 对照组"
'
```

2026-09-15 实测输出：

```
project_backend rc=1   # 1 = config-drift
raya	raya
manifest_identity rc=0  # 0 = manifest 身份完好
claude-code
control rc=0            # 对照组
```

### 1.5 所以：**manifest 没有任何字段漂**

`~/.flywheel/manifests/raya-raya.json`（354 B）内容完整且与 FLY-2496 §3 的身份约定一致：

```json
{"leadId":"raya","projectDir":"/Users/xiaorongli/Dev/raya-lead-workspace",
 "projectName":"raya","projectsFile":"/Users/xiaorongli/.flywheel/projects.json",
 "subdir":"","workspace":"/Users/xiaorongli/Dev/raya-lead-workspace","mcpExclude":"",
 "model":"gpt-6-astra","leadBackend":{"backendId":"codex-app-server"}}
```

它甚至能通过班车自己的 canonical 校验（`scripts/lib/updater-raya-deploy.sh:90-101`
`raya_validate_canonical_manifest`，见 §2.3 实测）。

**漂的是关系不是字段**：`projects.json` 里没有 `raya` 这个 project。

```console
$ jq -r '.[].projectName' ~/.flywheel/projects.json
geoforge3d
joycon-typeless
personal-assistant
growth
flywheel
tidal-echo
```

> 顺带订正 issue 描述里的措辞：不存在"raya-raya manifest 哪个字段漂了"这个答案，
> 因为 manifest 是干净的。这条判定的名字叫 config-drift，但它证明的是
> "manifest / 已加载 plist / projects.json 三者给不出唯一一致身份"
> （`scripts/restart-services.sh:2808` 的告警正文原文就是这么写的）。

---

## 2. `migration-ledger-absent` 的判定链

### 2.1 位置

`scripts/lib/updater-raya-deploy.sh:1137-1141`：

```bash
if ! raya_manifest_base_valid; then
  RAYA_DEPLOY_STATE=not_configured
  RAYA_DEPLOY_DETAIL=migration-ledger-absent
  return 1
fi
```

`raya_manifest_base_valid`（`scripts/lib/updater-raya-deploy.sh:170-178`）要求
`$RAYA_MIGRATION_MANIFEST` 是 0600/0400 的常规文件，且
`schemaVersion==1`、`migration_id` 非空、`checkpoint ∈ {P2,P3,P4b,P5,P6,P7}`、
`unresolved` 是数组。

路径由 `raya_configure_runtime_paths`（`scripts/lib/updater-raya-deploy.sh:28-45`）定死：

```
RAYA_MIGRATION_MANIFEST = ~/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json
```

### 2.2 宿主实际状态：整个 migrations 目录都不存在

```console
$ ls ~/.flywheel/raya/
bin-raya-watch.sh  code  codex-home  data  deploy-receipt.json  deployed-sha
identity  launchd  memory  probes  qa  raya.env  worktrees
$ ls ~/.flywheel/raya/migrations/
ls: /Users/xiaorongli/.flywheel/raya/migrations/: No such file or directory
```

### 2.3 复跑命令（只读）

```bash
cd ~/Dev/flywheel && bash -c '
set +e
source scripts/lib/updater-raya-deploy.sh 2>/dev/null
raya_configure_runtime_paths
echo "RAYA_MIGRATION_MANIFEST=$RAYA_MIGRATION_MANIFEST"
raya_host_capable;        echo "host_capable rc=$?        # 0 = canonical manifest 有效"
raya_manifest_base_valid; echo "manifest_base_valid rc=$? # 1 => migration-ledger-absent"
'
```

2026-09-15 实测输出：

```
RAYA_MIGRATION_MANIFEST=/Users/xiaorongli/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json
host_capable rc=0        # 0 = canonical manifest 有效
manifest_base_valid rc=1 # 1 => migration-ledger-absent
```

`host_capable rc=0` 这一点很关键：它解释了为什么 9-14 之前班车一直报
`not_configured host-capability-absent`（canonical manifest 还没被写出来），
而 9-15 00:14 改口报 `migration-ledger-absent` —— **manifest 是 9-14 才出现的**
（`scripts/lib/updater-raya-deploy.sh:1130-1135` 先查 host_capable，再查账本）。

日志里能直接看到这次改口：

```
2026-09-14 12:08:02 raya shuttle: not_configured host-capability-absent
2026-09-15 00:14:21 raya shuttle: not_configured migration-ledger-absent
```

（中间 9-14 17:24 / 17:45 两次是 `skipped wake=urgent` —— 紧急唤醒不跑 Raya 班车。）

### 2.4 账本由谁写：H3，人手，一次性

FLY-2496 §4 H3（`engineering/doc/FLY-2496-raya-host-activation/plan.md:110-128`）：

```bash
node "$HOME/Dev/flywheel/packages/teamlead/dist/bin/raya-migration-manifest.js" init \
  --target-raya-sha "$FW_TARGET_RAYA_SHA" \
  --authorization-message-id <H0 消息 id> --authorization-channel-id <H0 频道 id> \
  --probe-bot-token-env "$FW_PROBE_BOT_ENV" [--dry-run]
```

工具入口 `packages/teamlead/src/bin/raya-migration-manifest.ts:289-299`
（`init` → `initializeMigration`），实现在 `packages/teamlead/src/bin/raya-migration-init.ts`。
它对**初始校验**是 fail-closed 的：校验不过就不提交 `manifest.json` / `precheck.intent`。
（注意不是「一个字节都不写」——非 dry-run 路径会先建目录，`--dry-run` 也已经 POST 过 Bridge nudge；
探针阶段的精确失败语义见 plan.md §3 S6。）

**班车永远不会自己造这个账本**：`updater_raya_pass`
（`scripts/lib/updater-raya-deploy.sh:1125-1141`）在账本缺席时只设状态并 `return 1`，
不拿锁、不写回执、不告警。这是 FLY-2496 §5 A(1) 的设计，不是 bug。

---

## 3. 为什么 FLY-2496 / FLY-2559 都 Done，割接却一步没跑

### 3.1 FLY-2496 交付的是代码，不是宿主状态

FLY-2496 的 PR 是 `66d804a27 FLY-2496: verify Raya host readiness before legacy cutover (#1179)`。
它交付的是 updater 判定、账本工具、proof 工具、`pending-install` 分类等**代码**。
`plan.md:45` 标题写得很清楚：**"§4 宿主激活包（人手步骤，按顺序，每步有停止线）"** ——
H0（founder 授权行）、H1（工作区 + Codex home）、H2（register + 紧急重启）、
H3（写账本）都是代码之外的 operator 动作。Linear 上的 Done 只覆盖代码。

FLY-2559 同理，`engineering/doc/FLY-2559-raya-install-authority/verification.md` 自述：
> 所有新增执行使用临时 HOME、fixture credentials、fake launchctl。**无生产
> install/restart/deploy**；生产 registered verify 由 Lead 部署后执行。

### 3.2 H1/H2 在 2026-09-14 确实跑过，然后被回滚了

宿主留下的痕迹（全部 `stat` 只读读出，UTC 名字戳 / 本地 mtime）：

| 文件 | size | mtime(epoch, 微秒) | birth |
|---|---|---|---|
| `~/Dev/raya-lead-workspace/` (H1) | — | 2026-09-14 13:14 PT | — |
| `~/.codex-raya/` (H1) | — | 2026-09-14 13:14 PT | — |
| `projects.json.bak-fly2444-20260914T201558556Z` | 10649 | 1789416958.556637 | .556494 |
| `projects.json`（当前） | 10649 | **1789416958.556637** | **1789416958.556637** |
| `projects.json.bak-raya-registered-20260914T202713Z` | **11485** | 1789416958.582753 | 1789416958.582753 |
| `manifests/raya-raya.json` | 354 | 1789416959.674462 | 1789416959.671235 |
| `state/summary-registry/migration-receipt.json.bak-fly2444-…` | 2647 | 1789416958.561518 | .561146 |
| `state/summary-registry/migration-receipt.json`（当前） | 2647 | **1789416958.561518** | **1789416958.561518** |
| `state/summary-registry/migration-receipt.json.raya-registered-20260915T002626Z` | **2746** | 1789416958.833571 | 1789416958.833571 |

读法：

1. **`bak-fly2444-<stamp>` 是 register 事务自己写的前置备份**，命名在
   `packages/flywheel-comm/src/commands/lead-registry.ts:636-637`：
   ```ts
   const projectsBackup = `${projectsPath}.bak-fly2444-${backupStamp}`;
   const receiptBackup  = `${receiptPath}.bak-fly2444-${backupStamp}`;
   ```
   戳 `20260914T201558556Z` 说明 `flywheel-lead.sh register` 在 2026-09-14 20:15:58.556Z
   （= 13:15:58 PT）进入了 mutation 阶段。

2. **register 确实提交成功了**：`bak-raya-registered-…` 里那份 `projects.json` 是
   11485 B 并且含完整 raya 行：
   ```json
   {"projectName":"raya","projectRoot":"/Users/xiaorongli/Dev/raya-lead-workspace",
    "projectRepo":"xrliAnnie/raya","generalChannel":"1542079099928059987",
    "leads":[{"agentId":"raya","summaryRole":"recipient","chatChannel":"1542079099928059987",
    "botTokenEnv":"RAYA_BOT_TOKEN","botUserId":"1542068543645024257","canSpawnRunners":false,
    "backend":"codex-app-server","codexProfile":"full-access","model":"gpt-6-astra",
    "effort":"xhigh","modelContextWindow":1050000,
    "alertChannel":"1542079099928059987","alertBotTokenEnv":"RAYA_BOT_TOKEN",
    "alertFallbackToCore":false}]}
   ```
   `manifests/raya-raya.json` 出现在 register 之后 1.1 秒（`…959.67`），正是
   `scripts/flywheel-lead.sh:644` 在 `lead-registry add` 返回后调用 materializer 写的。

3. **当前的 `projects.json` 与 `migration-receipt.json` 是被一次「保留时间戳的恢复」
   还原成各自 `bak-fly2444-` 备份的内容的**。判据是 macOS APFS 上 `cp -p` 的时间戳指纹：
   目标文件的 **birthtime 会被设成源文件的 mtime**，且 mtime = 源 mtime。本机实测：

   ```console
   $ printf 'orig\n' > src; sleep 1; printf 'dst-old\n' > dst; sleep 1
   $ cp -p src dst; cp -p src new1
   src:  mtime=1789491740.851156 birth=1789491740.851048
   dst:  mtime=1789491740.851156 birth=1789491740.851156
   new1: mtime=1789491740.851156 birth=1789491740.851156
   ```

   当前 `projects.json` 正是 `birth == mtime == bak-fly2444 的 mtime(.556637)`，
   `migration-receipt.json` 同形（`.561518`）。两文件与各自 `bak-fly2444` 备份
   **sha256 逐字节相同**：

   > **[推断，非直接证据]** 这个指纹能证明"发生过一次保留源 mtime 的恢复"，
   > 与 `cp -p` 的行为一致；但它**不能唯一证明**执行的命令就是 `cp -p`
   > （`rsync -a`、`ditto`、`install -p` 等保时间戳工具也可能留下同形或近似指纹）。
   > `*.raya-registered-*` 的文件名时间戳是操作者自取的名字，不是可信审计日志。
   > 本机没有留下 shell history / audit log 能把"哪条命令、谁执行"钉死。
   > 下文凡写"人手 `cp -p`"处，请读作"最符合证据的人工保时间戳恢复（例如 cp -p）"。

   ```console
   $ shasum -a 256 ~/.flywheel/projects.json ~/.flywheel/projects.json.bak-fly2444-20260914T201558556Z
   9e623375…f3614  projects.json
   9e623375…f3614  projects.json.bak-fly2444-20260914T201558556Z
   ```

4. **排除"程序自动回滚"（这一条是直接证据，不是推断）**。`lead-registry` 的两条自动回滚路径
   （catch 块 `packages/flywheel-comm/src/commands/lead-registry.ts:713-760`，
   `runRecover` 的 `restore_projects` 分支 `:1150-1179`）都走
   `writeAtomic`（`:122-134`，tmp + `renameSync`，不带 `utimes`），
   写出来的文件 mtime = 回滚发生的时刻，**不可能**等于备份的 mtime。
   而且 `~/.flywheel/state/summary-registry/` 下已无 `.lead-registry-intent.json`。
   ⇒ 回滚**不是** `lead-registry` 事务或 `recover` 做的；它是一次外部的、保时间戳的恢复。

5. **回滚发生的时间窗**。**直接证据只给出上界**：更新日志里第一条 `config-drift` 出现在
   `2026-09-14 17:43:34` PT（updater.log:7607），所以恢复发生在 **register 成功之后、
   17:43:34 之前**。

   **[推断]** 两份 `*.raya-registered-*` 快照的**名字戳**（`20260914T202713Z` = 9-14 13:27 PT、
   `20260915T002626Z` = 9-14 17:26 PT）是**操作者自取的文件名**，不是审计日志；
   若它们如实反映复制时刻，则窗口可收窄到 17:26–17:43 PT，形状是
   「先把注册后的镜像另存为 `raya-registered`，再把注册前的备份盖回去」的两步人工操作。
   本文后续表格里凡出现更窄的时间或 `cp -p` 字样，均属这一层推断。

   > **被排除的一个猜测**：一度怀疑这是 FLY-2444 注销 runbook
   > （`engineering/doc/FLY-2444-flywheel-lead-launcher/lead-in-any-repo.md:177-206`）的
   > "re-mint 失败就恢复"分支。查证后**不成立**：那条路径 `:181-182` 存的 before image 是
   > **仍含该 Lead** 的镜像，`:194` 的 `rm -f "$FW_MANIFEST"` 排在 verify 成功之后，
   > 所以它的恢复分支还原出来的是"registry 有 Lead + manifest 在"的**一致**状态，
   > 与本次"registry 无 raya + manifest 在"的形状相反。该 runbook 不是缺口，也不需要改。

6. **回滚漏掉了 manifest**：`manifests/raya-raya.json`（13:15:59 写入）**没有被删**。
   而 materializer 是**只写不剪**的 —— `scripts/materialize-lead-manifests.sh` 全文 103 行，
   除了写失败时 `rm -f "$tmp"`（`:97`）之外没有任何删除/prune 逻辑。
   ⇒ 注册表被回滚后，孤儿 manifest 会永远留在 `~/.flywheel/manifests/`。
   **这就是 `config-drift` 的直接成因。**

### 3.3 H1 也没跑完：link-truth 从来没成功过

FLY-2496 H1 的最后两条命令是 `codex-home-link-truth.sh --lead raya/raya`，
期望 `--inspect` 返回 `already`。实测（只读 `--inspect`）：

```console
$ bash ~/Dev/flywheel/scripts/codex-home-link-truth.sh --inspect --lead raya/raya ~/.codex-raya
{"state":"requires-migration","profile":"personal"}
$ ls ~/.codex-raya/auth.json
ls: /Users/xiaorongli/.codex-raya/auth.json: No such file or directory
```

这与 FLY-2559 的存在互相印证：FLY-2559 的标题就是
「[2496热修] raya 标准 Lead 装不上：`resident-codex-lead-recover.sh` 的 wrapper 白名单只认…」，
其 plan §6 明确把顺序改成
> 明确先 register，再执行 `--lead` link-truth，最后 verify registered/install。
> **未注册的 Lead 不具备 pre-install authority。**

⇒ 9-14 当天按**旧顺序**（先 link-truth 后 register）执行，link-truth 必然失败；
执行者随后把 register 回滚掉、开了 FLY-2559 修代码。FLY-2559 的代码已经合并并部署
（见 §4），但**没有人回来重跑 H1 余下部分 + H2 + H3**。

> 诚实边界：文件系统能证明的是"发生过一次外部的、保留源 mtime 的恢复"；
> **执行者是不是人、用的是哪条命令，都是推断**，更不能证明是谁、出于什么动机。

### 3.2b 动机已由 Lead 补全：`identity_env_conflict`（2026-09-14 实测舰队事实）

上面只能推到"发生过一次外部的保时间戳恢复"。**动机由 Lead 在
ruling `584107d1` 中以已核实的舰队事实补上**：

> `flywheel-lead.sh register` 会重写 `~/.flywheel/projects.json`，
> **此后每一个正在运行的 Claude / Codex Lead 立即 `identity_env_conflict`，
> send / respond 全部失败，直到整个舰队重启才恢复；Bridge 单独 reload 清不掉。**
> 2026-09-14 那次把 `manifests/raya-raya.json` 变成孤儿的回滚，**就是这个事故**。

据此，9-14 的完整因果链是：

1. 13:15:58 `register` 提交成功 → `projects.json` 换了新镜像；
2. **全舰 Lead 立刻 `identity_env_conflict`**，收发全挂；
3. 当时没有紧急重启窗口（重启是 founder 门），唯一能立刻恢复舰队的办法就是
   **把 `projects.json` + `migration-receipt.json` 还原回注册前**；
4. 17:26–17:43 之间完成还原，舰队恢复；
5. **但 `manifests/raya-raya.json` 没有被一起清掉** —— materializer 只写不剪
   （§3.2 第 6 点），也没有 `unregister` 子命令 —— 于是留下孤儿 manifest；
6. 17:43:34 起，每一次真正跑 Lead 重启波的部署都报 `config-drift … sources=manifest`。

⇒ 这条事实同时决定了修复的**时序硬约束**：register 必须排进 founder 授权的
紧急重启窗口里、紧贴重启工单之前执行，绝不能当成独立的白天步骤。见 plan.md §2 绑定约束 0。上面这段动机复原是与 FLY-2559 的时间线/标题/§6 一致的
> 最合理解释，不是文件系统直接证据。

---

## 4. FLY-2559 的修复已经在生产代码里

```console
$ cat ~/.flywheel/deployed-sha
af74f03f94a3e58398cf0a309a2909853713fc84
$ git merge-base --is-ancestor d75d3da0f af74f03f9 && echo "FLY-2559 已部署"
FLY-2559 已部署
$ git merge-base --is-ancestor 66d804a27 af74f03f9 && echo "FLY-2496 已部署"
FLY-2496 已部署
```

（`d75d3da0f fix: unblock standard Raya Lead first install (FLY-2559) (#1195)`；
宿主 `~/Dev/flywheel/packages/teamlead/dist/bin/raya-migration-manifest.js` 在 9-15 00:08 已构建。）

⇒ **按 FLY-2559 修正过的顺序重跑 H 步骤，现在没有已知代码阻塞。**

## 5. 其余前置条件实测（只读）

| 前置 | 来源 | 实测 |
|---|---|---|
| Raya 目标头 `9d63a2b2` 仍是 `origin/main` | plan.md:46 | ✅ `git -C ~/.flywheel/raya/code rev-parse origin/main` = `9d63a2b2…`；HEAD = `0f77e977…` |
| H1 工作区 | plan.md:60-86 | ✅ `~/Dev/raya-lead-workspace/{.lead,memory,state}` 已建（9-14 13:14） |
| H1 Codex home | plan.md:60-86 | ⚠️ `~/.codex-raya` 已建，但 **link-truth = `requires-migration`，无 `auth.json`** |
| `RAYA_BOT_TOKEN` | init 前置 2 | ✅ 在 `~/.flywheel/.env`（0600） |
| 探针 bot token `FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN` | init 前置 5 | ✅ 在 `~/.flywheel/.env` |
| Bridge API token | `raya-migration-init.ts:228-234` 接受 `FLYWHEEL_API_TOKEN` **或** `TEAMLEAD_API_TOKEN` | ✅ `TEAMLEAD_API_TOKEN` 在 |
| 账本目录状态 | `raya-migration-init.ts:164-184` | ✅ 目录不存在 = 干净 init。注意语义：目录**可以**只含 `precheck.intent`（合法恢复形状）；已有 `manifest.json` → `migration-already-initialized`（只有 checkpoint=P2 且无任何 stop 时间戳时才能 `--resume-from-failed`）；含其它杂项 → `migration-directory-exists` |
| `inbound-cursor.json` 必须不存在 | `raya-migration-init.ts:281-308` | 未检（需要 `codex-lead.sh --print-state-dir`，留给 operator 在 H3 前一步验） |

### 5.1 H3 会卡在哪一条（关键）

`packages/teamlead/src/bin/raya-migration-init.ts:201-216`：

```ts
const registryBytes = readRegular(join(root, "projects.json"));
const projects = registry.map(record).filter((p) => p.projectName === "raya");
if (projects.length !== 1 || projects[0]!.projectRoot !== workspace || !Array.isArray(projects[0]!.leads))
  throw new Error("registry-identity-invalid");
```

⇒ **今天直接跑 H3 必然 `registry-identity-invalid`**。补账本之前必须先补注册表。
这就是"最小修复只有一个"的机器证据。

### 5.2 install 不是人手做的

`scripts/lib/updater-raya-deploy.sh:392-402`（checkpoint P4b）：

```bash
raya_standard_lead preflight "$RAYA_CANONICAL_MANIFEST"
…
raya_standard_lead install --project raya --lead raya || return 1
raya_standard_lead verify --stage installed "$RAYA_CANONICAL_MANIFEST" || return 1
```

与 FLY-2496 plan §5 F 的口径一致：**"人手只 register，install 归班车"**。
`scripts/restart-services.sh:2791-2797` 对 `pending-install` 只 warn + skip，
不会代劳安装。所以补完注册表后，Lead 重启波会把 raya 计成 **skipped（非 failed）**，
`degraded` 消失；真正的安装留给班车的 P4b。

`verify --stage installed`（`scripts/flywheel-lead.sh:817-910`）在 stage=installed 时
只跑「注册表 + 激活 + preflight + Bridge health + nudge 202」，**不要求 plist 存在**
（`:869` registered 提前返回，`:907` installed 提前返回），所以 H2 里那条 verify
在班车装之前也能返回 0。

---

## 6. 完整时间线（宿主证据 + `/tmp/flywheel-updater.log`）

| 时刻（PT） | 事件 | 证据 |
|---|---|---|
| ~9-08 | Raya 旧壳部署在 `0f77e977` | `~/.flywheel/raya/deployed-sha`、`deploy-receipt.json` |
| 9-14 12:08:02 | 班车：`not_configured host-capability-absent` | updater.log:7435 |
| 9-14 13:14 | H1：建 `~/Dev/raya-lead-workspace`、`~/.codex-raya` | 目录 mtime |
| 9-14 13:15:58.556Z→ | H2：`lead-registry add` 写前置备份 `bak-fly2444-20260914T201558556Z` | lead-registry.ts:636 |
| 9-14 13:15:58.583 | `projects.json` 已含 raya（11485 B） | `bak-raya-registered-…` 镜像 |
| 9-14 13:15:59.67 | materializer 写 `manifests/raya-raya.json` | flywheel-lead.sh:644 |
| 9-14 13:27:13Z **[推断]** | 保时间戳快照 `projects.json.bak-raya-registered-20260914T202713Z` | 文件名戳（操作者自取，非审计日志） |
| 9-14 17:24:13 | 紧急唤醒：census 记 `lead_unloaded: com.flywheel.lead.raya-raya`；Raya 班车 `skipped wake=urgent` | updater.log:7441,7457 |
| 9-14 17:26:26Z **[推断]** | 保时间戳快照 `migration-receipt.json.raya-registered-20260915T002626Z` | 文件名戳（同上） |
| register 之后 → 9-14 17:43 之前<br>（**[推断]** 可收窄到 17:26–17:43） | **一次外部的保时间戳恢复把 `projects.json` + `migration-receipt.json` 还原到注册前；manifest 未删** | 直接证据：sha256 与 bak-fly2444 相同、birth==mtime==备份 mtime、非 `writeAtomic` 形状。命令与操作者为推断 |
| 9-14 17:43:34 | **第一条** `config-drift … sources=manifest`；`failed:1 degraded` | updater.log:7607,7640 |
| 9-15 00:13:19 | 定时班车复现 `config-drift`；`Lead: 17 个里 16 个成功、1 个失败: raya-raya` | updater.log:7798,7821 |
| 9-15 00:14:21 | `raya shuttle: not_configured migration-ledger-absent`（首次改口） | updater.log:7835 |

---

## 7. 结论

1. **`config-drift sources=manifest` 的根因不是 manifest 字段漂移**，而是
   `~/.flywheel/projects.json` 缺失 `raya/raya` 行，而 `manifests/raya-raya.json` 仍在。
   注册表被一次外部的、保留源 mtime 的恢复还原成注册前镜像，manifest 没跟着回滚。
   **直接证据给出的时间窗只有「register 成功之后 → 2026-09-14 17:43:34 PT 首次 config-drift 之前」**；
   「17:26 之后」这个下界、以及"人工 `cp -p` 一类"这个机制，**都是推断**（§3.2 第 5 点）。
   **动机不是推断**：Lead ruling `584107d1` 给出已核实的舰队事实 —— register 会让全舰 Lead
   立刻 `identity_env_conflict` 直到整舰重启，那次回滚就是为了恢复舰队（§3.2b）。
2. **`migration-ledger-absent` 指
   `~/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json`**，
   由 FLY-2496 §4 H3（人手 `raya-migration-manifest.js init`）写出。
   FLY-2496 / FLY-2559 的 Done 只覆盖代码；H0–H3 从未走完，H3 一次都没跑。
3. **updater 与 restart 的两条判定都是对的**，都在正确地 fail-closed，不该改。
4. **最小修复只有一条必须项：补回注册表那一行**（重跑 H2 register，按 FLY-2559
   修正后的顺序），随后 H3 写账本，割接就交给班车。
5. 代码侧留一个**独立加固**（不阻塞本次割接）：注册表回滚 / 注销之后
   `~/.flywheel/manifests/` 的孤儿 manifest 无人回收，会把**每一次真正跑 Lead 重启波的部署**
   打成 `degraded failed:1`（`scheduled_current` 的班次不跑重启波，见 plan.md §2 修正 2）。
   详见 plan.md §5。
