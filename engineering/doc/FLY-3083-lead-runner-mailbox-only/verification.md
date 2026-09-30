# FLY-3083 Lead→Runner 消息只走 Mailbox — 本机定向验证记录

Issue: FLY-3083 (https://linear.app/geoforge3d/issue/FLY-3083/规矩机制leadrunner-消息-所有-lead-的共用规矩还在教日常聊天用-sendmessage5-月-fly-142-的旧版和-7)
日期: 2026-09-30
基于: plan.md

按 `local-test-policy/v1`:只跑与改动相关的测试,每条命令一个具体测试文件;全量交给精确头 PR CI。
本文件只是本机定向证据,**不是**全量证据。

## 1. 测试发现

- 改动文件(`git diff --name-only b9ccf6f4c..HEAD`,不含本文件夹)逐个按「带扩展名文件名 + 完整路径」`git grep -lF` 搜测试文件,命中 114 条(去重后约 80 个测试文件)。
- 排除项与理由:
  - `index.ts` 的 8 处命中(edge-worker / github-event-transport / teamlead runner-status 等):引用的是别的包或测试文本里的 `src/index.ts` 字样,不是 `packages/flywheel-comm/src/index.ts`;后者由 `cli.test.ts` + `vitest related` 覆盖。
  - `db.ts` → `scripts/__tests__/qa-fly-1189-assert.test.sh`:只在注释里提到 CommDB schema,不 import。
  - `scripts/__tests__/package-onboard-smoke.test.sh`:真 npm 全链 + 网络,慢;CI 的 FLY-1062 独立 step 负责。
- TypeScript 改动另跑 `vitest related`:flywheel-comm(`db.ts`/`send.ts`/`index.ts`)与 teamlead(`LeadAlertNotifier.ts`/`LeadWatchdog.ts`/`kind-contract.ts`/`infra-event-router.ts`/`codex-lead-runtime.ts`)。

## 2. 结果(本分支 HEAD,逐文件)

新增/改动的 FLY-3083 测试:

| 测试 | 结果 |
|---|---|
| flywheel-comm `db-resolve-execution-id.test.ts` | 11/11 |
| flywheel-comm `send-mailbox.test.ts` | 15/15 |
| flywheel-comm `cli.test.ts` | 43/43 |
| `scripts/hooks/test-runner-msg-guard.py` | 67/67 |
| agent-team-transport `fly3083-runner-alias-oracle.test.ts` + `path-helpers.test.ts` | 147/147(oracle 127 条;变异:把非 BMP 改成单个 `-`,8 条失败) |
| `scripts/hooks/test-runner-msg-guard-install.sh` | 21/21 |
| `packages/teamlead/scripts/__tests__/fly3083-guard-install-plan.test.sh` | 19/19 |
| teamlead `fly3083-mailbox-only-rules.test.ts` | 10/10 |
| teamlead `lead-rules-bundle.test.ts`(期望列表更新) | 15/15 |
| teamlead `bridge/__tests__/kind-contract.test.ts`(新增 4 条显式断言) | 14/14 |
| `scripts/__tests__/lead-alert-mailbox-fault.test.sh` | 16/16(含契约模板原样可执行、`:?` 守卫) |
| `codex-lead-args.test.sh` / `run-codex-infra-bot-tui.test.sh` / `run-codex-lead-mufasa-tui-fullaccess.test.sh` / 新 `run-codex-lead-mufasa-fullaccess.test.sh` / `run-codex-lead-mufasa-tui.test.sh`(反向) | 8/8 · 14/14 · 14/14 · 3/3 · 21/21(变异:去掉 helper 调用,断言失败) |
| teamlead `codex-lead-runtime.test.ts` / `codex-lead-tui-runtime.test.ts`(`TMPDIR=/tmp`,见 §3) | 116/116 · 19/19 |
| `scripts/__tests__/package-onboard-fly3083.test.sh` | 7/7(真实 `po_copy_asset_files` + 真实 `po_gate` PASS;去掉 `.allow` 行的负控 FAIL) |
| `fly231-companion-launch-plan.test.sh`(golden 加契约规则 + 告警 env) | 46/46 |

既有相关测试(全部通过):flywheel-comm `send-backend-routing` 7、`commands` 21、`e2e-workflows` 4、`declare-state` 9;flywheel-comm `vitest related` 30 文件 470 条;teamlead `fly369-patrol-rule` 10、`misroute-render` 4、`LeadAlertNotifier` 51、`LeadWatchdog-fly1048-multiframe` 12、`LeadWatchdog-fly927-echo` 6、`infra-alert-wiring` 10、`infra-event-router` 12、`ticket-owner-map` 17、`external-agent-contract` 15、`fly222-memory-rule` 6、`stuck-escalation` 42、`sync-flywheel-hooks` 20、`fleet-data` 32、`tui-window-alert` 15、`eventIdParity` 5、`automated-message-inventory` 2、`fly350-fullaccess-deploy` 10;config `founder-ux-config` 23;teamlead launcher shell 测试 20 个(`fly879-*`、`fly241`、`fly869`、`lead-env-propagation`、`restart-env-propagation`、`mcp-*`、`manifest-*`、`tmux-integration` 等)全绿;`scripts/__tests__` 下 lead-alert / package-onboard / gate4 / payload-release / restart-notify 等 21 个全绿;`test-reply-enforcer-install-integration.sh` 6/6。

## 3. 非本改动引起的失败(基线对照)

| 测试 | 现象 | 判定 |
|---|---|---|
| teamlead `vitest related`(1248 条) | 13 条失败,分布在 `event-route.test.ts` 3、`event-route-dual-session-completed.integration` 4、`event-route-session-completed-guard` 2、`event-route-fly945-reopen-review` 1、`complete-marker-reconciler.integration` 1、`createLeadRuntime-preflight` 2 | 把本分支改过的文件临时还原到派单头 `b9ccf6f4c` 后逐文件重跑,**失败数逐文件完全相同**(1/2/4/1/2/3)→ 基线既有;随后 `git checkout HEAD --` 恢复,工作区干净 |
| `screencap-skill-gate.test.sh` | 0/4,`IS_COMPANION_ROLE: unbound variable` | 测试抽取的 claude-lead.sh 片段在 base 与 HEAD 逐字相同;夹具没给该变量 → 基线既有 |
| `test-fly26-rules-split.sh` | 88/90,6.7(base 规则里有人名)、6.18(founder-html-delivery 锚点) | 两条只涉及本分支没改的文件 |
| `test-flywheel-restart-guard.py` | 135/136,T8 真实 lead-alert HTTP 200 路径 | plan §7 风险 5 已登记的基线失败 |
| `test-reply-enforcer-install.sh` | T16 处 rc=5 退出 | 本机 jq 对坏 JSON 返回非零,`set -e` 中断;测试只用它内联的 filter,不读本分支文件 |
| `codex-lead-runtime.test.ts`(默认 TMPDIR) | 22 条环境失败 | Runner 的 TMPDIR 在 `~/.flywheel` 下,触发 full-access 项目根与 `~/.flywheel` 重叠守卫;`TMPDIR=/tmp` 下 116/116 |

## 4. 其他检查

- `pnpm lint`:本分支 17 个 TS/JSON 改动文件 biome 干净;全仓报的 2 个 error 在 git-exclude 的 `.flywheel/runs/` 本地产物(设计节点留下的 JSON),不进仓库。
- 构建:`pnpm --filter "flywheel-comm^..." build`、`pnpm --filter flywheel-comm build`、`pnpm --filter "flywheel-teamlead..." build`、terminal-mcp / inbox-mcp 构建均成功;`tsc --noEmit -p packages/teamlead` 无错误。
- 真实数据核对:沙箱 CommDB 中本 Runner 的 `sessions.lead_id` = `flywheel-test-3` = Lead 的 `FLYWHEEL_LEAD_ID`,短名解析按 Lead 过滤可命中。
- 新增 `scripts/__tests__/*.test.sh`:`lead-alert-mailbox-fault.test.sh`、`package-onboard-fly3083.test.sh` 均单独跑过并接入 CI。

## 5. 交给 QA / CI

- 全量:精确头 PR CI(本机不跑全量)。
- 真机 QA 场景见 plan §8(Lead `SendMessage` 被拦、别名、广播、照 reason 命令发送、故障注入、Codex Lead、卸载/开关)。
