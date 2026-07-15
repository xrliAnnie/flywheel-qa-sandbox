# FLY-913 部署护栏 restart-guard hook — QA 验证报告

Issue: FLY-913 (https://linear.app/geoforge3d/issue/FLY-913)
日期: 2026-07-06
基于: plan.md / 实现分支 head 4c38712d(re-test epoch=4)

## 判定:PASS ✅

三段式 pipeline 的 QA 阶段独立复验 implement 阶段推的 P3 wrapper-bypass 修复系列
(sudo/env/nohup 前缀剥离、env -S/-iS/-P、package-manager exec、bunx/corepack、
shell/utility wrapper)。核心安全属性——「手动重启 flywheel 服务被硬拦、合法路径放行、
bypass fail-closed」——全部成立。

## 验证内容与结果

### 1. 实现者测试套件(独立重跑,全绿)
| 套件 | 结果 |
|------|------|
| `scripts/hooks/test-flywheel-restart-guard.py` | 133 passed, 0 failed |
| `scripts/hooks/test-restart-guard-install.sh` | 11 passed, 0 failed |
| `scripts/__tests__/lead-alert-strict-delivery.test.sh` | 14 passed, 0 failed |

### 2. 独立行为矩阵(全新角度,直喂 JSON 给真 hook — `qa/qa_matrix.py`)
37/37 passed。覆盖本轮修复的 wrapper bypass 全类:
- **必拦(DENY)**:`sudo -E node … run-bridge`、`env node … run-bridge`、
  `nohup scripts/run-bridge.ts &`、`env -S 'node … run-bridge'`、`env --split-string=…`、
  `env -iS …`(S 在短选项簇内)、`env -P /usr/bin node … run-bridge`、
  `pnpm/npm/yarn/pnpx tsx … run-bridge`、`pnpm exec tsx …`、`bunx …`、
  `corepack pnpm tsx …`、`command/exec/time/nice/caffeinate/timeout/setsid node … run-bridge`、
  `bash -lc / sh -lec 'node … run-bridge'`、P1 `launchctl kickstart com.flywheel.*`、
  P2 `pkill -f run-bridge` / `pgrep -f run-bridge | xargs kill`、`cd /tmp && launchctl bootout …`。
- **必放行(ALLOW)**:`bash scripts/restart-services.sh [--force]`、`pnpm build`、
  `pnpm run lint`、读工具 `grep/rg/cat/git log … run-bridge`、
  `launchctl print`(只读子命令)、无关 `kill -9 <pid>` / `git commit`。

### 3. bypass 记账 fail-closed 契约(`qa/qa_bypass.py`)
6/6 passed。bypass 只有在「审计写入成功 **且** strict alert 返回 sent/queued_transient」
两条件都满足时才 ALLOW:
- bypass + alert=sent → **ALLOW** + 审计行落盘;
- bypass + alert=dead_lettered / 缺失 / 审计不可写 → **DENY**(告警成功也救不回审计失败);
- 假 bypass(`echo FLYWHEEL_…=x; …`,非真 env 赋值)、空 reason bypass → **DENY**。

### 4. CI 接线
`.github/workflows/ci.yml` 新增步骤跑上述三套测试(hermetic,alert seam stub + fake HOME +
隔离 FLYWHEEL_* 目录),防静默回归。已确认。

## 已知边界(非缺陷,plan §5 明确接受)
「wrapper + executor token + 字面 run-bridge」出现在同一命令段时会被 DENY,例如
`timeout 60 pnpm test -- run-bridge.test.ts`。这是设计上「结构性封死 wrapper 绕过」的
有界代价(Codex 8 轮审过),测试文件 line 12-14 显式声明该类 out-of-matrix 误报接受、
不断言;真实 relaunch 形态(`nice/timeout node … run-bridge`)则被 line 170-173 断言拦截。
escape hatch = bypass 前缀(会立刻响 Annie)。读工具(`grep/git log … run-bridge`,首 token
非 wrapper)正确放行。

## 环境无关的观察(不阻塞 FLY-913)
`packages/teamlead/src/__tests__/LeadAlertNotifier.test.ts` 在本 Runner 里 1 例失败:
`resolved-bot-token` 断言拿到真实 `SIMBA_BOT_TOKEN`。根因 = 本 Runner 的 shell 继承了
生产 bot token,`LeadAlertNotifier` 优先读 `process.env.SIMBA_BOT_TOKEN`(测试隔离缺陷)。
`env -u SIMBA_BOT_TOKEN -u PETER_BOT_TOKEN -u DISCORD_BOT_TOKEN` 清掉后 → **27/27 全绿**
(等同干净 CI)。与 FLY-913 无关:本分支既没改该测试也没改 token 解析逻辑,唯一改动是
`LeadAlertNotifier.ts` 的一行类型 union 追加(`restart_guard_bypass`)。属 FLY-368 测试的
预存隔离问题,单列不阻塞本 issue。

## 复现
```
python3 scripts/hooks/test-flywheel-restart-guard.py
bash scripts/hooks/test-restart-guard-install.sh
bash scripts/__tests__/lead-alert-strict-delivery.test.sh
python3 engineering/doc/FLY-913-restart-guard-hook/qa/qa_matrix.py
python3 engineering/doc/FLY-913-restart-guard-hook/qa/qa_bypass.py
```
