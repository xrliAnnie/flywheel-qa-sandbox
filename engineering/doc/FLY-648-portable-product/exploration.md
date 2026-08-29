# FLY-648 可移植+可部署产品 EPIC(第一块切片)— 探索

Issue: FLY-648 (https://linear.app/geoforge3d/issue/FLY-648/epic-flywheel-可移植-可部署产品windows-立即-云端-给别人用的产品)
日期: 2026-07-06
基于: 无

---

## 0. 本文档回答什么

Lead(Tadashi)三问:① epic 里**立即可做的第一块**是什么;② **核心/项目分离**的架构设计(founder-facing,gate 给 Annie 拍);③ **两天可交付的最小切片**建议。

结论先行:**核心/项目分离的"配置分家"已经在 FLY-650 做完并 merge 了(方向 Annie 6-28 已拍:D2=B 物理分开两份配置)** —— 不需要重新设计那一层。真正没做、且是 FLY-649(老公 Windows)直接卡点的,是两件:

1. **真机验收欠账**:FLY-650 的 WI-10(Annie 真 Linux + WSL2 跑通)是它自己 plan 里写明的"终验收闸",PR #380 body 明确说 "not yet done",merge 后相关脚本零 commit —— **Linux/WSL2 路径从没在真机上跑过**。
2. **从零开新实例(fresh instance)没有路**:现有 provisioning 是"复制 Annie 的机器"(fleet-capture → provision),FLY-284 的 setup-new-project.sh 是"在 Annie 的实例上加新项目"。**"一台陌生机器 + 一个陌生人,从零起一份自己的 Flywheel"** 这条路不存在 —— 而这正是老公机器需要的,也是产品化(sub #6)的雏形。

## 1. Epic 现状审计(逐 sub)

| Sub | Issue | 状态 | 审计发现 |
|---|---|---|---|
| #1 Windows/WSL2(老公 ASAP) | FLY-649 | Backlog | 未动。依赖 #2 —— 代码已 merge 但真机未验 |
| #2 可移植 provisioning + 核心/项目分离 | FLY-650 | **Done**(PR #380, 6-30) | 代码全量交付(见 §2);**WI-10 真机验收未做** |
| #3 容器化核心 | FLY-652 | Backlog | supervisor seam 已留 container 桩(fail-loud) |
| #4 配置驱动项目 | FLY-653 | Backlog | 依赖 #2;数据面(projects.json)其实已是声明式 |
| #5 云端 | FLY-559 | Backlog | 依赖 #3 |
| #6 产品化 | FLY-654 | Backlog(Low) | 依赖 #3+#4 |
| PM-agent flow | FLY-679 | Backlog | Anna(对外访谈员,FLY-879)已上线;对内 PM(FLY-880)PR #450 待 ship |

## 2. FLY-650 已交付什么(= 核心/项目分离的现状)

Annie 6-28 已拍的方向:**D1** Linux supervisor = systemd --user;**D2** 核心/项目边界 = **物理分开两份配置**;**D3** 做到真机跑通。PR #380 交付:

- **配置三层分家**(这就是"核心/项目分离"的落地形态):
  - `~/.flywheel/projects.json` = **项目配置**(哪些项目/repo/Linear/Discord 频道/哪些 lead)— FLY-247/371 起就是声明式,FLY-650 未动;
  - `~/.flywheel/host.json` = **核心/host 配置**(platform / supervisorBackend / flywheelDir / stateDir / skillsRepo / viewerBackend)— 新增,missing = 今天写死值(字节兼容);
  - `.env` = secrets(始终独立,scan_for_secrets 红线)。
- **supervisor seam**:`scripts/lib/supervisor.sh` service-spec 层(service/timer/path/darwinOnly)→ darwin=launchd 包装(零行为变化)/ linux=systemd --user 渲染 .service/.timer/.path / container=fail-loud 桩(留给 FLY-652)。
- **平台化 deps**(brew/apt/dnf/present-check/manual)、**materialize-lead-manifests**(projects.json → Lead manifest 确定化)、**viewer gate**(Linux=tmux-only,founder 已确认对 FLY-398"绝不 headless"的 Linux 修订)、**linux-preflight.sh**(WSL2/systemd 证据包)+ runbook §E。
- 111 hermetic bash 测试 + 7 vitest 全绿;macOS 字节兼容。

**⇒ 架构设计层面,"核心 vs 项目怎么切"这个问题已经有 Annie 拍过的答案且已实现。** 本切片不重开这个决策,只补它的两块欠账(§0)。

## 3. 真正的缺口:从零开一份新实例

"老公的 Windows 机器"和"复制 Annie 的 fleet"是两个完全不同的场景:

| 维度 | 现有路(capture→provision) | 老公需要的路(fresh instance) |
|---|---|---|
| projects.json | capture Annie 的 fleet(她的 7 个项目/Lead) | **他自己写**:他的项目(如电商)、他的频道、他要的 lead |
| Discord | Annie 的 server/bot pool | **他自己的 server + 自己建 bot**(隔离,FLY-649 边界写明) |
| Linear | Annie 的 workspace | 他需要自己的(免费 workspace 即可;Flywheel dispatch 是 Linear-driven,v1 绕不开)|
| secrets(.env) | 从 Annie 机器带过去 | 他自己的 token 逐个填(Discord bot token / Linear key / gh 登录 / Claude 订阅登录)|
| flywheel 核心代码 | git clone(Annie 是 owner) | **私有 repo 访问问题**:xrliAnnie/flywheel + xrliAnnie/flywheel-skills 都私有,他要 collaborator 或 deploy key |
| 平台 | macOS(已验)| **WSL2(从未真机验过)** |

缺的交付物 = 一条 **fresh-init 路**:starter 模板(最小 projects.json + env.example + linux deps manifest)+ 引导清单(建 Discord server/bot 的步骤、Linear workspace、各登录)→ 喂给**已有的** provision-fleet-host.sh。不是新 provisioner,是给现有 provisioner 一份"模板生成的 fleet artifact"而非"capture 来的 fleet artifact"。

## 4. 第一块切片:两天方案(推荐)

**切片 = "fresh-init 模板 + WSL2 真机跑通"**,两天两步:

- **Day 1 — fresh-instance starter**:新脚本 `scripts/flywheel-init.sh`(名字待定):交互式/参数化生成 `fleet/` starter artifact(最小 projects.json:1 项目 + 1 CoS + 1 eng lead;env.example 带每个 key 的"去哪拿"注释;linux 平台 deps manifest;host.json 模板),复用 FLY-650 全部机制,hermetic 测试,零生产副作用。同时产出"外部资源引导清单"(Discord server/bot 创建步骤 + Linear workspace + 登录序列)进 runbook 新 §F。
- **Day 2 — WSL2 真机验收(补 FLY-650 WI-10 + 直接服务 FLY-649)**:在真 WSL2 上跑 linux-preflight → provision → Bridge/Lead 起来 → Discord 能对话。反馈循环修坑(这是第一次真机,必有坑)。

**一份投资三个回报**(对齐 epic 关键洞见):starter 模板 = 产品化 onboarding(sub #6)的雏形;WSL2 修出的坑 = 容器化(sub #3)直接复用;fresh-init 生成的配置形态 = 配置驱动项目(sub #4)的地基。

## 5. Founder 决策点(gate 里问 Annie)

- **D-A 真机验证顺序**:先 Annie 自己的 Windows 机(反馈环短、修坑快,老公拿到的是已验证版)还是直接老公机器(他 ASAP、懂调 AI、用过 Cowork)?**推荐:先 Annie 的 Windows 机**,绿了再给老公 —— 除非 Annie 没有 Windows 机可用。
- **D-B 核心代码怎么给他**:加 GitHub collaborator(最简,能 git pull 更新)/ deploy key / release tarball(以后产品化的形态,现在过重)?**推荐:collaborator(flywheel + flywheel-skills 两个 repo)**。
- **D-C 老公 v1 的 Linear**:Flywheel dispatch 是 Linear-driven,v1 保持"他建自己的免费 Linear workspace"(推荐,零代码改动)还是探索无-Linear 模式(= 大改,不建议进本切片)?
- **D-D 老公 v1 的 lead 配置**:最小几个?**推荐:1 CoS + 1 eng lead**(他跑自己项目够用;多 lead 是加配置的事,以后随时加)。

## 6. 备选方案(为什么不选)

- **备选 1:跳过 fresh-init,手工给老公机器攒一份 fleet artifact**。更快(一天),但一次性、产品化零沉淀、下一个用户重来 —— 违背"一份投资三个回报"。
- **备选 2:先做容器化(FLY-652),Windows 走 Docker Desktop**。Docker Desktop 在 Windows 有虚机 RAM 税,epic 已明确 WSL2 是"最轻的桥";且容器化范围大,塞不进两天。
- **备选 3:重开"核心/项目分离"架构讨论**。没必要 —— D2=B 已由 Annie 拍板并实现;重开是浪费她的注意力。缺的是补欠账,不是改方向。

## 7. 风险

- **WSL2 第一次真机必有坑**(preflight 覆盖不了的:网络/中文路径/Windows 防火墙/WSL 内存上限),Day 2 预算就是修坑循环,可能溢出到第三天。
- **Discord bot 创建没法代劳**(OAuth 要真人),引导清单质量决定老公体验 —— FLY-649 自己的 brainstorm gate(onboarding 体验)在它实现前还要单独跟 Annie 对一次。
- **Claude 订阅**:老公机器上 Claude Code 用谁的订阅登录?(费用/账号问题,gate 里顺带问)。
