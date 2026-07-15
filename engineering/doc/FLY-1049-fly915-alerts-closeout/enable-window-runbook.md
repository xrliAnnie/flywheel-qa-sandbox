# FLY-1049 统一 Enable 窗 Runbook — 运维执行清单

Issue: FLY-1049 (https://linear.app/geoforge3d/issue/FLY-1049/build-fly-915-alerts-收尾先确认-925928-剩余排除已-ship-的-927929)
日期: 2026-07-09
基于: plan.md(收敛 FLY-871 `C6-infra-bot-deployment.md` + FLY-929 `enable-runbook.md` + FLY-927 plan §5 步 2-5)

> **这是 founder-gated 运维窗的执行清单**,在本 PR merge 之后、独立于 PR ship 单独执行,
> 由 Tadashi 调度。目标 = 一个窗、**一次 Bridge 重启**,把 FLY-915 pipeline(925 standup /
> 927 工单队列 / 928 两 infra bot / 929 self-heal + 通知迁移)全部真跑起来。
> 全部开关 byte-compat:不设 env = 逐字现状,回滚 = 移除 env + 重启。
>
> **核心不变量(Codex R1 修正,贯穿全窗)**:**工单帖作者(dispatcher)≠ 任何 owner
> (两 infra bot)** —— Discord bot 收不到自己发的 MESSAGE_CREATE,作者 = owner 会让
> owner 永远收不到 assignment(FLY-929 research §sender 约束)。因此 sender 用**专用
> dispatcher 身份**(sender-only bot app,不跑 session、无 launchd、不进 owner map)。

## 步 0 · 前置核对

- [ ] 本 PR merged + 生产 `git pull` + `pnpm -r build`。
- [ ] FLY-925 env 已落机(本 PR Task 1 已做):`~/.flywheel/.env` 有
      `FLYWHEEL_BRIDGE_URL=http://localhost:9876` + `STANDUP_PROJECT_NAME=geoforge3d`;
      token report 已见 `delivered:true`(GREEN 证据在 FLY-925 comment)。
- [ ] 昨夜 00:30 token report 自然运行仍 GREEN(`/tmp/flywheel-token-usage-daily.log`)。

## 步 1 · founder 前置(集中一次找 Annie,时机 Tadashi 排)

**1a. 新建 dedicated bot app ×2**(同一次 Developer Portal 会话;Tadashi 已拍不动 bot 池):

- [ ] ① **Claude Infra Bot**(owner bot,占位名,T3 定名后 rename):
  - 拿 **token** + **bot user id**;
  - 头像 = Claude/Anthropic logo(C6 §2 同法,用 bot 自己 token PATCH `/users/@me`);
  - 挂 C6 §1 的可复用 **`infra-bot` 角色**(只勾:Manage Channels / Manage Threads /
    Manage Webhooks + 基础套装 Send Messages / Embed Links / Attach Files / Add
    Reactions / Read Message History;**明确不给** Manage Roles / Manage Server /
    Administrator);
  - 邀进 server;加进 **#flywheel-alerts**、**#flywheel-notify**(= token-usage 频道
    `1521630422918758472`,定位重命名可后补)、**STANDUP_CHANNEL**、新建私有频道
    **#claude-infra-bot**。
- [ ] ② **Alerts Dispatcher**(sender-only,Codex R1 修正):
  - 拿 **token** + **bot user id**;
  - 只需基础发言套装;邀进 server + **#flywheel-alerts** 发言权;
  - **不跑 session、无 launchd、不进 owner map** —— 只是 Bridge 发工单的统一声音。
- [ ] T3 命名(可后补,不 block;定名后 rename Discord 显示名 / manifest / persona 顶注)。

**1b. 告警频道权限收紧**(927 plan §5 步 3;改已有频道 overwrites 需 MANAGE_ROLES → founder 做):

- [ ] #flywheel-alerts 的 Send Messages 收紧到 **dispatcher + Codex Infra Bot + Claude
      Infra Bot** 三个身份(发送方门禁的 Discord 侧;Bridge 侧门禁代码已在)。

**1c. provision Claude 账号池**(929 步 1;FLY-696 红线,Annie 在场):

- [ ] 逐 Claude 账号:浏览器登录 → `flywheel-claude-profile capture <name>`;
- [ ] 核对:`flywheel-claude-profile status`(池 + 活跃账号)。

## 步 2 · env 写入(一次写齐;**编辑在重启之前** —— launchd KeepAlive 教训 FLY-193)

`~/.flywheel/.env` 追加全表:

