# FLY-648 机制底座(新机起步器 + WSL2 真机)— 调研

Issue: FLY-648 (https://linear.app/geoforge3d/issue/FLY-648/epic-flywheel-可移植-可部署产品windows-立即-云端-给别人用的产品)
日期: 2026-07-06
基于: exploration.md

范围:只覆盖 Lead 解除 hold 的两块机制底座 —— ① 新机起步器(fresh-instance starter)② WSL2 真机跑通。部署模型 = **纯自托管(B,Annie 已定)**。上层引导式 onboarding(HL 自动化边界表)不在本文档。

---

## 1. 现有 provisioning 管线的输入契约(逐字审计)

`scripts/provision-fleet-host.sh`(FLY-519 + FLY-650)消费一个 `fleet/` artifact 目录,四件套:

| 文件 | 消费方 | 内容(实际字段) |
|---|---|---|
| `manifest.json` | preflight/deps/repos/launchd/validate | `schemaVersion:1` + `deps[]`(平台化 schema:darwin=brew/linux=apt·dnf·presentCheck/manual)+ `repos[]`(name/slug/targetDir)+ `launchdJobs[]`(label/kind:lead·aux)+ `skills.canonicalRepo` |
| `projects.json` | phase_flywheel-home 拷到 `~/.flywheel/` | ProjectEntry[](见 §2) |
| `env.example` | phase_tokens 拷成 `~/.flywheel/.env` 骨架 + `validate_tokens` 校验 | 所有 env key;secret-bearing key(名字含 TOKEN/SECRET/_KEY 等)非空才放行 launchd |
| `host.json` | phase_flywheel-home 拷到 `~/.flywheel/host.json` | **只带可移植字段**(skillsRepo);platform/supervisorBackend/viewerBackend 刻意省略、目标机按自己 uname 推导 |

关键机制(全部可直接复用,零改动):
- **dry-run 默认**、`--apply` 才动手;`run()` fail-closed(任何命令失败中止全程)。
- **live-fleet guard**:目标机已有带 leads 的 projects.json → 拒绝 `--apply`(防误覆盖)。老公的干净机器天然通过。
- **token gate**:`validate_tokens` 对 env.example 里每个 secret-bearing key 检查 .env 里非空非占位(`__PLACEHOLDER__`/`CHANGE_ME`/`<...>`/`TODO` 等都算没填)→ 不放行 launchd phase。**这就是 fresh-init 的"填完才能继续"闸,已存在。**
- **Linux 路径真的会装**(FLY-650 Codex R1 HIGH-1 修过):`loginctl enable-linger` → `materialize-lead-manifests.sh`(projects.json → per-Lead manifest,不启进程)→ `_fleet_linux_specs`(bridge.service + updater.path/timer + daily-standup.timer + per-lead .service)→ `supervisor_install` 逐个装;validate 用 `systemctl --user is-active` 对同一张 spec 清单核。cmux-watcher darwinOnly 跳过。
- deps 的 linux 映射已齐:tmux/gh/jq/git=apt·dnf,node/pnpm=presentCheck(nvm/corepack),AI CLI(claude/codex/kimi/agy)=manual,cmux=darwin-only。

**⇒ 结论 1:起步器不需要新 provisioner。它 = 一个「从模板+用户参数生成 fleet artifact」的生成器,产物直接喂现有 provision-fleet-host.sh。**

## 2. 一份最小实例的配置面(fresh-init 要生成什么)

### 2.1 projects.json 最小条目(schema 来自 packages/teamlead/src/ProjectConfig.ts)

- `ProjectEntry` 必填:`projectName` / `projectRoot` / `leads[]`;实用必配:`projectRepo`、`generalChannel`、`linear`(可 null)、`memoryAllowedUsers`。
- `LeadConfig` 必填:`agentId` / `chatChannel` / `match.labels`;实用必配:`botTokenEnv`(每 Lead 一个 bot token env 名);**CoS 类 Lead 若 labels 含 PM/Triage 必须显式 `canSpawnRunners:false`**(loadProjects 校验器 throw,不是软约束)。
- 最小 lead set(Lead 已定):**1 CoS + 1 eng lead** → 两个 bot、两个频道 + 一个 generalChannel(可与 CoS chatChannel 复用,tidal-echo 先例)。
- **channel ID / guild ID 在 Discord server 建好前不存在** → 模板必须留显式占位(如 `__FILL_DISCORD_CHANNEL_ID__`),并配一个校验命令在 provision 前查"占位已全部替换"(token gate 只查 secret-bearing key,**查不到** chatChannel 这类非 secret 字段 —— 这是要补的一小块)。

### 2.2 env.example 最小 key 集(对照生产 .env 43 个 key 裁剪)

必需:`<COS>_BOT_TOKEN`、`<ENG>_BOT_TOKEN`(名字按 persona 生成)、`DISCORD_GUILD_ID`、`DISCORD_OWNER_USER_ID`(founder 本人 Discord user id)、`LINEAR_API_KEY`、`LINEAR_WORKSPACE_SLUG`。
可选注释掉:roundtable 系列、alert channel 系列、NOTION/OPENAI 等增强项。
每个 key 带注释:**这个值去哪儿拿**(Discord Developer Portal 哪一页 / Linear Settings 哪一页)。
Claude Code / gh 登录是交互式 CLI 登录、不进 .env —— 属引导清单步骤。

### 2.3 manifest.json 模板

- `deps[]`:照抄 fleet-capture.sh 的 DEPS_JSON(linux 映射已验)。
- `repos[]`:flywheel 本体(slug=xrliAnnie/flywheel,targetDir=Dev/flywheel)+ 用户项目 repo(slug 用户给或留空=手动 clone,provisioner 对空 slug 已有 warn+跳过路径)。
- `launchdJobs[]`:linux 路径其实不读它(用 `_fleet_linux_specs` 构造),darwin 路径才逐条 narrate —— 模板给最小 aux 集即可。
- `skills.canonicalRepo`:默认 xrliAnnie/flywheel-skills(私有 → 见 §4 访问问题)。

### 2.4 用户项目 repo 骨架

`scripts/setup-new-project.sh`(FLY-284)已是"文件系统-only、幂等、founder-gated cutover 清单"的项目骨架生成器(.flywheel/config.yaml + .lead identity + doc-flow,`--two-layer` 生成 CoS+dept 双 Lead 骨架)。**起步器直接复用它**生成老公项目的骨架,不重写。

## 3. WSL2 真机跑通:已有什么、缺什么

已有(全部从没在真机跑过):
- `scripts/linux-preflight.sh`:WSL2/systemd 证据包(systemd=true、`systemctl --user` 可用、XDG_RUNTIME_DIR、linger、非 /mnt/c、PATH、登录态、网络探活、token 文件存在性不打印值)。
- runbook §E:E.1 概念差异 / E.2 新 Linux·WSL2 机步骤 / E.3 D3=B founder-run 验收循环。
- hermetic 测试 111 个(stub systemctl/apt),但 hermetic ≠ 真机。

缺:
- **一次真实执行**。可预期的真机坑类型(hermetic 盖不到):WSL2 内存上限(.wslconfig,fleet 是内存游戏)、Windows 防火墙/网络、apt 里 `gh` 不在默认源(要加 GitHub CLI apt repo —— DEPS_JSON 写 `apt:"gh"`,Ubuntu 默认源装的是旧版或没有,**这是一个已可预判的坑**)、node/pnpm presentCheck 在裸 Ubuntu 上不满足(要先装 nvm/corepack,runbook 要写清)、Claude Code CLI 在 WSL2 的登录流程(浏览器跳转回环)。
- 真机执行者:runner 够不到真机(同 FLY-650 D3=B 模型)→ founder-run + 证据包回贴 + runner 修 + 再跑。**验证机顺序待 Annie 答(exploration D-A),不阻塞起步器的设计与 POC。**

## 4. 自托管(B)下的外部资源清单(引导清单的内容源)

老公实例需要的外部资源,全部他/Annie 经手(runner 碰不了 OAuth):

1. **Discord**:建 server → Developer Portal 建 2 个 App/Bot(CoS + eng)→ 开 MESSAGE CONTENT intent → 邀请进 server(权限 scope 同 discord-bot-pool 的 invite-url 形态)→ 建频道(#cos-chat / #eng-chat / #general)→ 抄 guild/channel/user ID(开发者模式)。
2. **Linear**:免费 workspace → 建 team(拿 team key)→ Settings→API 拿 personal API key → 建一个 project。
3. **GitHub**:`gh auth login`;**私有 repo 访问 = 待 Annie 拍**(exploration D-B,推荐 collaborator:flywheel + flywheel-skills 两个)。
4. **Claude Code**:CLI 登录,用**他自己的订阅**(自托管 B 的硬约束,Annie 已定)。
5. (可选)codex/kimi/agy 各自登录 —— v1 可全跳过,claude 一个够跑。

## 5. 复用/不重造清单

| 直接复用 | 为什么 |
|---|---|
| provision-fleet-host.sh 全部 phase | 输入契约就是 fleet artifact,起步器只造 artifact |
| validate_tokens token gate | "填完才能继续"的闸已存在 |
| setup-new-project.sh | 项目 repo 骨架半边已解 |
| materialize-lead-manifests.sh / supervisor.sh / host-config.sh | FLY-650 全套,零改动 |
| linux-preflight.sh + runbook §E | WSL2 真机就按它跑 |
| 测试 idiom(hermetic bash,mktemp HOME,stub 二进制) | 起步器测试照抄 |

**要新造的只有**:① 模板生成器脚本(fleet artifact 四件套 + 占位符)② 占位符校验(非 secret 字段的"填完"检查,补 token gate 盲区)③ 引导清单文档(runbook 新 §F:fresh instance,含 §4 全部外部资源步骤)④ WSL2 真机执行本身(founder-run)。

## 6. 风险与开放项

- **gh 的 apt 映射坑**(§3)—— 起步器模板的 deps 或 runbook 要处理 GitHub CLI apt source;真机第一跑大概率撞。
- **skills 私有 repo**:skills-sync.sh 拉 xrliAnnie/flywheel-skills,老公机器没访问权就 fail → D-B 决策落地前 runbook 写"可跳过 skills phase"降级路径(provisioner skills phase 本来就是 narrate/delegate、空 canonicalRepo 不 fail,已兼容)。
- **Bridge/Lead 对 Discord 结构的隐性假设**(如 core channel、alert channel 缺省行为):最小 env 集下哪些功能静默降级 —— plan 里列一个"最小实例功能面"表,POC 验证。
- **上层 onboarding UX**(引导式 agent 对话)明确等 HL 边界表 —— 本切片的引导清单是**文档形态**,将来那层把"能自动化"的步骤吃掉,清单剩 founder 闸步骤;两层不冲突。
