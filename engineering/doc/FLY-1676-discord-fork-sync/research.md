# FLY-1676 Discord plugin fork 现场审计 — 调研

Issue: FLY-1676 (https://linear.app/geoforge3d/issue/FLY-1676/chore-把-discord-plugin-fork-整个追平上游-rebase-我们的定制-修好自动同步-founder-裁定不)
日期: 2026-08-10
基于: exploration.md

全部证据为 2026-08-10 上午真机取证(命令 + 原始输出摘录),无推测项;推测处显式标注。

## 1. 三份副本的地形图

| 副本 | 路径 | 角色 | 2026-08-10 状态 |
|---|---|---|---|
| fork 仓(GitHub) | `xrliAnnie/claude-plugins-official` main | 定制的 source of truth | HEAD `e1b061b`(FLY-1437),**含全部定制,非 vanilla** |
| 本地 fork clone | `~/.flywheel/repos/claude-plugins-official` | update 脚本的取货点 | 分支 `fix/FLY-898-core-room-mention-patterns` == origin/main(0/0),内容与 fork main 一致 |
| plugin cache | `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4` | Claude Code 插件安装账本指向的安装位 | fork 版(69331 bytes,48 个标志) |
| **running 副本** | `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/` | **MCP server 实际加载路径** | 反复被冲(见 §3) |

- 标志 grep 口径:`grep -c "allowBots\|FLY-" server.ts` → fork 版 = 48,vanilla = 0。fork server.ts 69331 bytes,vanilla 33549 bytes。
- running 目录**不是 git clone**——它是 Claude Code marketplace 物化目录(整个 `~/.claude` 是 claude-config 仓,但 marketplace 内容不受我们 git 管理)。

## 2. 定制 commit 全量盘点(回答 founder「之前那些改动还有需要吗」)

`git log merge-base..origin/main`(19 个非 merge commit + 1 merge),**全部落在 `external_plugins/discord/` + 1 个 ci commit**,26 files,+6015/−64:

| commit | 内容 | 还需要吗 |
|---|---|---|
| `00b7a45` | **allowBots 白名单**(绕过官方 bot 消息过滤) | ★ 命脉。丢失 = Lead 互通/roundtable/卡片审批全断 |
| `2c18ba7` `8b7723d` `b40e798` | typing indicator keepalive / 跳过自身消息 / 不回复时自动停(FLY-29) | 需要,生产行为 |
| `805b00e` | ci: sync-upstream.yml 每日同步 workflow | 需要(本单要修它) |
| `245942a` `9dc3055` | reply-guard 预防层 + core-channel 豁免(FLY-162/173) | ★ 命脉,mention-gating 依赖 |
| `d70c1ef` | adapter self-clean,去 bun-run wrapper + ppid 父死看护(FLY-183) | 需要,孤儿 adapter 治理 |
| `37f4ef4` | reply/edit_message 接受 `message` 别名(FLY-239) | 需要,防 Lead 参数踩空 |
| `c5977d9` | reply 发送 bounded retry(FLY-306) | 需要,发送可靠性 |
| `3d04a98` `5902c8b` `de6f4f3` `da67f83` `ae12a14` | roundtable thread 全套:reply-in-thread 默认开 / founder 无@浮出 / member-follow / over-spawn 修(FLY-314/569/576/676/578) | ★ 命脉,#leads-roundtable 全靠它 |
| `235eb5b` `10cfe07` | per-group mentionPatterns → id-only core room(FLY-898) | 需要,现行 mention 逻辑 |
| `a4e83cc` | parent archive duration(FLY-1435) | 需要 |
| `e1b061b` | chat-receipt producer(FLY-1437,FLY-1426 收据链的生产端) | ★ 需要,现役收据体系依赖 |

**结论:20/20 全部仍在服役,无一被其他机制替代。**"~9 个定制 commit" 是 issue 里的旧数字。

## 3. 冲成 vanilla 的通路 — 元凶实证

### 3.1 直接证据链

- `~/.claude/plugins/known_marketplaces.json`:`claude-plugins-official` 的 source = `{"source":"github","repo":"anthropics/claude-plugins-official"}`(**上游官方,非 fork**),`lastUpdated: 2026-08-10T16:48:27Z` = 本地 09:48,与冲掉时刻精确吻合。
- 冲掉后目录里的 `.gcs-sha` 文件内容 = 上游 main 当时的 commit sha(09:48 那次 = `99d50137`,上游 2026-08-10 08:22 CDT 的 commit)。
- **调查期间当场复发**:11:23:28 running server.ts 再次变为 33549 bytes / 0 标志,`.gcs-sha` 变为 `50ce8670`(上游 11:17 CDT 的 commit)。上午的 band-aid 恢复被再次抹掉。已当场按 issue 应急手册重跑 `update-discord-plugin.sh` 恢复并验证(check 脚本 OK,48 标志)。

### 3.2 机制定性

- `.gcs-sha` **只存在于官方 marketplace 目录**;其他 github 源 marketplace(everything-claude-code / openai-codex / superpowers-dev / minimalist-entrepreneur)都没有,且它们的 `lastUpdated` 停在 2026-01/03/06 月——github 源 marketplace 不被高频自动刷新。
- 定性:官方 marketplace 走 Anthropic 的 GCS 快照分发特殊通道,刷新频率每天多次(今日至少 09:48、11:23 两次),每次把上游 vanilla 全量铺回 marketplace 目录。〔通道细节属推测,已派 claude-code-guide agent 核实 + plan 里设探针实证〕
- 所以这是**架构性双写者**:Anthropic 分发机制(写 vanilla)vs 我们的 overlay 脚本(写 fork),running 副本的内容取决于谁最后写。

### 3.3 现有防线与缺口

- 防线:`claude-lead.sh:923` Lead 启动 preflight — `check-discord-plugin.sh`(grep allowBots + .fork-sha 比对,cache 与 marketplace 双查)不过则跑 `update-discord-plugin.sh`(fork clone reset → rsync 到 cache + marketplace → bun install → 写 .fork-sha),再查不过则 fail-STOP。**Lead 正常启动路径是自愈的。**
- 缺口 1:Lead 运行中 discord adapter 崩溃重启(FLY-183 场景)→ 直接加载磁盘当前版本,无 preflight。被冲窗口内 = 中招,且每天多次冲掉使窗口常开。
- 缺口 2:冲掉事件本身零告警,全靠事后人肉发现(本次是 fetch_messages 报错才暴露)。
- 缺口 3:`update-discord-plugin.sh` 里 `git reset --hard origin/main` 打在 fork clone 当前分支上(现在恰好停在一个 == main 的 feature 分支),分支指针会被硬移——目前无害,但属于脚本卫生问题。

## 4. Sync Upstream workflow 尸检

### 4.1 失败面

- `gh run list`(100 条,2026-05-03 → 2026-08-10):**100/100 failure**,单次 9–33s。从可查历史起没有一次成功。
- fork main merge-base 停在 2026-04-16 → 最后一次有效同步在 4 月中,与失败史吻合。
- 落后量:`git rev-list --left-right --count upstream/main...origin/main` = **2818 behind / 20 ahead**。

### 4.2 根因(2026-08-10 run 31370250750 日志)

1. rebase 步骤:**成功**(无 conflict——上游没碰 discord,天然正交)。
2. `git push origin main --force-with-lease` →
   `! [remote rejected] main -> main (refusing to allow a GitHub App to create or update workflow '.github/workflows/bump-plugin-shas.yml' without 'workflows' permission)`
   即:workflow 用默认 `GITHUB_TOKEN`(GitHub Actions App 令牌),它**无法推送包含 workflow 文件变更的 commit**;上游在我们 merge-base 之后新增/改动了 `.github/workflows/*`(如 bump-plugin-shas.yml),rebase 后这些 commit 都要经我们的 push 进 fork main → 永久被拒。`permissions: contents: write` 无济于事——`workflows` 权限根本不在 GITHUB_TOKEN 可授予集合里。这与 memory 既有教训「gh token 缺 workflow scope」同族。
3. fork main 无 branch protection(`protected: false`,无 rulesets)——排除了保护规则因素。

### 4.3 告警缺口

- workflow 只在 **conflict** 分支挂了 Discord webhook + gh issue;conflict 从未发生过。
- push 被拒走的是普通 step 失败 → run 红 → **无任何通知**。100 次静默失败因此无人知晓。
- 隐患:conflict 路径处理完(webhook + issue)后 run 结论是绿的,历史上会呈现「成功」——误导。
- `DISCORD_WEBHOOK_URL` secret 从未被实际触发过,有效性未知,需验证。

## 5. 上游 delta 与 rebase 风险

- `git log merge-base..upstream/main -- external_plugins/discord/` = **0 个 commit**。上游 2818 个 commit 全部落在其他插件(bump 类自动 commit 为主)。
- 推论:rebase 我们 20 个 commit 到 upstream/main 上,discord 目录内容应与现 fork main **逐字节一致**(可用 `git diff <old-main> <new-main> -- external_plugins/discord/` 空 diff 作硬验收)。
- 每日 CI 的 rebase 步骤 100 次全过 = 这一推论已被 100 次实证。

## 6. fetch_messages

- 两版都有 `fetch_messages`,都经 `fetchAllowedChannel(chat_id)` 取通道。上游自 4 月未改 discord → 「channel_id undefined not snowflake」这个 vanilla 报错与追平与否无关。
- fork 版 fetch_messages 在生产被 Lead 日常使用;该报错仅在 running 副本被冲成 vanilla 期间出现——即它更可能是**冲掉事件的症状**(vanilla 在我们环境缺配置/字段兼容),而非独立 bug。
- 处置:验收阶段真机调用一次 fork 版 fetch_messages 拉真实频道历史;若 fork 版也复现再立独立 issue(不预设)。

## 7. 插件 id / enabledPlugins 接线面(方向 B 的迁移成本;经 Codex R1 实证修订)

- `~/.claude/settings.json`:`"discord@claude-plugins-official": true`(enabledPlugins,真 authority)
- **`claude-lead.sh:3402`:`--channels plugin:discord@claude-plugins-official` —— 真正的运行时插件选择器**(初稿漏掉的最关键一处,Codex R1 抓出)
- `installed_plugins.json`:`discord@claude-plugins-official` 条目(installPath 指 cache 0.0.4)
- `~/.claude.json` 里的 `discord@claude-plugins-official`:**pluginUsage telemetry,非 authority,不迁移不手改**(初稿误列为迁移面,R1 纠正)
- QA slot 用 isolated `CLAUDE_CONFIG_DIR`(claude-lead.sh 已有 `TEST_SKIP_PLUGIN_FORK_CHECK` + `validate_isolated_claude_config` seam),不与生产共享此账本;pinned-plugin QA fixture 有意使用旧 ID(豁免项)。
- flywheel 仓内 grep `claude-plugins-official`:`claude-lead.sh`(923 preflight 段 + 3402 选择器)/ `restart-services.sh`(fork 检测段,453–526 行)/ `scripts/test-deploy.sh:567`(cache 路径探针)/ `packages/teamlead/scripts/lib/reap-orphan-adapters.sh`(FLY-183 shell backstop 的精确 runtime 路径 allowlist)/ `check|update-discord-plugin.sh`(仅存活于 `~/.flywheel/bin`,**无 repo 源**,且显式不归 `converge-flywheel-bin.sh` 管——迁移时需先给它们建 canonical 源)。

## 8. 研究外包(已回,claude-code-guide agent)

1. **刷新触发时机**:session 启动后随机 0–10 分钟的后台刷新(高置信)。与本机观察吻合——这台机器全天持续起 claude session(Lead/Runner),等效于「每天多次」。可关:`/plugin` UI 的 per-marketplace autoUpdate 开关、全局 `DISABLE_AUTOUPDATER=1`、settings.json `extraKnownMarketplaces.<name>.autoUpdate: false`。这些开关对官方 GCS 通道是否真的生效属中置信 → 进探针。
2. **官方 marketplace 特殊通道**:证据支持按名字特殊走 GCS 快照(`.gcs-sha` 仅官方有;GitHub 仓无新 commit 时也刷新),未见公开文档(中置信)。
3. **source 改指 fork(方向 A)**:〔已被后续证据取代〕Codex design review R1 依据 CLI 2.1.226 binary 实证:`claude-plugins-official` 是 CLI 内建 **reserved marketplace**,只能从 Anthropic 官方源注册、走原生 GCS 通道 → 方向 A 判死,P-1 探针随之删除(plan R1 修订)。
4. **第二 marketplace**:插件 id = `{plugin}@{marketplace-name}` 按 marketplace 命名空间隔离,同名插件跨 marketplace 不冲突(高置信);可在 settings.json 用 `extraKnownMarketplaces` 声明式注册。〔后续收口〕撞名实验(原 B1/P-2)已随 plan R1 修订删除,生产方案收敛 B2 pointer marketplace,唯一探针 P-3。
5. **runtime 位置**:MCP server 主跑 marketplace 目录、cache 为兜底(与 GEO-296 结论一致,高置信)。

完整报告(证据 + 置信度逐项):scratchpad `marketplace-investigation-summary.md`(session 级临时文件,要点已全部折入本文档)。

## 9. 实现期 JIT 复核(2026-08-10 下午)

### 9.1 pointer 的 non-fast-forward 更新语义

隔离 `CLAUDE_CONFIG_DIR` 真 CLI 探针推翻了 plan P-3 的一个乐观假设:同一 plugin version 下,source ref 从 sibling commit A non-fast-forward 改写到 B 后,`claude plugin marketplace update` + `claude plugin update` 会报告 already latest,registry 仍停在 A。也就是说仅靠 `gitCommitSha` 变化不能驱动 CLI 安装新字节。

最终实现把修复收口为一个有界契约:每次安全 upstream sync 在 Discord tree 逐字节守卫通过后,只 bump `external_plugins/discord/.claude-plugin/plugin.json` 的 patch version;workflow 自己维护一个可 amend 的 `chore(discord): advance sync version` tip,避免每次同步都无限增加定制 patch 数。真 CLI 复测:A=`0.0.4` → non-FF B=`0.0.5` 后,update 新建 `0.0.5` installPath,registry SHA 精确等于 B,48 个 fork 标志仍在。

### 9.2 并行 fork 工作处置审计(只读,未 merge/close)

| 项目 | main 是否已覆盖 | 建议(最终由 Tadashi/land 裁定) |
|---|---|---|
| fork PR #14 / FLY-1319 founder-local time | **未覆盖**。`founder-timezone.ts` / `founder_local` 不在 main;PR 当前 CONFLICTING。 | 不折进本单 rebase 集;保留为独立行为变更,先重新确认 FLY-1319 产品需求,需要则另行 rebase + review,否则 close。 |
| fork PR #15 / FLY-802 roundtable archive defaults | **已被 main 的 PR #16 / FLY-1435 (`a4e83cc`)取代**。现役实现为更完整的 `roundtable-archive-policy.ts` + 125 行测试。 | land 时核对语义后 close #15 as superseded;不要把冲突旧实现再叠一次。 |
| 本地 `fix/FLY-1658-discord-access-fail-loud` | **未覆盖**。branch-only 1 commit / 4 files / +704−97,引入 `AccessRuntime` fail-loud 语义。 | founder 2026-08-08 已砍单;默认存档,不折入本单。若未来复活,必须作为独立行为/安全变更重新评审。 |

上述三项都不是当前 fork main 的 20 个现役定制 commit。因而 §2 的结论仍成立:main 上 20/20 需要保留;但不能把“20/20 仍需要”误读成“所有开放/本地分支也应并入”。

### 9.3 实现产物与权限边界

- fork workflow PR: `xrliAnnie/claude-plugins-official#19`;只修 workflow,没有更新 main。
- fork main rebase/force-push、PR #14/#15 处置、FLY-1658 处置均留给 land/QA 的持锁窗口,implement 节点不越权。
- `SYNC_PAT` 当前确实缺失,符合 founder 操作依赖;详情见 `operator-card.md`。

### 9.4 implement 节点验证证据

- fork PR #19 head `e50d02a506d340f1e86c3f5446147c950ce00c69`,GitHub 判定 `MERGEABLE/CLEAN`;workflow/helper 的聚焦测试、`actionlint`、`shellcheck` 全绿。workflow 保持 disabled,implement 节点没有 dispatch 或改写 main。
- Flywheel 聚焦测试:`discord-plugin-ops` 19/19、`discord-plugin-cutover` 18/18、`restart-discord-plugin` 10/10、`update-flywheel-queue` 19/19、`test-deploy-discord-pointer` 3/3、launcher integrity 28/28、core-room pointer capability 21/21、`restart-services` 127/127、Teamlead alert contract/rendering 76/76。
- 全仓门:`pnpm lint` 通过(仅 13 条既有 warning),`pnpm -r build` 通过。`pnpm test:packages:run` 的断言层未发现本单回归,但宿主/runner 层不能记为全绿:core 的 2 个真 Terminal AppleScript 用例被 sandbox GUI 拒绝(排除该文件后 219/219);claude-runner 777/777 通过、2 skipped 后 Vitest `onTaskUpdate` RPC timeout 导致 exit 1;Teamlead/flywheel-comm 的并发 load timeout 用 30s 单 worker 聚焦复跑分别 57/57、44/44 通过。
- 生产 V1–V8(真 webhook、真 sync/rebase、官方刷新、全舰切换、roundtable、`fetch_messages`)仍是 land/QA 的持锁硬门;implement 节点没有用开发机局部变更冒充生产验收。

### 9.5 code review R1 的生产路径修正

R1 在 `840eb036` 发现 7 个 HIGH,该 head 已废弃。修正版用真实形态的 RED 夹具逐项封口:

- process census 不再把 awk 自己算进去,且显式排除 `flywheel-test-*`;manifest/plist 改为 union 后只操作执行时确实 loaded 的生产 authority,不再被无 manifest 的 `codex-infra-bot` 卡死;
- root proof 只把 `leadBackend.backendId=claude-code` 的 loaded Lead 算作 Discord adapter 期望值,并有 120 秒 settle/retry;Codex Lead 仍被停启,但不伪造 adapter 期望;
- legacy snapshot 只要求现役两脚本,精确记录可选文件的存在性;回滚恢复同一 pre-image、校验调用者 SHA 与持久化 SHA 一致、pointer 未安装时不做 uninstall;
- registrar 统一 `bash` 调用;launcher/restart 先核对 `discord@flywheel-plugins/v1` checker contract,所以普通 deploy 若还没进受控 cutover 会在任何服务 mutation 前 fail-stop,不会把舰队启动到不存在的新 selector;
- cutover repo 必须与 Bridge plist 指向的 deployed checkout 相同;命令/path/failure-injection test seam 需显式测试标志,否则在拿 fleet lock 前拒绝;`apply-core-room-mention-gate.sh` 的默认 capability probe 也改为从 pointer checker 解析真实 installPath。

### 9.6 code review R2 的实机归属修正

R2 在 `bd575833` 用本机真实 process tree 证明全机同时存在 Lead、QA、Runner、reviewer/interactive 的 Discord adapters,因此「全机 adapter 总数 = Claude Lead 数」不可成立。修正版:

- census 读取同一份 `pid/ppid/command` snapshot,只把直接父进程含精确 `--agent <loaded production Lead id>` 的 adapter 归给 Lead;`--agent-id` Runner、QA/reviewer 即使从共享 production cache 起进程也不计入,ppid=1 orphan 仍 fail-stop;root proof 复用同一归属函数;
- pre-mutation 先跑现役 legacy checker 的只读验证;rollback 恢复精确 pre-image 后只再验证,不再调用会对 `~/.flywheel/repos/claude-plugins-official` 执行 `reset --hard` 的旧 updater;
- update lock 用内嵌 breaker directory 冻结 lock generation,重读 owner 后才移动 stale 目录,不会偷走检查窗口内刚取得锁的 successor;
- remote 不可达时,checker 先完成 registry/path/三标志本地验证再以 degraded-success 保活;已证明 SHA drift/缺标志仍 fail-stop。core-room probe 会写明失败原因,dry-run 不发 severe alert;
- `update-flywheel.sh` 在 fetch 后、pull 前读取 `origin/main` selector;live checker 仍是 legacy 时拒绝前进,避免无人值守 pull 后 Lead 逐个自重启进 contract crash-loop。

### 9.7 QA FAIL 后的 channel 注册修正

独立 QA 在 PR #802 head `877311b4` 上证明了一个比进程根更深的失败面:`claude --channels plugin:discord@flywheel-plugins` 会按 `(plugin, marketplace)` 精确匹配 approved-channel allowlist;私有 marketplace 不在 ledger 中,因此 CLI 明确写出 `not on the approved channels allowlist` 并跳过 channel 注册。与此同时 Discord adapter 进程仍从 pointer installPath 启动,所以旧的「进程根正确」判据会假绿。

Lead 裁定走 **development-channel 路径**:`plugin:discord@flywheel-plugins` 与现役 `server:flywheel-inbox` 共用一个 `--dangerously-load-development-channels` 参数列表。拒绝 managed settings 方案:它引入机器级 `allowedChannelPlugins` + `channelsEnabled=true` 双键权威,任一配对漂移都会把全 channel 面一起熄火。

这条路线有一个显式硬依赖:**FLY-1679 / PR #801 必须先落地**。v2 Lead carrier 原先没有运行 FLY-109 的确认 poller;若直接扩大 development-channel 列表,冷启动会停在确认框且 launchd 仍显示健康。FLY-1679 提供 v2 专用 poller(只发一个 `1`,确认框消失后才记 `confirmed=1`)和 `SKIP_DEV_CHANNELS_WORKAROUND=1` 真机杠杆。但 PR #801 当前 call site 仍只在 `INBOX_MCP_ENABLED=true` 时起 poller;而 companion/external 角色明确是 `false`,FLY-1676 的 Discord dev channel 却始终存在。因此依赖的可接受版本必须让 poller 跟随「任何 development channel 活跃」(本单合并后等价为无条件),并增加 inbox-false 冷启动测试。本单 cutover preflight 同时断言 development-channel selector 与该 v2 call site,缺一即 fail-stop。

验收口径随之修正:

- pointer adapter 根路径只证明**字节来源**,不再被当作 channel 已注册的证据;
- 真 CLI A/B 必须证明新 selector 无 allowlist 拒绝;
- 在关闭 QA 外部代偿后冷启动 Lead,必须零人工按键且出现可信的 v2 confirmation 证据;
- 最终必须由另一 bot 在隔离房发消息,证明 pointer channel 真把 bot-authored inbound 注入 Lead;拒绝路径作阴性对照。