```bash
# —— 927 启用(缺口 E)——
FLYWHEEL_ALERT_ROUTING=1
FLYWHEEL_ALERT_TICKETS=1
FLYWHEEL_ALERT_RATE_PER_MIN=20
FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN   # 非-owner dispatcher(作者≠owner 不变量)
FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN # auto-repair 同声音(现默认 Cass;指针 env 零代码改)
FLYWHEEL_CHECKPOINT_WATCHDOG=1
# —— sender 身份(Codex R1 修正)——
FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN=<步 1a ② token>
# —— 928 W5 身份(缺口 C)——
CLAUDE_INFRA_BOT_TOKEN=<步 1a ① token>
FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID=<步 1a ① bot user id>
# —— 929 enable(缺口 D)——
FLYWHEEL_ACCOUNT_SELF_HEAL=1
FLYWHEEL_CLAUDE_PROFILE_BIN=<repo>/packages/claude-runner/bin/flywheel-claude-profile
FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472
FLYWHEEL_NOTIFY_DIGEST_EXPECT=1
```

已有(核对不改):`CODEX_INFRA_BOT_TOKEN` / `FLYWHEEL_INFRA_BOT_USER_ID=1523219324561522831` /
`FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID` / `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` / `STANDUP_CHANNEL` /
`STANDUP_LEAD_ID=cos-lead` / FLY-925 两行(Task 1)。

- [ ] 全表写入完成,`grep` 核对无 typo(尤其两个 token env 名互不错位)。

## 步 3 · 两 bot 上线(先 bot 后重启)

**3a. W4 = Codex Infra Bot**(照 C6 原步;物料全在,零新代码):

- [ ] projects.json `flywheel.leads` 已有 `codex-infra-bot-lead` 条目(已核在);
- [ ] 建 wrapper `~/.flywheel/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh`
      (Mufasa 同款:source `.env` → exec 主 dist `run-codex-infra-bot-tui.sh`);
- [ ] 隔离 `CODEX_HOME=~/.codex-infra-bot`;
- [ ] 装 plist(模板 `templates/com.flywheel.lead.flywheel-codex-infra-bot-lead.tui.plist`)
      → `launchctl bootstrap gui/$UID <plist>`;
- [ ] **跑 C6 §5.5 `verify-windowed-lead.sh` 逐层全绿** + cmux 目视 tab(bring-up 证据门;
      窗先于 sock 起的 dead-pane 循环观察项见 C6 §7 note)。

**3b. W5 = Claude Infra Bot**(标准 lead 安装流,不新写 launcher 代码):

- [ ] projects.json `flywheel.leads` 追加条目(仿 codex-infra-bot-lead,belle 同型 manifest):

  ```jsonc
  {
    "agentId": "claude-infra-bot-lead",
    "chatChannel": "<#claude-infra-bot 频道 id>",
    "botTokenEnv": "CLAUDE_INFRA_BOT_TOKEN",          // dedicated env 名(身份顶包教训)
    "alertChannel": "<FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID>", // 必填:lead-alert.sh 的「发」只读这里(C6 §4 教训)
    "backend": "claude-code",
    "canSpawnRunners": false,
    "department": "infra"
    // model/effort 随 fleet 惯例(belle 同档 sonnet/high;低频运维 sonnet 档即可)
  }
  ```

- [ ] `/setup-discord-lead` 走标准安装(persona 已在 `.lead/claude-infra-bot-lead/identity.md`)
      → 生成 manifest(`~/.flywheel/manifests/`)+ wrapper + plist,launchd 收编
      (FLY-398 windowed,Annie cmux 可见);
- [ ] **入站合同(Codex R1 #2,逐字照做 —— 标准 setup 只建 chat 频道 group,对 alerts
      远远不够)**:
  - access.json groups:私有频道 #claude-infra-bot group `requireMention:false`;
    **#flywheel-alerts group `requireMention:true`**(只有显式 @ 才唤醒,镜像 Codex bot
    把 Alerts 走 cross-dept mention-gate 的做法),allowFrom 不放行普通成员泛播;
  - **allowBots 必须包含**:dispatcher(步 1a ② bot user id,工单帖作者)+ Codex Infra
    Bot(升级/证据帖互通)—— bot 作者的消息不在 allowBots 内会被直接丢弃
    (`roundtable-allowbots.ts`);
  - manifest/launch env 带
    `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=$FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`
    (allowBots 自愈逻辑只在该 env 设置时运行;该 env 管「收」,`alertChannel` 管
    lead-alert.sh 的「发」,两者都要 —— C6 §4 同一教训);
