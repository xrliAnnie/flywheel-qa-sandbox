# FLY-1680 删除旧 Lead 启动链(v1 载体)— 探索

Issue: FLY-1680 (https://linear.app/geoforge3d/issue/FLY-1680/删除旧-lead-启动链v1-载体代码-1663-设计48h-后净删除条款的执行单)
日期: 2026-08-11
基于: 无(上游为 FLY-1663 设计文档 `engineering/doc/FLY-1663-launchd-native-lifecycle/plan.md` §11/§14 PR-D)

## 1. 这单是什么

FLY-1663 把全舰 14 个生产 Claude Lead 切上了 v2 载体(launchd → `flywheel-lead-wrapper-v2.sh` → 私有前台 tmux server → `lead-body.sh` 一次性 body)。其设计宪法是「修复 = 净删除」,§14 明确留了 **PR-D:清理 —— §11 矩阵驱动删除 + v1 carrier 退场**,触发条件是「全舰稳定 ≥48h」。本单就是 PR-D 的执行单,founder 直令(2026-08-10, [FLY-1672] thread):

> 那旧载体代码文件,你也要 create 成一个 issue,然后我们要把它们删掉。另外就是,你也去安排一下要在哪个批次去做那个删除的动作。

旧链里的 **create-kill 建窗验收链**(v1 supervisor 在共享 tmux session 里建窗→验收→不符即杀的机器)正是 2026-08-10 早 3 小时事故的病灶——它已不再被任何生产路径执行,但躺在仓库里就有「被手工/残留分支跑到」的尾部风险 + 持续的认知噪音。

## 2. 审计地面真相(2026-08-11 实测,非推断)

启动本设计前先做了「launchd plist → wrapper-v2 实际调用图」的正向审计与 v1 引用的反向 grep,关键事实:

1. **生产 plist 零 v1 引用**。`~/Library/LaunchAgents/com.flywheel.lead.*.plist` 共 16 个生产 label:14 个 Claude Lead 全部指向 `flywheel-lead-wrapper-v2.sh`;2 个 Codex Lead(growth/mufasa-lead、flywheel/codex-infra-bot-lead)指向各自的 bespoke codex wrapper(`flywheel-codex-lead-wrapper-*.sh` → `run-codex-lead-*.sh`),**不经过** `flywheel-lead-wrapper.sh`。
2. **projects.json**:14 个 Claude Lead 全部 `carrier: "v2"`;2 个 Codex Lead 无 carrier 字段(它们不在 v1/v2 carrier 体系内)。但 `flywheel-daemon.sh` 的 `resolve_manifest_carrier` 缺省默认仍是 `// "v1"` —— 这是一个**活着的危险默认值**,删除时必须翻转语义。
3. **QA 槽已经在 v2**:`test-deploy.sh` 的 `FLYWHEEL_QA_LEAD_WRAPPER` 默认指向 `flywheel-lead-wrapper-v2.sh`,`leadCarrier: "launchd-v2"`。529 房**不依赖**旧链——issue 里「测试槽如仍依赖旧链的部分单独判」的答案是:**槽本身不依赖;依赖旧链的是"测试旧链行为的测试文件"**(fixtures 里写 v1 plist 的 test-restart-services.sh 段落等),它们随被测机器一起删。
4. **claude-lead.sh(4860 行)是 v1/v2 合体**:`lead-body.sh` 以 `FLYWHEEL_LEAD_BODY_V2=1` source 它,v2 一次性路径在 ~4368-4438 行结束并 `exit`;其后 ~4440-4860 行的 supervisor 主循环、以及 FLY-1659/1285/1309 整个 pending/fence/lease-launch/adoption/create-kill 建窗函数族(~1300-2670 行)是 v1-only 死代码。
5. **前置全部满足**:FLY-1679(dev-channels auto-confirm 搬 v2)已 merge(#801);批D FLY-1573(#798)/FLY-1574(#797)已 merge;v2 全舰 48h 稳定窗到 2026-08-12 满足。
6. **交叠单已收敛**:FLY-1659(#793)、FLY-1634(#773)、FLY-1602(#764)都已 merge 进 main——它们加固/精简的正是本单要拆的 v1 机器,不存在在途 PR 冲突;拆除即是对这些补丁族的整体退役(FLY-1663 §13 定案:「机制整体退役,不再投入补丁」)。

## 3. 范围划定(与 FLY-1663 §11 的对齐与切分)

§11.1 的完整删除账比本 issue 文本宽。探索结论:本单执行其中「v1 启动链」主体,**两块显式切出去**:

- **lease TS 族 + lead-lease.db 退役(§11.2)**:消费位横跨 flywheel-comm 写校验、Bridge diagnostics、founder consent、feature-flag registry。launch 侧的 lease **写入者**(v1 supervisor)随本单死掉;读侧已经容忍无 lease(v2 舰队眼下就没人写 lease,comm 正常),所以剩余退役是纯清理但爆炸半径大 → **另立 follow-up issue**,不塞进本单。
- **cmux runner view/ledger 机器**:§13 已定案走后续单(Runner per-session 直连迁移),本单只删 `flywheel-cmux-sync.sh` 里 Lead carrier 分类的 v1 臂。

## 4. 关键决策点(带到 plan 定案)

| # | 决策点 | 倾向 |
|---|---|---|
| D1 | claude-lead.sh:原地剜除 v1 分支(A) vs 装配职责搬进 lead-body.sh 后删文件(B) | **A**。纯减法、零行为改写、与批E1 同窗的 FLY-1674 冲突面最小;B 是无行为收益的大搬家,可做后续机械重命名单 |
| D2 | carrier 概念:保留字段仅认 v2 vs 彻底移除选择逻辑 | 移除 v1 臂;`resolve_manifest_carrier` 缺省翻转为 v2;显式 `carrier:"v1"` **fail-loud 拒绝**(边界校验,不是新机制) |
| D3 | codex-lead.sh(仅被 v1 wrapper 派发 + QA 脚本引用) | **保留**(FLY-224 vendor-pluggable 通用入口,休眠能力);头注标明「launchd 无到达路径」 |
| D4 | 盘上已安装副本 `~/.flywheel/bin/flywheel-lead-wrapper.sh` 与 `.bak` plist | ship 窗运维清扫项,不进代码 PR;launchd 不加载 `.bak-*`,风险为零但按「可被跑到归零」目标顺手清 |
| D5 | lead-body-sweep.sh | 保留(restart-services 的 debug observation 还在用,FLY-1634 定案 body liveness = debug/人工);只删 claude-lead.sh 内 v1 调用位 |

## 5. 不做什么(诚实边界)

- 不动 Runner 生命周期 / TmuxAdapter(§11.4 原样继承)。
- 不动 codex Lead 形态(bespoke wrapper 链原样)。
- 不删 git 历史;回滚 = revert 单 PR。
- 不在本 PR 里 `rm` 生产状态文件(pids/、lease.db、archive 留盘无害;运维清扫另判)。
- 不新增任何 watchdog/flag/机制——唯一允许的「加」是 D2 的一行 fail-loud 边界校验。
