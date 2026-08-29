# FLY-1023 Buddy onboarding 全量 build — 探索

Issue: FLY-1023 (https://linear.app/geoforge3d/issue/FLY-1023/fly-910-onboarding-buddy-build-single-eng-issue-tadashi-splits-per-prd)
日期: 2026-07-09
基于: 无(本文件夹首篇;上游 = engineering/doc/FLY-910-onboarding/prd.md v3 + product/doc/FLY-910-non-eng-onboarding/ 全套)

> Brainstorm gate 已过(Tadashi 确认,2026-07-09):单一 plan、内部按 BI 里程碑分块、每块独立验收 + 标注可拆点;依赖序认可;MVP 以 PRD §6.7 为准;BI-0(FLY-648 closeout)排最前;复用 648 底座、桥接同一 state 根;红线全守;过 Codex design review 再 complete。

---

## 1. 问题

FLY-910 PRD(v3,Codex design review APPROVED ×2)定义了「Buddy」——一个跑在 agent CLI 上的自助 onboarding 对话 agent,把非技术客户从「刚拿到 access」带到「手里有一个真能跑的 system + 第一个真产出(≤60s)」。Annie 已把原 9 路拆分(BI-0..BI-8)合并成**一个 eng issue(本 issue)**;Tadashi 之后按 PRD §12 自行拆 build sub-issue。

本 design 阶段要回答的是:**PRD 的目标 UX 落在当前 codebase 上,到底哪些直接复用、哪些真要新建、怎么建、按什么顺序建、每块怎么验收。**

## 2. 输入(source of truth 链)

| 输入 | 地位 |
|---|---|
| `engineering/doc/FLY-910-onboarding/prd.md`(v3) | **权威**。§4.5 决策覆盖表 + §6.7 MVP-minimum vs 目标 + §12 build 拆分,eng 只认这份 |
| `product/doc/FLY-910-non-eng-onboarding/onboarding-buddy-spec.md`(v3) | 交互/话术层权威(每步真话术、operating loop、升级阶梯) |
| `product/doc/FLY-910-non-eng-onboarding/provisioning-automation-boundary.md` | [AUTO]/[OAUTH]/[MANUAL]/[GATE] 工程边界表(FLY-648 已按它建) |
| `product/doc/FLY-910-non-eng-onboarding/command-form-research.md` | 一条 command 形态研究(OpenClaw/Hermes 对标) |
| FLY-648(已 merge,PR #477) | 底座:`scripts/flywheel-setup.sh` + FLY-650 provisioning libs |

## 3. 底座现状(2026-07-09 代码审计结论)

**已经真实存在、直接复用(不重写)**:

1. **一条 command 交互向导** `scripts/flywheel-setup.sh`(~1255 行):step-engine + 续传 journal,步序 `preflight → skeleton → model_key → bots → channels → linear → config → services → finish → digest`(`flywheel-setup.sh:1237`),done 步 re-verify、失败 fail-closed、重跑续传。
2. **续传 journal** `~/.flywheel/setup-state.json`:`{version:1, steps:{<id>:{status, evidence}}}`,安全信封齐全(owner-only dir / 拒 symlink / 原子写 / 并发锁 / evidence 零 secret)。
3. **Discord provisioning**:bot token 隐藏录入 + identity/guild 校验(C1 自建 / C2 池邀请 seam)、频道 find-or-create + 403 引导 fallback、读+发探针(`_fs_channel_probe`)、founder ID 双路获取、权限整数单点真源(含 MANAGE_CHANNELS)。
4. **Linear provisioning**:key 校验 + team/label/project 全 find-or-create + 权限不足引导 fallback,写全 runtime 消费值。
5. **secret 红线机制**:隐藏 TTY 录入(`fs_ask_secret`,FLY-510 先例)→ 原子 0600 `~/.flywheel/.env`;传输走 curl -K stdin;journal 零 secret。
6. **核心/项目/机器三层 config 分离 + OS-portable supervisor seam**(FLY-650):`.flywheel/config.yaml`(项目)/ `~/.flywheel/projects.json`(机器本地 routing,`ProjectConfig.ts loadProjects` 真 loader 校验)/ `host.json`;`lib/supervisor.sh`(launchd/systemd 统一抽象)。

**审计确认真要新建的四块**(与 PRD §6.7 的诚实分层完全对上):

| # | 缺口 | 现状 | PRD 定位 |
|---|---|---|---|
| G1 | **AgentCliProvider seam** | 只有 guided 确认(`step_run_model_key` 让用户自己跑 claude 登录 + 存在性探测);detect/install/login/smoke/startBuddy/resume/repair 全无 | BI-0(a)①/BI-1 硬前置 |
| G2 | **GitHub 程序化建/绑仓** | 只有打印的手动 gh 清单(`setup-new-project.sh:434`);packages 内零 GitHub 产品代码 | BI-3;MVP 可走 gh auth(§6.7) |
| G3 | **可被 Buddy 复用的 state contract** | journal 是 bash-only、per-step status/evidence、无 cursor 概念 | BI-2/BI-7 共用;不另起第二 state 根 |
| G4 | **macOS 全自动安置 + Discord roles/webhooks** | darwin = operator-run narrated;roles/webhooks 零实现 | §6.7 明确 = 目标/follow-up,**不阻塞 MVP** |

另外两个「半缺口」:业务系统连接器(BI-4,现状为零——这是最大的新代码块)和最小可对话 Captain 的 onboarding 形态(BI-6,runtime Lead 机制存在但「早聊一句」的最小化拉起是新的)。

## 4. 核心架构选择(选项 + 推荐)

### Q1 · Buddy 的形态:怎么「跑在 agent CLI 上」?

- **A. 扩展 bash 向导**(不引入 agent,继续 flywheel-setup.sh 问答)——违背 PRD 根设定(Buddy 是对话 agent、persona 是产品核心、决策引擎要解析自由描述),否。
- **B. 独立 TS 聊天程序**(自己接模型 API)——PRD 明确不收 key、用用户自己的订阅;自建聊天层重复造 agent CLI 已有的一切,否。
- **C. Buddy = 一个跑在已装 agent CLI(MVP=Claude Code)上的对话 session:persona + 规则 = 注入的 system prompt 层(形态类比 `agents/generic-executor.md` / lead 的 identity+rules 注入),能力 = 一组可单步调用、机读输出的 step 命令。★推荐,也是 PRD 的字面设定。**

选 C。含义:BI-2 的主体是「persona/规则文档 + step 工具面 + 状态桥」,不是新 runtime。

### Q2 · Buddy 与 flywheel-setup.sh 的关系(最重要的一刀)

- **A. Buddy 自己重新实现各步** —— 双实现漂移,否。
- **B. Buddy 整段 shell 出 flywheel-setup.sh 交互向导** —— 两个交互层互相抢 TTY,Buddy 无法逐步校验/插话术,否。
- **C. 把 flywheel-setup.sh 的 step 实现抽成可单步调用的机读接口(step CLI:每步一个子命令,stdin/flag 进、JSON 出、exit code 语义化),交互层(TTY 问答 or Buddy 对话)只负责「说话」,执行/校验/落 journal 全走同一实现。★推荐。**
- 补充决策:**flywheel-setup.sh 保留原交互模式不动**(字节兼容,现有用户/测试不受影响);step CLI 是同一批函数的第二个入口(`--step <id> --json` 形态或独立薄壳),TDD 时用 FLY-648 的 hermetic bash 测试 idiom 保两个入口行为一致。

选 C。这是「复用不重写」的具体形状,也让 BI-3/BI-5 变成「接线 + 补缺」而不是新写。

### Q3 · state contract(G3)

- 推荐:**扩展 `~/.flywheel/setup-state.json` 到 version 2**:保留 steps 结构与安全信封,新增 buddy 区(onboarding cursor、step0-8 与底层 step id 的映射、非敏感用例上下文如「第一件事」摘要、escalated 标记)。**同一 state 根、同一安全信封、同一原子写**;bash 与 Buddy(经 step CLI 的 state 子命令读写)共用。不新建 `~/.flywheel-onboarding/`(buddy-spec 旧路径,已被 PRD §6.7 覆盖)。
- version 1→2 迁移 = 读到 v1 就地补空 buddy 区(幂等)。

### Q4 · AgentCliProvider seam(G1)

- 形态:**bash provider 模块**(与底座同语言、同测试 idiom),合同函数 `provider_detect / provider_install / provider_login_guide / provider_smoke / provider_start_buddy / provider_resume / provider_repair`,每函数机读输出 + 语义化 exit code。目录 `scripts/lib/agent-cli-providers/claude.sh`(MVP)+ `codex.sh`(占位:显式 not-implemented,守 CLAUDE.md「生产 Codex = windowed TUI」硬规则的注释锚)。
- `provider_smoke` = 起一个最小非交互会话验证已登录(能力探测,不收 key);`provider_start_buddy` = 以 persona 注入方式在该 CLI 上拉起 Buddy session。
- 选择 provider 经 config/env(默认 claude),**不写死厂商**(PRD 红线 5)。

### Q5 · 一条 command 的形态(PRD open-q 1,Annie 未拍)

- 事实:command-form-research 推荐 `curl -fsSL … | sh`(与 OpenClaw/Hermes 一致、甲熟悉);npx 需要先有 Node——而我们的 preflight 恰恰要负责装 Node,鸡生蛋。
- **推荐 curl|sh 作为工程默认形态**;plan 里入口脚本命名与内容不依赖最终 URL/包名,Annie 拍另一形态时只换分发皮、不动实现。**标注为非阻塞决策点,不 gate build。**

### Q6 · GitHub(G2;§6.7 BI-3 决策点)

- MVP 推荐:**gh CLI 路径** —— `gh auth login --device`(device flow,不贴 token)→ `gh repo create <owner>/<project> --private` → 绑 remote + 首推。gh 由 preflight 装(FLY-650 platform-deps 已有依赖安装面)。理由:零自建 OAuth app、token 由 gh 自管(keychain/自身凭证库)、与 §6.7「MVP 可先 gh auth」一致。
- 目标(follow-up):自有 GitHub App/OAuth device flow,不依赖 gh。

### Q7 · dropship vertical(BI-4+BI-6,最大新块)

- 连接器面:**只读 REST 探测器**(每系统一个薄 connector:auth 方式 + 最小只读探测 + 订单拉取),不是通用 MCP 框架 —— MVP 只要「dropship 订单」一条真路径。候选:Shopify(custom app Admin API token,商家侧可自助生成,隐藏录入)/ Veeqo/Ordoro(API key 隐藏录入);邮箱(确认邮件)= 只读 IMAP(app password)起步,OAuth 化列目标。**具体每家 auth/endpoint 在 research.md 核**;没连接器 = 诚实路径(PRD 红线)。
- 首产出编排:最小可对话 Captain(welcome-first)+「查今天卡住的单」的跨源还原(订单状态 × 确认邮件)→ 一条可信结果 + 下一步选项,≤60s。fixture/demo fallback **只算 QA/demo 兜底,不算生产成功**(PRD §12 BI-4,Codex R2#4)。

### Q8 · 转人工(BI-7)

- 升级阶梯(失败 2 次 / 用户连说不懂)→ 生成**脱敏**上下文摘要(走到哪/卡在哪/报错啥,secret-scan 过滤)→ 投递人工支持面 → journal 标 `escalated`(可被人工接手续跑)。
- 投递面 MVP:**本地摘要文件 + 明确的「联系支持」出口(邮件/链接桩,文案=产品层)**;自动进我们侧支持队列(Discord/工单)列目标 —— 客户机器此刻可能连我们任何基建都没接上,不能假设可达性。research 再核可选的低成本自动通道。

## 5. Scope 分层(以 PRD §6.7 为准,gate 已确认)

- **MVP-minimum(首批验收)**:Claude Code provider + curl|sh bootstrap + Buddy 核心(loop/persona/续传/决策引擎)+ Discord 频道级自动建(648 已有)+ Linear 安全 token(648 已有)+ GitHub gh auth + 建/绑仓 + guided macOS 安置(648 已有,linux 更自动)+ dropship 只读 vertical + ≤60s 首产出 + 转人工 + 素材。
- **目标/follow-up(不阻塞)**:macOS clean-host 全自动、Discord roles/webhooks、Linear/GitHub OAuth、Codex adapter、更多 vertical、支持队列自动投递。

## 6. 明确不做(本 issue)

managed V2 · 收费 · phase-2 常驻三样(开新 team / 自助修 / 日常自助——只留架构可扩位)· Anna(Sales,进门前)· FLY-915/942 infra 告警 bot(平台侧,§6.6 边界)· FLY-175 运行期 gate 的任何改动(原样继承)。

## 7. 风险(设计期识别)

1. **Buddy 会话对 step CLI 的调用纪律**:agent 驱动执行,需要 persona 规则 + step CLI 幂等 + journal 校验三层兜底,防 agent 幻觉跳步(step CLI 端做前置条件断言 = 结构性防线)。
2. **≤60s 首产出**依赖业务系统 API 延迟,编排要预取/并行(research 核)。
3. **秘密红线在 agent 对话层的新暴露面**:token 绝不能进 Buddy 的对话/transcript —— 隐藏 TTY 录入必须发生在 step CLI 进程内(不是 agent 读了再传),这是 step CLI 接口设计的硬约束;验收加 secret-scan(transcript/state/logs/支持摘要)。
4. **连接器真实性**:北极星要求真系统;各家 API 的自助可得性(如 Shopify custom app 是否要审核)research 必核,不可得就换 beachhead 排序或诚实降级。
5. 一条 command 形态(curl vs npx)与产品命名 = Annie 决策点,工程按 Q5 缺省推进、皮层可换。

## 8. 下一步

→ research.md:对 Q2(step CLI 抽取的具体切面:哪些函数、哪些入口)、Q4(claude CLI 非交互探测/登录态/persona 注入的现有先例)、Q6(gh device flow 细节)、Q7(Shopify/Veeqo/IMAP 只读可得性)、Q8(投递面选项)做代码级 + 外部事实核;产出 plan.md 的里程碑分块依据。