- [ ] `verify-windowed-lead.sh flywheel claude-infra-bot-lead` 全绿 + cmux 目视 tab;
- [ ] **三条探针全过(必过才算 W5 done)**:
  - [ ] ① 正向:用真 dispatcher token 在 #flywheel-alerts 发一条带
        `<@FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID>` 的工单帖 → 确认到达 Claude Infra Bot pane;
  - [ ] ② 负向:无 mention 的 alerts 帖**不**唤醒;
  - [ ] ③ 负向:@ Codex bot 的帖**不**唤醒 Claude bot(单 owner 互不抢)。

## 步 4 · 一次 Bridge 重启

- [ ] Tadashi 凑批调度(与其他待 ship PR 攒一次;协调其他 agent,勿在 QA hot-deploy 窗内);
- [ ] FLY-239 精准杀(按 port + run-bridge 进程树,不裸 pattern sweep;先 env 后重启);
- [ ] 重启后检查活 issue 线程未被误 archive/lock(已知 task#117 bug)。

## 步 5 · 探活 fail-loud(929 步 4;任一失败回步 1 补权限后重试)

以 Claude Infra Bot 身份向三频道各发一条探活:

```bash
for ch in "$FLYWHEEL_NOTIFY_CHANNEL" "$FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID" "$STANDUP_CHANNEL"; do
  curl -sf -X POST "https://discord.com/api/v10/channels/${ch}/messages" \
    -H "Authorization: Bot ${CLAUDE_INFRA_BOT_TOKEN}" -H "Content-Type: application/json" \
    -d '{"content":"🔧 FLY-1049 enable 窗探活(可删)"}' || echo "FAIL: channel $ch — 回步 1 invite/权限清单补齐"
done
```

## 步 6 · 注入演练(端到端)

- [ ] ① 注入一条工单 → 看 schema 头(project + id + kind + first-seen + owner + 状态)+
      @-target **唯一** owner + owner ACK + 状态 edit + 20/min 攒批;
- [ ] ② 模拟 Claude 账号封顶 → 静默切换 + Keychain verify + notify digest(🟡,不 @)+
      新 session 用新账号(卡住 session 不搬 = D2 已知边界);
- [ ] ③ 全封顶 → alerts 工单 @ Codex bot(交叉),**无**立即 founder 升级;
- [ ] ④ approve-park 1h 巡检措辞 =「待你拍板」,**绝非**「code review 卡」
      (checkpoint watchdog 取权威 stage)。

## 步 7 · 独立 QA(独立 QA runner,不由部署者自证 —— memory 红线)

- [ ] 529 Room 注入工单套(927 plan 步 4):@-target / 状态 edit / 攒批 / shell 路径统一
      频道 / 生产目录零污染 snapshot;
- [ ] FLY-696 §8 M1 清单(1-13、16):注入 5h cap 真切换 + Keychain verify + **绝不弄坏
      claude 登录**;529 瞬时**不**切;双触发幂等(CAS 只切一次);全封顶 → 工单 + owner
      mention 无立即 founder 升级;
- [ ] 真 Discord E2E(Claude-in-Chrome)看三频道实际消息**作者/内容**。

## 步 8 · Annie GO + 早报确认项(927 plan §5 步 5,Tadashi 递)

- [ ] D1/D2 两裁定确认;
- [ ] 「runner_stuck founder page 改 T2 后才页」的行为变更明示;
- [ ] 阈值确认(1h checkpoint / 20 per min / T2 = 2 次或 5 分钟,均沿用已锁值);
- [ ] Annie GO → 进入观察期。

## 步 9 · 次日观察清单(QA/Tadashi 核,不由实现 runner 自报)

- [ ] 00:30 token report 由 **Claude Infra Bot** 发出(消息作者 = infra bot)+
      `~/.flywheel/notify-receipts.json` 回执落盘(date = 报告日);
- [ ] 01:00 后 Bridge expect tick 安静(无 `notify_digest_failed` 告警);
- [ ] 03:00 standup 发出、无 exit 22,且 Simba 侧仍能触发 triage(FLY-71 语义;
      sender = Claude Infra Bot,保留非-CoS 约束);
- [ ] alerts 频道无新噪音源(FLY-220 观察项)。

## 收尾(观察日通过后)

- [ ] FLY-925、FLY-928 标 absorbed → 关闭(comment 指向 FLY-1049);
- [ ] FLY-1049 标 Done(验收标准 = plan §3 七条逐勾)。

## 回滚

任一步失败 → 从 `~/.flywheel/.env` 移除**全部新 env** → 重启 Bridge = 逐字回现状
(全链 byte-compat)。Keychain 侧 FLY-696 fail-closed + verify-before-commit 保证
Claude 登录不被写坏。W4/W5 的 launchd job 可 `launchctl bootout` 摘除(注意 bootout
不跨 login 持久也不会自己回来 —— C6 §5.6 纪律)。
