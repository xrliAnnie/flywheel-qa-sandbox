# FLY-2259 Raya 脑迁入受管常驻体制 — 调研
Issue: FLY-2259 (https://linear.app/geoforge3d/issue/FLY-2259/cutoverraya-raya-脑迁入受管常驻体制-补三样激活前提注册工作区summary样本pr激活新脑活了再退旧脑2239-的)
日期: 2026-09-02
基于: exploration.md

> 成色标记:✅ Lead 已裁(ask 466d7262,2026-09-02 20:3x PT)· 【实核】本机读码/实测,命令附在各节 · ⬜ 工程判断。
> 所有实测只读:候选 registry、迁移回执、manifest 全在 scratchpad 副本上跑,生产 `~/.flywheel` 零写。

## 0. Lead 裁定(ask 466d7262)

| # | 裁定 | 本文承接 |
|---|---|---|
| 1 | **A**:`com.xrli.raya.brain` 是语音/会议/告警网关不是文本脑,原样保留;「退旧脑」= 退应急面(`bin-raya-watch.sh` 观察窗、手拉的 Raya codex 会话);文本触发语双方可见记为已知边界;退产品 job 是 raya 侧另立单 | §6 |
| 2 | **分 home**:founder 铁律「凭证一体一号」——Lead 体与语音 Codex 腿是两具体,不共用 CODEX_HOME;给 Raya Lead 独立 CODEX_HOME(改 launcher/recover.sh 常量);需 founder 登一次 Codex,写进前提清单第一条,由 Lead 在 plan 出来后向 founder 申请;不允许改写共享 home 让语音线程多出 `lead_actions` 工具 | §2、§3.0 |
| 3 | ③a standalone codex 装到**新 home**(fail-loud 不自动装,由激活步骤显式装,版本对齐 0.153.0-aarch64);③b 注册行同事务跑 `scripts/migrate-summary-registry.sh` 刷新 receipt;占位标签优先用 Linear 真实标签,确无合适再占位并注明零路由副作用 | §3.1、§3.5、§3.6 |
| 4 | InfraBot 纳入的 founder 原话:2026-09-02 06:37Z #flywheel-engineer「InfraBot(Claw)纳入」<https://discord.com/channels/1485787271192907816/1516209714097291335/1544597171095994408>;06:38Z「go + InfraBot 纳」<https://discord.com/channels/1485787271192907816/1516209714097291335/1544597258421665833> | §7 验收项 5 直接引用 |

## 1. 代码地图(本单会碰到的每个脚本/文件)

| 层 | 文件 | 合同(实核) |
|---|---|---|
| 激活门 | `packages/teamlead/scripts/raya-activation-preflight.sh` | 只读 fail-closed。逐项 die:installed CLI + `summary-pr-merge.js`;`projects.json` 唯一 `raya/raya` 且 `codex-app-server`/`full-access`/`canSpawnRunners:false`/`companion` 非 true;`lead-identity resolve` 精确为 `role=cos`、`botUserId=1542068543645024257`、`gpt-5.6-sol`/`xhigh`/`1000000`、`summaryRole=recipient`、`hasSummaryDuty=false`、粒度 per-lead\|per-project;workspace `state/` + `memory/MEMORY.md`;`summary merge --dry-run` 对 `RAYA_SUMMARY_FIXTURE_PR` 返回 `would-merge|would-reconcile` + 40 位 `verifiedHeadSha`;launcher `FLYWHEEL_LEAD_DRY_RUN=1` 到达 `[codex-lead-tui-runtime] DRY-RUN` |
| launcher | `packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh` | `CODEX_HOME` 默认 **`~/.flywheel/raya/codex-home`(本单改为通用规则 `derive_codex_lead_home raya` = `~/.codex-raya`,§2)**;`FLYWHEEL_CODEX_BIN=$CODEX_HOME/packages/standalone/current/codex`;状态目录 `~/.flywheel/state/codex-lead/raya`;硬查 `~/.flywheel/raya/code/IDENTITY.md`、`<workspace>/memory/MEMORY.md`、`<workspace>/state`、`~/.flywheel/raya/data/metrics`;非 dry-run 先 `ensure-home` 再 `exec node codex-lead-tui-runtime.js`;`export FLYWHEEL_ROOT` 让 pane 告警 guard 能找到 `lead-alert.sh` |
| home 装配 | `packages/teamlead/scripts/codex-lead-tui-home.sh ensure-home` | 要求 `auth.json` 已存在(绝不复制凭证)、`packages/standalone/current/codex` 可执行(缺则 die 并打印安装命令);full-access 分支 `write_full_access_config` **整体重写** `config.toml`(只保留 trusted `[projects.*]`),再 `append_full_access_lead_actions_mcp` |
| wrapper | `scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh` | launchd 入口;`set -a; source ~/.flywheel/.env`;先 `host-tmux-selection-gate.sh gate codex-raya` 写回执再 `verify codex-raya`(TTL 300s,targetSha = 主仓 HEAD);门不过 `exit 0` + meta-alert,不出生 |
| plist 模板 | `packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist` | Label 固定;`ProgramArguments = /bin/bash ~/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh`;KeepAlive true、ThrottleInterval 30、日志 `~/.flywheel/logs/lead-raya-raya.log` |
| bin 收敛 | `scripts/converge-flywheel-bin.sh` | `FILES` 闭包含 raya wrapper 与 `resident-codex-lead-recover.sh`;首次安装走 adoption(静默一次,记 `~/.flywheel/state/converge-adoptions/<name>`);**必须从主 checkout `~/Dev/flywheel` 跑**,worktree 会被 FLY-1389 拒写 |
| 恢复 helper | `scripts/resident-codex-lead-recover.sh --project raya --lead raya --probe\|--recover …` | `load_authority`:manifest `~/.flywheel/manifests/raya-raya.json` + plist + projects 三方 digest;wrapper 名 → `EXPECTED_CODEX_HOME`(**raya 现映射 `~/.flywheel/raya/codex-home`;本单把表的值侧换成通用函数 `derive_codex_lead_home <key> $HOME_ROOT`,raya key=`raya`**);【实核 2026-09-02】patrol 从**仓库路径**调它(`resident-codex-lead-patrol.ts:758-768`);`~/.flywheel/bin/` 的副本因 `bin/lib/` 只有 `bounded-run.sh`、`lead-address.sh`、缺 `lead-restart-lifecycle.sh`,`--probe` 恒 rc=10「restart authority library is unavailable」——2216 既有缺口,runbook 一律用仓库路径;`ps eww` 里必须有 `CODEX_HOME=<expected>`;二次核验 pid+lstart+argv 后写 `brain/recovery-receipts.jsonl` 再 bounded `kickstart -k`;等新 pid + 新 generation heartbeat |
| 巡视 | `packages/teamlead/src/bridge/resident-codex-lead-patrol.ts` + `plugin.ts:9019` | 目标 = `findResidentCodexLeadTargets(projects)`,**插件构造时读一次**;默认阈值 startup grace 120s、poll stale 120s、turn stale 30min、heartbeat stale、连败 3;只有 `poll_loop_stalled/turn_stalled/heartbeat_stalled` 是恢复候选;告警 `codex_lead_residency_stalled` 走 `machine/codex-lead-residency` |
| 生命周期 | runtime 内 `ResidentCodexLeadLifecycleObserver` | 只对 `codexResidencyPatrol:true` 的 target 构造;写 `~/.flywheel/state/codex-lead/raya/brain/{lifecycle.jsonl,heartbeat.json}`;registry 读失败 fail-safe 为「不装 observer」 |
| pane 告警 | `packages/teamlead/src/lead-backends/codex/tui-window-alert.ts` | exact allowlist `(flywheel,codex-infra-bot-lead)` 与 `(raya,raya)`;标题「Raya brain」;需 `FLYWHEEL_ROOT` 或 `FLYWHEEL_LEAD_ALERT_SH` 解析到 `lead-alert.sh`,否则 fail-soft 禁用并打日志 |
| 名册校验 | `packages/teamlead/src/ProjectConfig.ts` | `leads[].match` 必须是 `{labels:[非空]}`(第 485 行);`codexResidencyPatrol:true` 要求 `backend=codex-app-server`;`codexProfile ∈ companion\|write-capable\|full-access` |
| summary 回执 | `packages/flywheel-comm/src/summary-registry-migration.ts`、`scripts/migrate-summary-registry.sh`、`scripts/restart-services.sh:198-213,1827` | `verify-activation` 比对 live 投影 digest 与回执 `summaryAssignmentDigest`;不一致 ⇒ `restart-services.sh` 在任何 mutation 前 `exit 1` |
| 告警路由 | `~/.flywheel/.env` `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=1518793447165661254` | shell(`lead-alert.sh:423-426`)与 TS(`LeadAlertNotifier.resolveChannel`)在统一模式下都不看 `alertChannel` ⇒ raya 行不加 `alertChannel` |
| Bridge 其它读点 | `summary-absorption-rider.ts resolveRaya(projects)`、W-2 delivery loop | 同样启动时读一次 ⇒ 注册后要一次 Bridge 重启才有巡视触发与 patrol |

## 2. 分 home 的改动面(✅ Lead 裁定;这是本单唯一的代码改动;✅ founder 2026-09-03 06:44Z 要求通用:「不是为raya专门写一套 而是每个codex lead都是generic的」)

新 home 固定为 **`~/.codex-raya`**,与 `~/.codex-mufasa`、`~/.codex-infra-bot` 同构——但不再各写一个字面量:三者统一为一条规则 **`derive_codex_lead_home <key> [home-root]` = `<home-root>/.codex-<key>`**,放在 `scripts/lib/lead-address.sh`(【实核】它已是 converge `FILES` 闭包与 package 白名单里的共享库,state-bin `~/.flywheel/bin/lib/lead-address.sh` 已存在;三个生产 launcher 已各自 source `canonical-lead-identity.sh`,raya/infra-bot 已导出 `FLYWHEEL_ROOT`,mufasa 补一行同形)。launcher 只声明 `FLYWHEEL_CODEX_LEAD_HOME_KEY`,helper 允许表只保留 wrapper→key。key:mufasa=`mufasa`、infra-bot=`infra-bot`(算出的路径与今天字节相同,零行为变化)、raya=`raya`(=leadId)。⬜ 不按 registry agentId 严格派生:两位存量 Lead 的 home 名早于规则,改名要搬活体凭证目录,越出本单。

| 文件 | 改动 |
|---|---|
| `scripts/lib/lead-address.sh` | 新增 `derive_codex_lead_home <key> [home-root]`(纯函数;key `^[a-z][a-z0-9-]{0,31}$`、home-root 绝对路径,否则 rc 2) |
| `packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh:32` | `CODEX_HOME` 默认字面量 → `. "${FLYWHEEL_ROOT}/scripts/lib/lead-address.sh"` + `FLYWHEEL_CODEX_LEAD_HOME_KEY=raya` + `${CODEX_HOME:-$(derive_codex_lead_home "$FLYWHEEL_CODEX_LEAD_HOME_KEY")}` |
| `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh:65`、`run-codex-infra-bot-tui.sh:67` | 同形接线,key=`mufasa`/`infra-bot`;mufasa 补 `export FLYWHEEL_ROOT`;解析结果与今天相同 |
| `scripts/resident-codex-lead-recover.sh:91-101` | source `$SCRIPT_DIR/lib/lead-address.sh`(不可读 ⇒ fail 10,与 lifecycle lib 同形);case 三行改为 `codex_home_key=…`,`EXPECTED_CODEX_HOME="$(derive_codex_lead_home "$codex_home_key" "$HOME_ROOT")"` |
| `scripts/__tests__/codex-lead-home-rule.test.sh`(新) | 规则单元 + 三个生产 launcher 结构断言 + helper key 与 launcher key 对齐;改前全红 |
| `scripts/__tests__/resident-codex-lead-recover.test.sh:16,67,106` | raya fixture 路径同步改(mufasa 格不动,证明规则复现存量路径);负例「CODEX_HOME 指旧共享 home ⇒ 零 mutation」**必须加**(这正是本单要禁止的形状) |
| 三份 launcher 直跑测试 | mufasa/infra-bot 的假根先改成 raya 同形 `$T/repo/packages/teamlead`(否则 `../..` 落到 `$T` 父目录,链够不着——Codex R6-3),三份各加一行软链 `$REPO/scripts/lib/lead-address.sh`,scrub 补 `unset CODEX_HOME FLYWHEEL_CODEX_BIN FLYWHEEL_CODEX_LEAD_HOME_KEY`;mufasa/infra-bot 各加「envdump `CODEX_HOME` 精确等于既有路径」回归护栏 |
| `packages/teamlead/src/bridge/__tests__/resident-codex-lead-patrol.test.ts:37,261,364,464,498` | 不动(patrol 不解释路径,仅证据透传;Codex R1-11 判为纯 churn) |
| `packages/teamlead/scripts/__tests__/raya-activation-preflight.test.sh:20,56` | 用 `$T/codex-home` 注入,不依赖默认值;加一格「launcher 经 `derive_codex_lead_home` + key=raya 取默认,无 `raya/codex-home`」结构断言 |
| mufasa 四个非生产 launcher(`run-codex-lead-mufasa.sh`/`-tui.sh`/`-fullaccess.sh`/`-writecapable.sh`) | **有意不动**:FLY-398 保留的低层/回滚形态,不在 wrapper→launcher 生产集合里,lifecycle lib 也把 `mufasa-tui.sh` 载体列为 retired |
| `scripts/__tests__/raya-resident-carrier.test.sh` | 不引用 codex-home,零改 |

不动:`~/.flywheel/raya/codex-home`(语音腿的家,原样)、`~/.flywheel/raya/raya.env` 的 `RAYA_CODEX_HOME`、`RAYA_METRICS_DIR`(`context-usage.jsonl` 仍在 `~/.flywheel/raya/data/metrics`,M2-c 指标行仍写这里,不是凭证)。

新 home 出生序(全部 operator 手工,写进 plan 前提清单):
1. `install -d -m 700 ~/.codex-raya`;
2. **founder 登录**(✅ Lead 要求写成可直接转给 founder 的一段,ask d0ba48a7):
   - **哪台机**:生产 Mac(`MacBook-Pro`,跑 Bridge/全部 Lead 的那台,不是别的设备);在她自己的终端里做,不经 runner。
   - **命令**(前后各一行,中间会弹浏览器 OAuth):
     ```bash
     install -d -m 700 ~/.codex-raya
     CODEX_HOME=~/.codex-raya codex login
     ```
     `codex` 就是 PATH 上现有的 `~/.local/bin/codex`(0.153.0);新 home 没有 `config.toml`,不会撞受管 requirements 的载入错误。账号由 founder 按「一体一号」指定(同一个 ChatGPT 账号可以在多个 home 各登一次,每个 home 自己一对 token;⛔ 不复制 `auth.json`——两 home 共用 refresh token 会互相作废,FLY-246)。
   - **登完怎么验**:
     ```bash
     CODEX_HOME=~/.codex-raya codex login status      # 期望输出:Logged in using ChatGPT
     stat -f '%Lp %Su' ~/.codex-raya/auth.json        # 期望:600 xiaorongli
     ```
     证据只记「已登录 + 账号别名 + 时间」,不记 token。
3. standalone 安装:`CODEX_HOME=~/.codex-raya CODEX_INSTALL_DIR=~/.codex-raya/.local/bin sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'`,装完 `~/.codex-raya/packages/standalone/current/codex -V` 应为 0.153.0(或当下 mufasa/infra-bot 同版);检查全局 `~/.local/bin/codex` 未被改指(现指向 mufasa home,是 FLY-513 已知形状,本单不碰),shell profile 若被 installer 追加 PATH 行则还原;
4. `config.toml` 不预写:`ensure-home` 首启会以 full-access 形状生成(空 home ⇒ `cfg={}` 分支)。

## 3. 五项前提:命令与实测

### 3.0 前提 ⓪ 新 home + 登录(✅ 第一条)
见 §2。没有它,launcher 非 dry-run 在 `[ ! -x FLYWHEEL_CODEX_BIN ]` 就退出;dry-run 不查它,所以 **preflight PASS ≠ 能出生**——plan 把 `ensure-home` 单独作为一格。

### 3.1 前提 ① 名册行

候选行(在 FLY-2131 检查单 B 之上加两个字段):

```json
{
  "projectName": "raya",
  "projectRoot": "/Users/xiaorongli/Dev/raya-lead-workspace",
  "projectRepo": "xrliAnnie/raya",
  "memoryAllowedUsers": ["annie", "raya"],
  "generalChannel": "1542079099928059987",
  "leads": [{
    "agentId": "raya",
    "chatChannel": "1542079099928059987",
    "botTokenEnv": "RAYA_BOT_TOKEN",
    "botUserId": "1542068543645024257",
    "canSpawnRunners": false,
    "backend": "codex-app-server",
    "codexProfile": "full-access",
    "role": "cos",
    "model": "gpt-5.6-sol",
    "effort": "xhigh",
    "modelContextWindow": 1000000,
    "summaryRole": "recipient",
    "codexResidencyPatrol": true,
    "match": { "labels": ["raya-lead"] }
  }]
}
```

【实核】
- `lead-identity resolve --projects-file <候选> --project raya --lead raya --format json` ⇒ `role=cos`、`summaryGranularity=per-lead`、`hasSummaryDuty=false`、`summaryAssignmentDigest=643403c6…`,与 preflight 的 jq 断言逐项匹配。
- 不加 `match` ⇒ `validate-projects: INVALID: Project "raya" leads[0].match: must be an object with labels[]`。
- 标签:Linear 现有 69 个标签,含 `raya` 的为零;所有 Raya 题目的 issue(n=20)只带 `Flywheel`(已路由给 flywheel-eng-lead)。未被任何 Lead 路由的现有标签全是通用标签(`docs`、`qa`、`blocked`、`meeting`…),借用任一个都会把带它的 issue 路由给 `canSpawnRunners:false` 的 raya ⇒ 派工失败。⬜ 因此按 Lead 裁定的后半句用占位 `raya-lead`:Linear 里不存在,永不匹配,零路由副作用;plan 注明「若日后有人在 Linear 建同名标签,路由会开始命中」。
- `RAYA_BOT_TOKEN` 在 `~/.flywheel/.env` 已有(count=1);`lead_identity_registry_preflight` 要求 managed lead 有 `botUserId`,候选行有。

写入方式:`scripts/flywheel-config-lock.sh ~/.flywheel/projects.json.cfglock 5 <python3 原子写脚本>`(读 → 断言无 raya → append → 校验 → 同目录 tmp + rename),先 `cp -p` 备份 `projects.json.bak-2259-<epoch>`。

### 3.2 前提 ② 工作区

```bash
install -d -m 700 ~/Dev/raya-lead-workspace ~/Dev/raya-lead-workspace/state
git -C ~/.flywheel/raya/memory status --porcelain   # 必须为空
mv ~/.flywheel/raya/memory ~/Dev/raya-lead-workspace/memory
```

【实核】`~/.flywheel/raya/memory` = `xrliAnnie/raya-memory` checkout,分支 `fly-2029-raya-v1-foundation` 与远端同步,干净;远端 `main` 只有 README(MEMORY.md 在该分支)。FLY-2131 R1 决定「整体迁移,不开二克隆」,本单照办;分支不动(raya 仓事务归 founder,派工令 ③)。

同事务改 `~/.flywheel/raya/raya.env` 两处(FLY-2131 R2-1):
- `RAYA_MEMORY_FILE=/Users/xiaorongli/Dev/raya-lead-workspace/memory/MEMORY.md`
- `RAYA_WORKSPACE_ROOTS_JSON=["/Users/xiaorongli/.flywheel/raya/code","/Users/xiaorongli/Dev/raya-lead-workspace/memory"]`

【实核】brain `config.ts:63-72` 对每个 root `realpathSync.native`,目录缺失即拒起;`com.xrli.raya.brain` 是 `KeepAlive.Crashed=true`,不重启不会读新配置,但**下一次任何崩溃/重启就会拒起**——所以改完必须立刻 `launchctl kickstart -k gui/$(id -u)/com.xrli.raya.brain` 并 `launchctl print` 看到 `state = running`,再看 `brain.stderr.log` 无 config 错误。这一步是本单唯一碰 raya 产品的动作,放在 founder 在场的窗口里(派工令 ④)。`com.xrli.raya.voice` 是按需 job(RunAtLoad false),下次 `/voice` 自然读新 env。

### 3.3 前提 ③ summary PR

- 生产者:`flywheel/flywheel-eng-lead`(Tadashi,`summaryRole=producer`,`hasSummaryDuty=true`,粒度 per-lead)。命令(在他自己的 Lead 会话里,identity env 由 v2 wrapper 投影):

  ```
  flywheel-comm summary --file <summary.md> --project flywheel --period <ISO start>/<ISO end>
  ```

  命令只管路径/合同校验/开 PR;`Facts + Judgment` 由 Lead 本人写(`lead-rules-base/summary-inflow.md`:「the command never generates it」)。同 `{project, author, period}` 重跑 = 更新同一张 open PR。
- 目标路径 `summaries/flywheel/<YYYY-MM-DD>--flywheel-eng-lead--01.md`;frontmatter `project/lead/period`;不得碰 `summaries/` 之外任何文件、不得含可执行物。
- preflight 只跑 `summary merge --dry-run`(零 merge、零回执),open 即可;它同时就是 Raya 首轮吸收的真实未读队列,Raya 上线后会按 IDENTITY.md 读→merge(read receipt,founder-only-authority.md 的窄豁免)。
- ⬜ 为什么不是 design/implement 节点代产:Judgment 是 Lead 的判断,代笔 = 假内容进 `MEMORY.md`。implement 节点的动作是「向 Lead 发 ask 请求产出 + 把返回的 PR 号写进窗口物料」。

### 3.4 前提 ④ standalone codex
见 §2 第 3 步。【实核】`ensure-home:579-583` fail-loud 且不自动装;mufasa/infra-bot 当前 `current -> releases/0.153.0-aarch64-apple-darwin`(9-2 19:22/19:48 由 standalone updater 刷到)。

### 3.5 前提 ⑤ 回执刷新(✅)

【实核,scratchpad 副本】
1. 注册 raya 行后 `verify-activation` ⇒ `summary_registry_projection_mismatch: live 643403c6… ≠ receipt b4be7ea6…`;
2. `assignments.json` = 现回执 16 条 + `{"projectName":"raya","leadId":"raya","summaryRole":"recipient"}`,`projectAggregators` 原样;
3. `FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 flywheel-comm summary-registry migrate --projects-file <副本> --assignments-file <上式> --receipt-file <新回执> --expected-sha256 <副本 sha256>` ⇒ 成功,projects 内容逐字节不变(diff 空),新回执 `summaryAssignmentDigest=643403c6…`;
4. 新回执 + 候选 `verify-activation` ⇒ `{"ok":true,"granularity":"per-lead","summaryAssignmentDigest":"643403c6…"}`。

生产步骤只把路径换成 `~/.flywheel/projects.json` / `~/.flywheel/state/summary-registry/migration-receipt.json`,并经 `scripts/migrate-summary-registry.sh`(自动持 `.cfglock`);先 `cp -p` 备份旧回执。⬜ 顺序:注册行 → 刷新回执,两步之间不得有任何 `restart-services.sh` 运行(00:00/12:00 班车边界避开)。

### 3.6 顺序与 Bridge 重启
- 代码改动(§2)必须先合入 main 并由班车部署到 `~/Dev/flywheel`(wrapper/recover 由 converge 从主 checkout 装;launcher 直接从主 checkout 读)。
- 注册 + 工作区 + 回执刷新 + 出生在同一个窗口里做;窗口落在两班车之间。
- 出生后到下一班车(≤12h)之间:job 活着(KeepAlive 管崩溃),但**假死无人巡视**(patrol 目标在 Bridge 启动时固定)。下一班车重启后 patrol 才覆盖 raya;要立即覆盖只能 founder 单次授权 `bash ~/Dev/flywheel/scripts/request-restart.sh`(唯一正门)。plan 默认等班车,把这段写成明文。

## 4. 出生与「活了」

- 出生:`cp` 模板到 `~/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist` → `plutil -lint` → `launchctl bootstrap gui/$(id -u) <plist>` → `launchctl print gui/$(id -u)/com.flywheel.lead.raya-raya` 有唯一 `pid =`。
- 首启链:wrapper `gate codex-raya`(写 `~/.flywheel/state/host-tmux/codex-raya.json`)→ `verify` → launcher 硬查 → `ensure-home`(在 `~/.codex-raya` 写 full-access `config.toml` + `lead_actions` MCP)→ runtime:无保存 thread ⇒ 新建 thread 并做 bootstrap turn(rollout 持久化)→ tmux `flywheel:raya-raya` 窗口 `codex resume --remote` → REST poll baseline 到 #raya 最新消息(不回放历史)→ observer 写 `online`。
- 「活了」三件:`launchctl print` 唯一 pid;`tmux -L default capture-pane -p -t flywheel:raya-raya` 是真 TUI(不是 tail);`~/.flywheel/state/codex-lead/raya/brain/heartbeat.json` `state=online` 且 `lastGatewayPollStatus=ok` 随时间推进(mufasa 实样:每 3s 一次 `gateway_poll_ok`)。再加 founder 在 #raya 发一句、Raya 回一句(同一 bot 身份,新 Lead 用 REST 发)。
- cmux:`flywheel-cmux-sync.sh` 已认 raya wrapper 为 `codex-tui-cmux`,watcher 会建 `cmux-raya-raya` workspace;首启 log `tui-window: real TUI up (raya-raya, thread …)`。
- pane 告警 guard:首启日志**不应出现** `tui-window-alert: … guard DISABLED`(launcher 已 `export FLYWHEEL_ROOT`,`scripts/lead-alert.sh` 存在);FLY-2216 evidence 用真 launcher env 证过 `armed`。

## 5. 真机验收方法

### 5.1 假死 → 告警 → 自愈(需 patrol 已覆盖 raya,即 Bridge 重启后)
```bash
# 0. 探针(只读):拿 exact pid/lstart/generation/carrier
bash ~/Dev/flywheel/scripts/resident-codex-lead-recover.sh --project raya --lead raya --probe   # 仓库路径(patrol 同款);state-bin 副本缺 lib 恒 rc=10,见 §1
# 1. 假死:对 exact pid 发 SIGSTOP(可逆;随时 kill -CONT 中止)
kill -STOP <pid>
# 2. 观察:heartbeat.json updatedAt 停更;≥120s 后 patrol 归类 poll_loop_stalled / heartbeat_stalled;
#    连败 3 tick(60s cadence)后 #flywheel-alerts 出现 codex_lead_residency_stalled(lead key raya-raya);
#    helper 写 ~/.flywheel/state/codex-lead/raya/brain/recovery-receipts.jsonl(phase=pre_mutation)
#    再 bounded kickstart -k;launchctl print 出现新 pid;heartbeat 出现新 generationId。
# 3. 证据:告警消息链接、receipt 行、新旧 pid+lstart、lifecycle.jsonl 里 generation_lost→online。
```
⬜ 选 SIGSTOP 不选 `kill`:被 kill 的进程 launchd KeepAlive 直接拉回,patrol 看不到「假死」;SIGSTOP 正是 2216 病案的活体假死形状。整个过程 helper 调用面只有 exact label,`grep com.xrli.raya.brain` 在 receipt/日志里必须为零。预计 5–8 分钟(120s stale + 3×60s + kickstart)。

### 5.2 pane 丢失 → 重建
```bash
tmux kill-window -t =flywheel:=raya-raya
# ≤20s:runtime ensureTuiHealthy 重建同名窗口,log "tui-window: real TUI up";cmux workspace 同名复用,不开第二个。
```
告警(`tui_window_lost`)只在连续重建失败后才发;不在生产上故意拆 tmux server 逼它。对齐证据 = allowlist 含 `(raya,raya)`(代码)+ 首启无 DISABLED 日志 + FLY-2216 hermetic 测试(`test-tui-window-lost-alert.sh` PASS)。如实记为「armed 已证、投递未在生产触发」。

### 5.3 告警可达(真 Discord)
5.1 的 `codex_lead_residency_stalled` 本身就是真投递(统一通道 #flywheel-alerts,dispatcher bot)。FLY-2216 evidence 的 529 路径(compiled module + 两个 test bot + 隔离告警频道 1519421055805165842)是**实现节点**无法触碰生产时的替代;本单在生产做一次真的,不再需要 529 房。

### 5.4 语音不受影响(分 home 后的对照)
激活前后各 `shasum ~/.flywheel/raya/codex-home/config.toml`,必须相同;founder 一次 `/voice` 开关(或 `scripts/qa/raya-voice-529.mjs` 一次 c0 control run)证明语音腿照常。这是「raya 产品行为零改」的直接证据。

## 6. 退应急面(✅ A)

| 对象 | 动作 |
|---|---|
| `~/.flywheel/raya/bin-raya-watch.sh` | 观察窗脚本;若有在跑的窗口/进程(`ps -axo pid,command \| grep bin-raya-watch`,现为零)先停,再把脚本挪到 `~/.flywheel/raya/retired-2259/`(不删,可回退) |
| 手拉的 Raya codex 会话 | 现为零(ps/tmux 均无);窗口里再查一次 |
| `com.xrli.raya.brain` | **不动**。它与新 Lead 是「网关 vs 对话」两层。已知重叠:「进入/退出语音模式」文本触发语两边都可见,网关照常拉起/停止语音,新 Lead 可能同时回一句文字;`/voice` 斜杠命令是 interaction,REST poll 看不到,零重叠 |
| `com.xrli.raya.approval.fly2031.qa`(pid 67726,8-30 起)、`com.xrli.raya.voice.fly2031.qa` | FLY-2031 QA 残留 job,不在本单;记入诚实边界建议 QA 侧清理 |

## 7. 验收矩阵(对 issue 五条)

| issue 验收 | 判据 | 证据形式 |
|---|---|---|
| preflight PASS(三样齐) | `RAYA_SUMMARY_FIXTURE_PR=<n> RAYA_LEAD_WORKSPACE=~/Dev/raya-lead-workspace packages/teamlead/scripts/raya-activation-preflight.sh` 打印 `PASS: summary latch, canonical identity, workspace, and TUI launcher` | 命令输出 + projects.json sha256 + 回执 sha256 |
| 常驻 pane 活 + 假死自愈真机 + 告警可达 | §4 三件 + §5.1 全链 | launchctl print、capture-pane、heartbeat 前后、告警链接、receipt 行 |
| 旧脑已退,不存在双脑 | §6:应急面已退;文本脑只有 `com.flywheel.lead.raya-raya` 一个;产品网关保留(✅ A) | ps/tmux/launchctl 清单 + Lead 裁定引用 |
| pane 丢失告警对 raya 生效或明确记录不对齐 | §5.2 | 首启日志 + 重建日志 + 2216 测试引用 |
| InfraBot 决策取 founder 原话 | §0 第 4 行两条消息链接 | 直接引用 |

## 8. 会过期的结论(implement/窗口前复核)
- mufasa/infra-bot standalone 版本 0.153.0(standalone updater 会刷);对齐「当下同版」即可。
- 主仓 HEAD `63154c214`;host-tmux 回执 targetSha 随部署变。
- `~/.flywheel/projects.json` sha256 在窗口开始时重取(`--expected-sha256` 用它)。
- Linear 无 `raya*` 标签(2026-09-02 20:30 PT 查)。
- `~/.flywheel/raya/memory` 干净且分支与远端同步(窗口前再查一次)。
- Raya 仓 `summaries/` 仍只有 README(Tadashi 产出后此项变化)。
- 老 `com.xrli.raya.brain` pid 20817 lstart 8-31 17:43;`raya.env` 改后它会被 kickstart 换 pid。
