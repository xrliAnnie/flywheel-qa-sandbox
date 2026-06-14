# FLY-247 WI-6: Fleet Config 迁移与部署 runbook(一次性)

**Issue**: FLY-247
**Date**: 2026-06-11
**基于**: `doc/engineer/plan/new/v1.40.0-FLY-247-fleet-config-dashboard.md` §WI-6

> 本文是 merge 后生产迁移的操作步骤。**全程不需要重启任何生产 Lead 之外的东西**;
> Bridge 需一次重启以装载 FleetPoller(Dashboard 区块)。

## 1. 种子(把现状写进真源)

编辑 `~/.flywheel/projects.json`,把当前手编 plist 的事实落进 `leads[]`:

- Peter / Hiro(现 Fable):`"model": "claude-fable-5"`
- Mufasa / Belle(codex companion):`"backend": "codex-app-server"`(两者已有 `companion: true`,需确认 `canSpawnRunners: false` —— schema 会 fail-close)

种子前先看三方现状(只读安全):

```bash
scripts/flywheel-fleet.sh plan
```

预期:Peter/Hiro 显示 "plist 有 model 但 config/manifest 没有" 的 drift(APPLICABLE);
Mufasa/Belle 显示 EXTERNAL(bespoke 路径,无标准载体,不算 drift)。

## 2. 首次 apply(把 model 从手编 plist 固化进载体链)

```bash
scripts/flywheel-fleet.sh apply --dry-run        # 生产只读安全,先看将做什么
scripts/flywheel-fleet.sh apply --lead geoforge3d-product-lead   # 逐个,有确认
```

- apply 自动完成:Phase W 部署 FLY-224 wrapper(补 F1 缺口)→ staged manifest(含 model)
  → plist 从 manifest 再生(从此 `daemon install` 不再抹 model,FLY-241 根治)→ 重启 verify。
- **红线**:每个 Lead 重启前有 [y/N] 确认;失败自动回滚(备份 plist 直接 bootstrap,绝不 regenerate)。
- codex Lead(Mufasa/Belle)apply 一律 UNAPPLIED —— 走 FLY-250 bespoke 路径,本版不自动碰。

## 3. Bridge 重启(装载 Dashboard Fleet 区块)

按 [[feedback_coordinate_bridge_restarts]] 纪律攒批重启。重启后 `:9876/` 出现 Fleet
区块(默认关:只有 ≥1 lead 配了 model/backend 才显示 —— 种子后即满足)。

## 4. 退役

- `~/.flywheel/fleet-model-setup.md` 删除(内容固化进 projects.json + Dashboard)。
- 手编 plist 不需要手动改 —— 首次 apply 已把它换成 manifest-派生的可复现版本。

## 5. 验收(plan §9)

- `fleet plan`:所有标准 Claude Lead 零 drift;codex Lead 显示 EXTERNAL/UNVERIFIED 且无 CONFLICT。
- Dashboard Fleet 区块浏览器实看 7 Lead 三层状态。
- 改 projects.json 里某 lead 的 model → 30s 内 Dashboard drift 变红(不重启 Bridge,要求⑤)。
- 真机 apply 验收只在 test-slot Lead 上做(QA 纪律:绝不对生产 Lead apply)。

## 注意

- **`apply --dry-run` 在存在 UNAPPLIED 项(如 codex Lead)时按合同 exit 1**(QA F-4)——
  这不是失败,是"有项目不可自动 apply"的信号;脚本/运维判断成功与否看输出行,不要只看 RC。
- `FLYWHEEL_PROJECTS` 环境(QA slot)下 fleet 一律 fail-close —— 在生产 shell 跑。
- 任何中断的事务:下次 fleet 命令会拒绝开新事务,按提示 `recover --txn <ts> --yes`。
- **Runner follow-lead 尚未接线**(Dashboard 有诚实标注)—— FLY-247 Increment 2,issue 不以本 PR 关闭。
