# FLY-2363 InfraBot 传感器 — 实现证据
Issue: FLY-2363 (https://linear.app/geoforge3d/issue/FLY-2363)
日期: 2026-09-13
基于: plan.md

## 范围与裁定

- 意图 gate `86eefe5a-71a4-4620-9773-3311f4af79bf`：Lead 裁定无意漏配；生产暂不启用，依赖 FLY-2530 解决启动自锁。
- 设计 gate `ccf7ff25-ba76-4018-8ed9-24fabe6d1aa5`，request `b4481467-7f7a-49e4-8f06-0676543919cb`：APPROVED，MEDIUM/LOW 建议已报告。
- 后续操作裁定 `78dac302-f680-4d65-a3cd-aca61ad9e73f`：30 分钟演练窗口、精确 job bootout、host 进程过滤证据作为硬前置、说明探针严格度差异和 capture 注释限制；多 episode 回滚列为 follow-up。仅更新 runbook，pinned plan 不改。
- 顺序确认 `42835680-31cd-4b94-a665-e77188547f43`：bootout → RED → 重载 → GREEN。

## 实现

只新增 Node 标准库只读 preflight，35 秒两次检查顶层 state/pid/runs；任何未知、非运行、换代都拒绝且不输出配置行。稳定通过时输出候选配置行，但不写文件、不重启。原始 runtime sensor 和 FLY-2530 launcher 均不改。部署模板保持空 key，CI 在现有 infra-alert 步骤内逐字枚举新测试。

## 验证

| 检查 | 结果 |
|---|---|
| TDD 初始 crash-loop 用例 | RED：新模块未实现，ERR_MODULE_NOT_FOUND；实现后 GREEN |
| `node --test scripts/__tests__/infra-bot-sensor-preflight.test.mjs` | 28/28 PASS，含 CLI 非零/无配方、输入拒绝、两次采样、稳定恢复与未知错误 |
| 实际 host 只读 preflight | rc=1：`REFUSED: not running: spawn scheduled; last exit code=3; possible KeepAlive crash-loop; do not enable the sensor` |
| `pnpm lint` | rc=0，16 warnings |
| `pnpm -r build` | rc=0 |
| `pnpm test:packages:run` | rc=1；config `fly1981-final-ledgers.test.ts:262` 的 `freezes the exact five Batch 6 retirement ledgers` 超时 15000ms；该包 817 passed / 1 failed，后续包未获得完整验证 |
| 单独运行上述现有 config 测试文件 | 11/11 PASS，失败用例 2727ms；不将此结果覆盖全包失败 |
| `bash scripts/__tests__/ci-structure.test.sh` | 新增独立 step 首次 FAIL；将新测试枚举放回现有 infra-alert step 后 PASS |
| `bash scripts/__tests__/fleet-sanitize.test.sh` | 41/41 PASS |
| `git diff --check` | PASS |

原始本地日志在 `/tmp/fly2363-*.log`，不含生产完整 env。没有新增 shell 测试。生产 preflight 的拒绝证明 guard 识别当前失败，不是生产传感器 RED；fixture PASS 也不是生产 GREEN。

## 交接边界

本轮产出配方、guard、模板和未来验收方案。生产 env/plist 未改，Bridge/Lead 未重启，未执行 bootout 或强停，未取得真实 RED/GREEN。Lead 必须在 FLY-2530 生效后获取新的 founder 当次授权，按 enable-runbook 回填全部收官证据。本 PR 不代表 issue 生产验收完成。
