# FLY-1242 删除 lead_pane_readiness 死 flag — 探索

Issue: FLY-1242 (https://linear.app/geoforge3d/issue/FLY-1242/flag-cleanup-delete-lead-pane-readiness-dead-opt-in-fly-1136-audit)
日期: 2026-07-14
基于: 无

## 背景

FLY-1136 flag 审计中,`lead_pane_readiness` 被 Annie 圈为**不确定**,交工程终判。Tadashi(Eng Lead)2026-07-14 终判 = **删**。

工程事实(终判依据):`lead_pane_readiness` 是**死 opt-in** —— 生产从未开过、313 家族(FLY-313)已用别的修法收口冷启就绪问题、今晚两次重启 Lead 都无恙。无依赖、无行为变化风险。

## 这个 flag 是什么

FLY-109 引入的 **Bridge pane readiness 冷启加固**(defense-in-depth)。开启后,`createLeadRuntime` 在声明 Lead 就绪前,会软等待 Lead 的 tmux pane 打印出 MCP channel-handler marker(`"Listening for channel messages from:"`)。

关键点:**correctness 不依赖它**。inbox-mcp 的 ack/retry 状态机负责保证任何早于 handler 安装就触发的 push 都能恢复。这个 pane 检查只是防冷启惊群的额外一层,默认关闭(opt-in)。

## 代码库审计 —— 死代码路径完整边界

repo-wide `grep`(排除 dist/node_modules)确认,该 flag gate 的全部触达:

| 位置 | 内容 | 处置 |
|------|------|------|
| `packages/config/src/feature-flags/registry.ts:1412-1430` | flag 定义对象 | 删 |
| `packages/teamlead/src/bridge/plugin.ts:659-688` | flag-gated 死块(读 `FLYWHEEL_LEAD_PANE_READINESS` + `_TIMEOUT_MS`,调 `lookupLeadWindowId` + `waitForPaneMarker`) | 删 |
| `packages/teamlead/src/bridge/plugin.ts:329` | `import { waitForPaneMarker } from "./pane-readiness.js"` | 删(仅被死块用) |
| `packages/teamlead/src/bridge/plugin.ts:694-725` | `lookupLeadWindowId` 辅助函数 | 删(仅被死块调用) |
| `packages/teamlead/src/bridge/pane-readiness.ts` | 整个模块(`waitForPaneMarker` + 私有 helper) | 删(仅被死块 + 自身测试引用) |
| `packages/teamlead/src/__tests__/bridge-readiness.test.ts` | 整个测试文件 | 删(仅测被删模块) |
| `packages/config/src/__tests__/feature-flags-drift.test.ts:161-162` | `FLYWHEEL_LEAD_PANE_READINESS_TIMEOUT_MS` allowlist entry | 删(env 全删后失效) |

### 不动的引用(历史记录 / 注入 context)

- `product/doc/FLY-1091-feature-flag-policy/{audit,exploration}.md` —— FLY-1091 flag 审计的历史记录,忠实记录当时状态,不改。
- `engineering/doc/FLY-709-fleet-flag-console/research.md` —— FLY-709 的历史 research,不改。
- `.claude/skills/{flywheel-git-workflow,linear-issue-context,flywheel-escalation}/SKILL.md` —— Bridge 为本 issue 注入的运行时 context,只是引用了 issue 标题,非代码引用,不改。

## drift guard 一致性分析

`feature-flags-drift.test.ts` 是 registry↔code 双向漂移守卫,是本次删除的安全网:

- **反向**(registered→read):删掉 registry entry 后不再校验该 flag。若只删 registry 却留下 code read → **前向**测试会因「扫到未注册的 `FLYWHEEL_LEAD_PANE_READINESS`」而 FAIL —— 这保证 registry 与 code 必须同删。
- **前向**(scanned→registered/allowlisted):`FLYWHEEL_LEAD_PANE_READINESS` 从 plugin.ts 删除后不再被扫到;`FLYWHEEL_LEAD_PANE_READINESS_TIMEOUT_MS` 同理,其 allowlist entry 变为无效引用,一并清理(前向测试不强制 allowlist 项必须被用到,故不删也不会 FAIL,但属死配置 → 清理)。

## 风险评估

**零行为变化。** flag 生产从未开过,删除的是一条永远走不到的分支。默认的 lease-only readiness 路径(`isLeaseAlive` + commDb 存在性检查)完全不动。
