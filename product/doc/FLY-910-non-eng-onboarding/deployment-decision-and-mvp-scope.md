# FLY-910 部署轴决定 + MVP 范围(Annie 复盘收敛)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-08
基于: research-options.md(Block 5 部署轴岔口)· self-hosted-onboarding.md · FLY-911 定位文档

> 这是 Annie 对**部署轴**复盘后的收敛决定(经 Honey Lemon relay)。它给已收敛的 onboarding 设计定了 MVP 范围 + 与 FLY-911 定位的一致性口径。onboarding 逐屏设计本身见 `onboarding-flow-detailed.md`(权威 eng-buildable 规格)。

## 1. 部署轴决定(定了)

- **MVP = 纯自托管(B)**:客户在自己机器上跑。理由:beachhead 甲(半技术、有技术直觉、缺时间)能在引导下自建;隐私/所有权是卖点;**上线快**。
- **Managed = V2**,明确 out-of-MVP-scope。V2 才兑现「替你托管的可靠 / done-for-you」。
- 本 issue 的 onboarding 设计 = 服务 MVP 自托管路径;managed 的 onboarding 留 V2 单独设计。

## 2. 已知取舍(诚实写明,Annie 接受换 ship 速度)

- **要一台常开机器 = 已经算「自托管」的成本,会丢掉纯非技术用户**:关机 = 公司停摆;非技术小白难维持一台 7×24 常开机。这是自托管模型本身的坎(`self-hosted-onboarding.md` §诚实 #3 已标),onboarding 流程消不掉。
- **Annie 诚实接受这个取舍**:MVP 用它换 ship 速度、先服务半技术的甲;**V2 managed 来补**这群非技术用户(平台代跑常驻服务,无需客户自管常开机)。
- onboarding 开场是否显式告知「机器常开」门槛 = 战术参数 ⟨MACHINE⟩,列在 §4 next 待 Annie 拍。

## 3. FLY-911 定位一致性(消除之前上报的张力)

- 之前上报的张力:FLY-911(非技术 + done-for-you + managed)vs FLY-910 锁的(甲 半技术 + 纯自托管 B)在部署轴相冲。
- **Annie 的收敛口径**:
  - FLY-911 的「非技术 operator + done-for-you」= **愿景 / 更大市场**(later);
  - **MVP 先服务半技术的甲**(beachhead 现在专攻,能自建、终端一条 command 可接受);
  - **managed(V2)兑现 done-for-you** —— 把非技术那群接回来。
- 所以两者不冲突,是**同一条路的两个阶段**:MVP 自托管(甲)→ V2 managed(非技术)。定位没变,只是把 onboarding 的 MVP 目标用户明确成甲。

## 4. 剩余战术块(next,逐块等 Annie 拍,不替她定)

Honey Lemon 逐块带 Annie;每块拍完 relay 给我织进设计文案(定了改文案、流程结构不变):

1. **block-2 两确认点**(见 `command-form-research.md`):① 一条终端 curl → 引导式对话、默认 QuickStart(`--advanced` 可选)形态认不认;② 要不要「工具没全接就先跟 Captain 打招呼」的早时刻。
2. **concierge**(见 `research-options.md` Block 6):第一版全自助 vs Anna 人肉带 onboard(minimalist manual-first)。
3. **C1/C2**(见 `provisioning-automation-boundary.md` §C):Discord bot 默认 C1 自建;C2 bot 池捷径露不露出。
4. **收费·隐私**(见 `monetization-privacy-strategy.md` §五):license-key 订阅骨架 / 1 个 Team 免费试 / 隐私显式卖点 / license 条款。
5. **command 文案参数** ⟨FREE / PRIV / GH / MACHINE⟩:开场露不露免费试 / 隐私句 / 砍 GitHub / 机器常开门槛告知。(**用词已锁 Captain/Crew/Team,不再是变量。**)

## 5. 落地状态

- 已收敛设计(含逐屏 S0–S8)干净 rebase 到当前 main、开 docs PR。
- 顺修内部命名不一致:customer-facing 文档的 经理/专员/部门 → **Captain / Crew / Team**(`research-options.md` Block 2 候选表是决策记录,保留)。
- **ship 仍 founder-gated**:不 ship、不 create-issue;PR 出完 PARK,等 Honey Lemon 逐块 relay Annie 的战术决定,再逐块织进设计。
