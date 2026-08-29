# FLY-648 机制底座:一条 command 安装向导(flywheel-setup)+ WSL2 真机跑通 — 实施计划(rev2)

Issue: FLY-648 (https://linear.app/geoforge3d/issue/FLY-648/epic-flywheel-可移植-可部署产品windows-立即-云端-给别人用的产品)
日期: 2026-07-06
基于: research.md + product/doc/FLY-910-non-eng-onboarding/provisioning-automation-boundary.md(HL 自动化边界表,flywheel-FLY-910 / PR #471)
Codex design review: rev1(artifact 生成器形状)R1 6项+R2 2项全采纳 → R3 APPROVED;**rev2 = 按 HL 边界表重塑为一条 command 编排形状**(Tadashi 批准 2026-07-06)重过 review:R1 CHANGES REQUESTED(7 项:bot 拓扑/权限合同、Linear 子步+引导 fallback、CoS 骨架身份对齐、preflight --check fail-closed、精确 env 合同、journal 安全信封、POC 隔离断言 —— 全采纳)→ **R2 APPROVED**(剩余为实现期 watch item)。rev1 的全部机制级修正在 rev2 原样保留。

---

## 0. 方向(已锁,不再开)

- **部署 = B 纯自托管**(Annie):客户自己机器 + 自己 Claude 订阅 + 自建 Linear workspace + 自己的 Discord。
- **beachhead = 甲**(Annie):时间紧、有技术直觉的经营者 —— 终端一条 command 可接受,不必极致傻瓜。
- **bot 默认 C1 自建**(Annie):底座仍做成 **C1/C2 可切 seam**(C2=bot 池 FLY-882 邀请路,留可选省事捷径)。
- **边界表 = 工程边界规格**(HL):底座自动跑完全部 [AUTO] + 引导 3 件亲手事 + 运行期 [GATE];token 不进聊天;可续传;非-eng 路砍 GitHub。
- **上层 hold**:逐屏文案 / 产品默认值 / 用词(经理·专员)= HL 之后给;GitHub 最终砍不砍、Linear 全隐藏、机器常开门槛 = Annie 战术项,**不 gate 底座**(seam 都留)。

## 1. 一句话方案

新增**一条 command 安装向导** `scripts/flywheel-setup.sh`:step-engine + 续传 journal,自动跑完边界表 B 的全部 [AUTO] 步(依赖/骨架/建频道/写配置/装服务/健康检查),中途只引导用户过 3 件亲手事(① Discord bot:C1 引导自建 / C2 池邀请,seam 可切 ② Linear 凭证 ③ 模型 key),**用户全程不看不填任何 JSON**,token 全程隐藏录入绝不进聊天;底层复用零改动的 FLY-650 供给链(host-config / supervisor / materialize / provision)与 rev1 的生成·校验机制(降为内部机制)。WSL2 真机 = founder-run 循环,绿 = Discord 里 @CoS 有回话。

```mermaid
flowchart TD
  CMD["flywheel-setup.sh(一条 command)<br/>step-engine + setup-state journal(可续传)"] --> S1["[AUTO] preflight + deps<br/>(platform-aware, 复用 linux-preflight/platform-deps)"]
  S1 --> S2["[AUTO] 项目骨架 setup-new-project.sh<br/>本地 git init, 不建/不 push GitHub"]
  S2 --> S3["[GUIDED] 模型 key / Claude 登录<br/>隐藏 TTY 录入 + 校验"]
  S3 --> S4{"[SEAM] Discord bot"}
  S4 -->|C1 默认: 引导 Portal 自建<br/>+ CLI 隐藏录 token + 即时校验| S5
  S4 -->|C2 可选: pool bot invite-url<br/>用户点一次(诚实标注半托管)| S5
  S5["[AUTO] 用已验 bot 经 Discord API 建频道<br/>guild/channel ID 自取 + founder ID 引导获取"] --> S6["[GUIDED+AUTO] Linear: key 隐藏录入+校验<br/>→ API 建 team/labels"]
  S6 --> S7["[AUTO] 写 projects.json/host.json/.env<br/>(写盘前跑内部校验=真 loadProjects)"]
  S7 --> S8["[AUTO] materialize manifests<br/>+ supervisor install(launchd/systemd seam)"]
  S8 --> S9["[AUTO] Bridge 起 + health check<br/>+ 「去 Discord 跟你的经理打招呼」🎁"]
  S9 -.-> G["运行期 [GATE]: 合并/上线/runner 生命周期<br/>= 客户本人 Discord 一键批(FLY-175 原样)"]
```

## 2. Scope

**In**:
- `scripts/flywheel-setup.sh`(新):step-engine + journal + 全部 step 实现(§3)。
- 配置写入器(rev1 flywheel-init 的生成/校验机制**降为内部机制**:占位符=内部合同、真 loader 校验=写盘前闸;不再要求用户手填)。
- bot-provisioning seam(C1/C2)+ Discord [AUTO] 建频道 + Linear [AUTO] 建 team/labels。
- runbook §F 重写为编排器说明 + 诚实告知文本(边界表 F)。
- hermetic bash 测试(FLY-519/650 idiom)+ POC(Linux hermetic apply 全链)。
- WSL2 真机 founder-run 验收(QA 段)。

**Out**(明确不做):
- 现有 provisioner / supervisor / host-config / capture 的**行为**改动(编排器只调用它们)。**对"零 diff"的两处诚实修订(R1#3/#4,均为 opt-in 加法、缺省行为逐字不变 + reverse-compat 测试)**:① linux-preflight.sh 加 `--check` 模式 ② setup-new-project.sh 加 lead-id 参数;
- 逐屏文案/产品默认值(上层,HL);Linear OAuth 化(v1 = API key 隐藏录入,OAuth 是上层 follow-up,§3.6 诚实标注);
- 容器化(FLY-652)/ 云端(FLY-559)/ 多租户(FLY-654);
- eng 路的 GitHub [OAUTH]+[AUTO] 建仓(边界表标可选;v1 只做非-eng 砍 GitHub 路,seam 留分支点);
- FLY-175 运行期 gate 的任何改动(原样继承,自托管下 founder=客户本人)。

## 3. 设计细节

### 3.1 step-engine + journal(可续传)

- `~/.flywheel/setup-state.json`(0600):`{steps: {<id>: {status: done|pending, evidence: <非 secret 摘要>}}, version}`。**state 只记「step 完成 + 非 secret 证据」,绝不记 token 值。**
- **re-run 从第一个未完成 step 继续**(中断/失败/用户卡在建 bot 都可续);每 step 自身幂等(重跑已 done 的 step = no-op 校验后跳过)。
- step 类型:**[AUTO]**(无感执行)/ **[GUIDED]**(打印引导文案桩 + 等输入/确认 + 即时校验,失败原地重试不整段重来)/ **[SEAM]**(策略可切,§3.3)。
- 失败 = fail-closed:step 报错即停在该 step(journal 保留),打印下一步该干什么;绝不半状态继续。

### 3.2 step 序列(逐步,映射边界表 B)

| # | step | 类 | 做什么 |
|---|---|---|---|
| 1 | preflight+deps | [AUTO] | linux-preflight.sh 现状**总是 exit 0**(诊断性,linux-preflight.sh:9-12/136-143),不能直接当闸(R1#4)→ 给它加 **opt-in `--check` 模式**(硬阻塞项 exit 非零:systemd user manager 不可用 / 装在 /mnt/c / 必装依赖装后仍缺 / host-config 解析失败;缺省无 flag 行为逐字不变 = 字节兼容);编排器只信 `--check` 的退出码。platform-deps 装依赖;darwin/linux 平台分支 |
| 2 | 项目骨架 | [AUTO] | setup-new-project.sh 生成骨架 + 本地 `git init`;**不建/不 push GitHub**(仓留本地,边界表 A/B#1-2)。**CoS 身份对齐(R1#3)**:setup-new-project.sh `--two-layer` 现产 `${PROJECT}-cos-lead` 骨架(setup-new-project.sh:79-80/346-386),与 runtime 字面 `cos-lead` 冲突 → 给 setup-new-project.sh 加 **opt-in lead-id 参数**(如 `--cos-id cos-lead`,缺省行为不变),使 identity 目录 = `.lead/cos-lead/` 与 projects.json agentId 一致;hermetic 断言 materialize 出的 manifest `leadId=="cos-lead"` 且 claude-lead.sh CoS 检测路径命中 |
| 3 | 模型 key | [GUIDED] | Claude Code 登录引导(自己订阅,**是 CLI 登录不是 env key**);仅当用户选"API key 路"才录 key(隐藏 TTY,§3.4)+ 校验 |
| 4 | Discord bot | [SEAM] | C1/C2,§3.3;**v1 = 两个 bot**(CoS + eng 各一,对齐 runtime 的 per-Lead botTokenEnv 模型;R1#1) |
| 5 | 频道 + ID | [AUTO]+fallback | 用已验 bot 经 Discord API 建 #cos-chat/#eng-chat/#general(**建频道需 MANAGE_CHANNELS**,invite-url 权限常量单点定义并包含它;403 = 同 step 内切引导路:用户手建频道→系统校验);对**每个** bot 探测其分配频道的 读历史+发帖(setup probe 消息发了删);guild/channel ID 自取;founder user ID 引导获取(先试"粘贴 ID"、备"发一条消息由 bot 读")(R1#1) |
| 6 | Linear | [GUIDED]+[AUTO]+fallback | 子步与续传点(R1#2):(a) key 隐藏录入+校验(viewer/workspace) (b) find-or-create team by key,冲突 = 显式让用户选 (c) find-or-create project + 路由 label(按稳定名) (d) **create 权限不足 = 切引导路**:用户在 Linear UI 建/选,系统校验结果 (e) 把 runtime 真正消费的值(projects.json 的 linear binding + config.yaml 的 linear.team_id)写全,写盘前重跑真 loader |
| 7 | 写配置 | [AUTO] | 生成 projects.json/host.json/.env(0600):**rev1 全部 schema 修正原样**(CoS agentId 字面 `cos-lead`、agentId 全小写 grammar、projectRoot 生成期绝对路径、eng lead 显式 `department`、Triage⇒`canSpawnRunners:false`);写盘前跑**内部校验闸** = 真 loadProjects(FLYWHEEL_PROJECTS 注入,loader throw 即停)—— rev1 --check 的权威层,收进流程内 |
| 8 | 服务 | [AUTO] | materialize-lead-manifests + **supervisor.sh seam**(darwin=launchd / linux=systemd --user;零 launchd 硬编码)+ token gate 原样(validate_tokens 过了才起服务) |
| 9 | 收尾 | [AUTO] | Bridge 起 + health check(/api/runs/active 2xx + bot 在线)+ 打印「去 Discord 跟你的经理打招呼」(文案桩,正文=上层) |
| 10 | digest hook | [AUTO/可选] | 默认接,可 flag 跳 |

诚实告知(边界表 F,流程内在相应 step 前打印,文案桩):C1 建 bot 无法 API 自动化 / 账号注册只能给链接等用户 / 机器要 7×24 常开 / 模型成本自担。

### 3.3 bot-provisioning seam(C1/C2 可切;v1 两 bot 拓扑,R1#1)

- **拓扑合同**:v1 = **两个 bot**(CoS 一个、eng 一个),因为 runtime 是 per-Lead 模型 —— ProjectConfig 校验 `lead.botTokenEnv` 为每 Lead 字段(ProjectConfig.ts:461-470),flywheel-lead-wrapper.sh 把它解析成该 Lead 进程的 DISCORD_BOT_TOKEN(flywheel-lead-wrapper.sh:96-98/140-146)。不做"单 bot 共享身份"(要证明 Discord state 目录/mention/身份假设全兼容 = 超预算)。
- **汇合契约 = `BotProvisionResult`**(两条路产出同一形状,每 Lead 一条):`{leadId, botUserId, tokenEnvName, guildMembershipProof, channelId, channelProbeProof(读历史+发帖探针)}` —— step 5 只消费这个形状。
- 实现为 step 4 的**策略函数对**(`bot_provision_c1` / `bot_provision_c2`),选择经 flag/env(如 `FLYWHEEL_SETUP_BOT_PATH=c1|c2`,缺省 c1 = Annie 锚);**产品默认值以后 HL 给,底座不写死**。
- **C1 own-portal(默认)**:对**每个** bot 分步引导 Developer Portal(建 app → 加 bot → Reset Token 复制 → 开 Message Content + Server Members intents → 用打印的 invite-url 拉进自己 server;invite-url 的 **permissions 常量单点定义、含 MANAGE_CHANNELS**(setup 期建频道要用;先例:setup-mirror-channel.sh:4-10 无此权限只能人建频道))→ CLI 隐藏录 token → 即时校验(API 探 bot 身份 + 在目标 guild)。每小步可单独重试;第二个 bot 复用同引导。
- **C2 pool-invite(可选)**:打印**两个** pool bot(FLY-882 池;池 lib 本就只管既建 bot 的 token、不能代建 app,discord-bot-pool-lib.sh:18-21)invite-url,用户各点一次;token 为 Flywheel 托管侧持有、经运营侧注入 env、不经用户 —— 流程内**诚实标注**半托管让步。v1 做到接口 + 文档,端到端真跑可后置(风险 6)。

### 3.4 secret 红线(升级版)+ 精确 env 合同(R1#5)

token/key 全程:**隐藏 TTY 读入**(FLY-510 notion.sh setup 先例:绝不进 argv/history)→ 内存校验 → **原子写 0600** `~/.flywheel/.env`(拒 symlink / 拒 group·world-writable 父目录)。**绝不出现在**:聊天/Discord、argv、shell history、日志、setup-state.json。中间产物同样零 secret(FLY-519/650 红线不破);scan_for_secrets 继续守 capture 面。

**v1 env 合同(精确,防 validate_tokens 误闸)**:validate_tokens 对 env.example 里**每个** secret-named key(含 `_KEY` 结尾)强制非空才放行服务(provision-fleet-host.sh:133-155/368-375),所以生成的 env.example **只放必填项**:`<COS>_BOT_TOKEN` / `<ENG>_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_OWNER_USER_ID` / `LINEAR_API_KEY` / `LINEAR_WORKSPACE_SLUG`。**可选模型 API key 一律不进 env.example**(Claude 订阅走 CLI 登录不是 env;用户显式选 API-key 路时才由编排器追加写入)。若启用受保护 Bridge 路由,`TEAMLEAD_API_TOKEN` 由编排器**本地随机生成**并按 secret 写入,不让用户自己编一个。

**journal 同规格(R1#6)**:`setup-state.json` 享受与 .env 同一套安全信封 —— state 目录本人所有、非 group/world-writable、拒 symlink;写入 = 同目录临时文件 + chmod 600 + 原子 rename(可行处 fsync);**lock 文件防并发 setup**(第二个实例 fail-loud);step 标 done **只在**对应 live 产物 + 校验证据都存在之后(中断/崩溃重跑重验该 step 而不是信半状态)。

### 3.5 OS-portable(零 launchd 硬编码)

编排器**只**经 FLY-650 的抽象层碰平台:服务 = supervisor.sh(service-spec)、路径 = host-config.sh、依赖 = platform-deps.sh。守卫测试:grep 断言 flywheel-setup.sh 不直接出现 launchctl/plist 字面(darwin 分支也走 seam)。WSL2 = linux 后端 + linux-preflight 的 WSL 专项(systemd=true、非 /mnt/c、linger)。

### 3.6 诚实边界(写给 review 与上层)

- Linear v1 = API key(runtime 今天就吃 LINEAR_API_KEY;OAuth [OAUTH] 化 = 上层 follow-up,seam = step 6 的凭证获取函数可换)。
- Aha/引导文案 = **桩**(结构+占位),正文等 HL 逐屏细化 —— 底座交付的是流程与钩子,不是最终文案。
- founder user ID 获取的「发一条消息由 bot 读」方案若 API 面超预算,fallback = 引导开发者模式粘贴 ID(两条都实现,先试后者=更简)。

## 4. 工作分解(TDD;实现阶段执行)

| WI | 内容 | 复用 rev1 | 测试/验收 |
|---|---|---|---|
| A | step-engine + setup-state journal + 续传 + **并发锁/原子写/安全信封(R1#6)** | 新 | hermetic:中断后 re-run 从断点继续;done step 幂等跳过;state 零 secret;失败 fail-closed 停在原 step;并发第二实例 fail-loud;done 只在产物+证据存在后 |
| B | 配置写入器 + 写盘前内部校验闸 + **CoS 骨架身份对齐(R1#3:setup-new-project.sh opt-in lead-id 参数 + 缺省行为 reverse-compat 测试)** | **旧 WI-1/2 整体降级复用**(占位符=内部合同;真 loader 权威层;rev1 修正全保) | hermetic:cos-lead 字面锁/小写 grammar/绝对 projectRoot/department 显式/Triage⇒canSpawnRunners:false;loader throw 即停;.env 0600 且 state 无 token;materialize 出的 manifest leadId==cos-lead + identity 目录一致 |
| C | bot seam:**两 bot 拓扑** C1 引导+隐藏录入+校验 / C2 invite-url;`BotProvisionResult` 汇合契约;permissions 常量(含 MANAGE_CHANNELS)单点定义 | 新(C2 对接 FLY-882 形态) | hermetic(stub API):C1 校验失败原地重试;两 bot 各自完整走完;C2 打印两条正确 invite-url + 诚实标注;flag 切换两路;汇合契约形状一致 |
| D | Discord [AUTO]:建频道(**403 → 引导人建+校验 fallback**)+ 每 bot 读/发探针 + ID 自取 + founder ID 获取(两 fallback) | 新 | hermetic(stub API):频道创建/复用幂等;403 路走引导并最终校验;探针失败 fail-closed;ID 落进配置 |
| E | Linear:子步 a-e(R1#2:viewer 校验 / find-or-create team 冲突 UI / find-or-create project+label / **create 权限不足→引导选建+校验** / 写全 runtime 消费值再过真 loader) | 新 | hermetic(stub API):key 无效 fail;team key 冲突走用户选择;权限不足走引导路;幂等;linear binding + config.yaml team_id 双写一致 |
| F | 服务带起 + health + Aha 桩;**linux-preflight `--check` 模式(R1#4,opt-in + 缺省 reverse-compat)** | 旧 WI-5/provision/supervisor 复用 | hermetic:只经 supervisor seam(grep 守卫零 launchd 字面);token gate 原样把关;--check 硬阻塞 exit 非零、无 flag 输出逐字不变 |
| G | runbook §F 重写(编排器说明 + 诚实告知文本 + WSL2 注意项:gh apt source/nvm·corepack/.wslconfig 内存/非 mnt-c) | 改写 | 评审即验收;命令块可整段复制 |
| H | POC:Linux hermetic **apply** 全链(temp-HOME + stub systemctl/loginctl + FLYWHEEL_SYSTEMD_USER_DIR,断言 manifest/unit/cos-lead 契约/projectDir)+ darwin dry-run 次级 + **target-state 隔离断言(R1#7)**:HOME/--home/FLYWHEEL_STATE_DIR/fixture host.json.stateDir 一致设定,断言 temp home 之外零读写;负例:真 ~/.flywheel 存在时 setup 拒碰(review 实测就撞过 provision-fleet-host.test.sh 在 sandbox 漏到真 ~/.flywheel 的 11/14) | 旧 WI-5 | 主证据全绿 + 隔离断言 + 负例 |
| I | WSL2 真机 founder-run 循环(QA 段) | 旧 WI-6 | 绿 = preflight 全绿 + 服务 active + Bridge 2xx + **Discord 里 @CoS 有回话**;真机坑回灌 runbook/模板 |

顺序:A→B 先(engine + 写入器 = 骨架),C/D/E 并行其后,F 收,G 平行,H 全链 POC,I 等真机窗口。

## 5. 字节兼容 / 风险

- **生产零变化**:不改任何 runtime TS / provisioner / supervisor;新增 1 编排脚本 + 测试 + runbook 章节。Annie 生产 fleet 无感。
- 风险 1 — Discord API 建频道/invite-url 的权限位错 → WI-C/D 把 permissions 常量单点定义 + stub 测;真机 I 段最终验。
- 风险 2 — 用户卡在 C1 建 bot(最常见断点)→ journal 续传 + 每小步重试就是为此;worst-case 真人陪建(产品侧,Anna)。
- 风险 3 — Linear API 建 team 权限/配额(免费 workspace)→ WI-E 冲突与失败路径显式;真机验。
- 风险 4 — Claude CLI 登录在 WSL2 的浏览器回环体验 → I 段真机验证项(runbook 预写引导)。
- 风险 5 — schema 漂移 → 写盘前内部校验 = 真 loader(rev1 结论不变)。
- 风险 6 — C2 依赖 FLY-882 池的运营侧 token 注入 → v1 只做接口 + 文档,C2 端到端真跑可后置(默认 C1 不受影响)。

## 6. 交付物

- `scripts/flywheel-setup.sh` + `scripts/__tests__/flywheel-setup*.test.sh`(A-F 各面);
- runbook §F(编排器版);
- POC 证据进 PR body:Linux hermetic apply 全链断言全绿(主)+ darwin dry-run(次)+ 真 loader/materializer 校验输出;
- WSL2 真机验收证据包(founder-run,QA 段);
- 版本号 tentative(ship 时 re-version)。

> 备注:implement session 在 rev2 批准前已按 rev1 形状起了 `scripts/flywheel-init.sh` 草稿(未提交,后被 worktree 重置清掉)—— rev2 下它的生成/校验逻辑并入 WI-B(内部机制),入口统一为 flywheel-setup.sh;是否保留 flywheel-init 为低层子命令由 implement 段按代码整洁度定,不是设计约束。
