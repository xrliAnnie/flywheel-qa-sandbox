# QA · FLY-706 — token-usage-enable + daily delivery (PASS)

**Issue**: FLY-706 (QA · FLY-699 — 独立验证 token-usage-enable + daily delivery)
**Gates**: FLY-699 (PR #396 — wire up token-usage daily Discord delivery) 脚本/管线侧 ship-readiness
**PR head**: `85ff5bd2dc9c88ac7b5e1d11f32c617fae19763a` (= GitHub head, 已核对)
**Date**: 2026-06-30
**Verdict**: **PASS** — FLY-699 脚本/管线侧 ship-ready。频道接通(Annie 扫 QR / 建频道 + 给 id)= founder 步骤,明确 out-of-scope。

## Scope

只验 PR #396 的**脚本/管线侧**(task 字面要求)。频道创建那步需 Discord MANAGE_CHANNELS(所有 per-Lead bot 返 403/50013)→ 需 Annie 建频道给 id,**暂卡、不阻塞本 QA**。全程在隔离环境跑:fake HOME + throwaway `.env` + 桩 `launchctl` + 桩 COMM,**不碰真 launchd / 真 Discord / 生产 `~/.flywheel/.env` / 生产 token-usage.db**。

PR #396 改 6 个文件:`scripts/token-usage-daily.sh`(.env 顺序修)、`scripts/token-usage-enable.sh` + `scripts/lib/token-usage-enable.sh`(新增 enabler)、`scripts/__tests__/token-usage-enable.test.sh`(20 测)、`.github/workflows/ci.yml`(接 CI)、runbook doc。

## 验证结果(逐项,task 4 项)

### 1. `token-report daily` 真渲染有效 HTML — PASS

跑 `node packages/flywheel-comm/dist/index.js token-report daily --out <scratch>`:

- exit 0;写出 HTML **15423 bytes**。
- `<html>` 1 个;`<title>FLY-614 每日 Token 报告 2026-06-29</title>`;"Token" 标题出现;项目行(flywheel + per-lead + per-issue)齐全。
- **泄漏扫描全 0**:`undefined` 0 / `NaN` 0 / 未渲染模板 `{{` 0 / `[object Object]` 0。
- stderr 只有正常 log 行(Supabase 不可达 → 自动 fallback 本地 SQLite,符合 runbook §2.3 设计,非报错)。

### 2. `token-usage-enable.sh` 幂等(写 env → load launchd → smoke)、重复跑不破坏 — PASS

hermetic 端到端连跑两次(`--channel 1485787271192907816 --dry-run`,桩 launchctl + fake HOME + throwaway `.env` 预置一条无关行 `SUPABASE_URL=`):

| 检查 | 结果 |
|---|---|
| 两次 exit code | 0 / 0 |
| `.env` 里 channel 行数 | 恰 **1**(无重复) |
| 无关行 `SUPABASE_URL=` 保留 | 是(1 条) |
| run1 vs run2 `.env` 字节对比 | **IDENTICAL**(真幂等) |
| launchctl 调用序列(每次) | `bootout gui/<uid>/com.flywheel.token-usage-daily` → `bootstrap gui/<uid> <plist>`(已 load 先卸再装的幂等重载) |
| plist 落点 | fake `$HOME/Library/LaunchAgents/`(**未碰真 LaunchAgents**) |
| dry-run 渲染 | 两次都产出 HTML |

底层 `tue_upsert_env` 的幂等/保留/去重/0600/拒 symlink 由 hermetic 测试 T2a–T2e 另行覆盖(见第 4 项)。

### 3. `daily.sh` 的 .env 顺序修:CHANNEL 在 source `~/.flywheel/.env` **之后**读 — PASS(并证明是真回归)

不只读 diff。把 `origin/main` 的 **pre-fix** `daily.sh` 跟 PR head 的 **post-fix** 放同一场景(channel **只**配在 `.env`、桩 COMM 记 argv、fake HOME):

- **pre-fix**:只调 `token-report daily`,**不调** `publish-report` → bug 复现(`.env` 频道被静默丢,日报渲染了但永不发)。
- **post-fix**:正确以 `publish-report ... --channel 900900900900900900 ...` 调用 → 修有效。

即:这是 PR 真正解决的回归,且 hermetic 测试 T3a/T3b 守住它。修法把 `OUT`/`CHANNEL`/`PROJECT` 移到 `. "$ENV_FILE"` 之后解析,使 `.env` 成单一真相源;plist 进程 env 路径仍可用(冲突时 `.env` 胜),`.env` 未配频道时行为逐字不变(只渲不发,T3b 守)。

### 4. 20 个 hermetic 测试复核 — PASS

`bash scripts/__tests__/token-usage-enable.test.sh` → **PASSED=20 FAILED=0**(真跑,在 PR head)。

- T1(11 例):snowflake 校验 `^[0-9]{17,20}$` — 4 合法 + 7 非法(空/字母/太短/混字符/含空格/21 位过长/负号)。
- T2(7 例):`tue_upsert_env` — 缺文件创建 + 0600 权限 + 替换不重复 + 保留无关行 + 二次 no-op 字节一致 + 替换 `export` 形 + **拒 symlink** + symlink 目标未被写穿。
- T3(2 例):`daily.sh` 的 `.env` 频道解析顺序 — channel 只在 `.env` 必达 publish / 无频道只渲不发。
- 计数核对:循环展开后运行期恰 20 条断言,与 PR 声称的 "20 hermetic cases" 一致。
- **CI**:`.github/workflows/ci.yml` 新增 step "Test — FLY-699 token-usage delivery enabler" 调该测试,接线正确。
- **shellcheck**:warning+ 严重级下 4 个新/改脚本**全 clean**;仅剩 info 级 SC1091(动态 source 未跟随,预期)/ SC2015(`A && B || C` 习语 note,这些断言行用法正确,20/20 实证)— 非缺陷。

## 小观察(非阻塞)

- runbook §4「安全:token 全程经 `curl -K` stdin」这句描述的是 PR **之外**的 `token-usage-setup-channel.sh`(MANAGE_CHANNELS 自建频道路径);**本 PR 无任何 curl 用法**,该句放在「本 PR 改了什么」一节属轻微文档错位。不影响功能。
- runbook/PR body 写 HTML "15.7KB",本次真渲为 15423 bytes(~15.1KB);差异源于日报数据量逐日变化,非缺陷。

## 结论

FLY-699 脚本/管线侧四项全 PASS,字节兼容(无频道=行为不变)守得住,回归测试真覆盖且 CI 接线。**脚本/管线侧 ship-ready**。剩 founder 步骤:Annie 建/给 `token-usage` 频道 id(或给某 bot MANAGE_CHANNELS)→ 跑 `token-usage-enable.sh --channel <id>` 发样例 = 接通铁证;可选 apply Supabase 迁移开远程持久化。
