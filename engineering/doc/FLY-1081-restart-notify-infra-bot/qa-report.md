# FLY-1081 三条通知路去 Simba 化 — QA 报告 (PASS)

Issue: FLY-1081 (https://linear.app/geoforge3d/issue/FLY-1081/fix-重启更新wrapper-三条通知路仍写死-simba-迁到-infra-botfly-915-痛点-3927-只迁了一条)
日期: 2026-07-09
基于: plan.md、exploration.md、research.md

> 三段式流水线的 **QA 阶段**独立复核。实现由 implement 阶段在本分支提交（PR #540），
> QA 未重写功能，只验证 + 补测 + 报告。

## 0. 结论

**PASS。** 四条通知路（restart-services / update-flywheel / bridge-wrapper fallback +
routine）全部迁离 Simba：⚠️/🚨 改道 `lead-alert.sh` 的 FLY-927 发送方接缝
（`FLYWHEEL_ALERT_SENDER_TOKEN_ENV`），routine 走 `CLAUDE_INFRA_BOT_TOKEN`；接缝/
config 解析不到一律 **fail-loud 拒回落**，绝不落回 Simba/`DISCORD_BOT_TOKEN`。
`SIMBA_BOT_TOKEN` 在 Flywheel 侧 grep-zero。全测试绿、typecheck 绿、PR #540 CI 绿。

唯一未在 QA 内完成的验收项 = **真机重启截图**（Infra Bot 发言 / Simba 零发言），
按 plan §5 属 Tier-3 生产扰动，显式挂下一个 batched restart 窗，QA 不专门触发生产
重启（需 founder 授权）。这是设计内的部署期步骤，非代码缺陷。

## 1. 验证矩阵

| # | 验收项（issue / plan） | 方法 | 结果 |
|---|---|---|---|
| 1 | 三条路 route via 927 接缝、复用 lead-alert.sh 解析、不各写一份 | 逐文件读实现（restart:117-136 / update:48-57 / wrapper:113-127）+ 单测 | ✅ |
| 2 | fail-loud：接缝解析不到 **不**回落 Simba | 读 lead-alert.sh:256-272（sender 空→dead-letter）+ 独立 e2e Case B | ✅ |
| 3 | `SIMBA_BOT_TOKEN` Flywheel 侧 grep-zero | `git ls-files scripts packages \| xargs grep -n SIMBA_BOT_TOKEN` → 空 | ✅ |
| 4 | bridge-wrapper 早期通知（Bridge 未起也能正确署名） | 读三脚本 `set -a; source ~/.flywheel/.env` 均在 notify helper 之前；接缝就地解析 | ✅ (代码级)；真机截图=部署窗 |
| 5 | routine 删静默回落（env 缺 → 报错留痕不回落） | 读 restart:145-169（curl 失败/env 缺 → stderr ERROR + meta-alert + rc 0） | ✅ |
| 6 | deploy_failed 必 @Annie | restart:129-135 / update:50-57 `--mention-user $FLYWHEEL_FOUNDER_USER_ID`；缺 → WARNING 降级不 @ | ✅ |

## 2. 测试执行（全绿）

Shell（CI 接线 4 个 + FLY-927 既有 2 个）:
- `lead-alert-fly927.test.sh` — 37 passed
- `restart-services-notify.test.sh` — 28 passed
- `restart-notify-routine.test.sh` — 13 passed（Case2/3 已翻转为「零 curl + meta-alert」）
- `update-flywheel-queue.test.sh` — 17 passed
- `simba-grep-zero.test.sh` — 5 passed
- `bridge-wrapper-fail-loud.test.sh` — 18 passed

TypeScript（`vitest run`）:
- `LeadAlertNotifier.test.ts` — 51 passed（含 union 新 kind + mention 合并 + queue→drain round-trip）
- `LeadWatchdog.test.ts` — 68 passed
- `LeadWatchdog-fly1048-multiframe.test.ts` — 12 passed
- `pnpm -C packages/teamlead typecheck` — 绿（穷尽 switch 新 case 满足 noImplicitReturns）

PR #540 `Build & Test` — **pass**（fetch origin/main 后核 head）。

## 3. QA 补充证据 — 独立 e2e（`scripts/__tests__/qa-fly1081-notify-identity.test.sh`）

不复用实现阶段的 sed-抽函数，直接以生产调用形态（`--lead deploy` / `--kind
deploy_failed|deploy_degraded`）调**真 lead-alert.sh**，fake curl 记录 argv + `-K -`
stdin：

- **Case A** 接缝可解析 → POST 打 unified 频道、**INFRA token 走 stdin config**、
  **SIMBA token 全程零出现**、founder `<@id>` 前缀进 content + `allowed_mentions.users`。
- **Case B** 接缝 set-but-unresolvable → 结果 `config_error`、**零 curl POST**、
  stderr `refusing per-lead fallback`、SIMBA 零出现 → **确认不回落**。
- **Case C** `deploy_degraded`（warning）被 kind 白名单接受 + sent。

→ 11 passed, 0 failed。

> QA 排障记录：初版 Case B 误判「回落」，根因是本 QA runner 自身环境已 source
> `~/.flywheel/.env`、真实 `FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN` 被 `env` 继承进子进程
> 使接缝可解析（且**即便如此也用的是 dispatch token、非 Simba**）。改指向确定未设的
> 变量名后 Case B 正确复现拒回落。属测试隔离问题，非实现缺陷。

## 4. 残留清扫

- `notify_discord` 在三脚本中**已全删**。
- 三脚本仅剩两处 `discord.com/api` 直发：bridge-wrapper:121（gate 批准的 core
  fallback，token 经接缝）+ restart:152（routine → #flywheel-notify，
  `CLAUDE_INFRA_BOT_TOKEN` 经 stdin config）——均为设计内 infra 路径，非 Simba。
- 三脚本仅剩一处 `DISCORD_BOT_TOKEN`：restart:927 合法 per-lead 子进程注入
  （`DISCORD_BOT_TOKEN=${!bot_token_env}`），正是 sentinel 白名单的逐字形态。

## 5. 交接给部署窗（唯一遗留项）

真机重启截图验收（Infra Bot 发言 / Simba 零发言）= plan §5 明列 Tier-3、搭下一个
batched restart 窗，**QA 不专门触发生产重启**。生效方式：三脚本 merge 后 `git pull`
即生效；`LeadAlertNotifier`/`LeadWatchdog` 需随 batched restart 生效。
`FLYWHEEL_FOUNDER_USER_ID` / 接缝双 env / `CLAUDE_INFRA_BOT_TOKEN`+`FLYWHEEL_NOTIFY_CHANNEL`
生产已实测全设（research §1.5）。回滚 = revert PR，无状态迁移。
