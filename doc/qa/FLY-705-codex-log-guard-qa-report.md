# QA · FLY-705 — codex-log-guard 独立 hermetic 验证 (PASS)

**Issue**: FLY-705 (QA · FLY-697 — 独立验证 codex-log-guard)
**Gates**: FLY-697 (PR #395 — codex-log-guard,止 Codex TRACE 日志磨 SSD) ship-readiness
**Date**: 2026-06-30
**Verdict**: **PASS** — 697 ship-ready
**Method**: hermetic(全程临时 sqlite + 临时 HOME + shim 掉 lsof/osascript/meta-alert),**绝不碰真 `~/.codex/logs_2.sqlite`**

---

## 验什么

PR #395 给的是纯 bash + `sqlite3` 工具 `scripts/codex-log-guard.sh`(5 个子命令:`status` / `install-trigger` / `vacuum` / `remediate` / `monitor`)。本 QA 是**独立**验证:不只 rerun PR 自带的 10-case 测试,而是**从头写一套独立 harness**(`doc/qa/scripts/qa-fly705-codex-log-guard.sh`)逐条验 FLY-705 brief 的 5 个 claim,再用 PR 自带套件 + shellcheck 交叉确认。

## Hermetic 保证(绝不碰真 DB)

- 每次调用都把 `CODEX_LOG_DB` 钉在 `$ROOT/*.sqlite` 临时路径,且 `HOME=$ROOT`(临时)→ 连脚本默认路径 `$HOME/.codex/logs_2.sqlite` 都重定向到临时目录,真 `~/.codex` 结构上不可达。
- `lsof` / `osascript` / `meta-alert.sh` 全用临时 shim(PATH/env 注入)。
- **Sentinel**:整轮测试前后只读 `stat` 真 DB 的 `dev:inode:size`,断言不变。
  - 结果:`16777232:1785647:1146437632` **前后一致** → 我的测试从未写它。
  - mtime 在测试期间移动(~9s)= **线上 Codex desktop 正并发写它**(3 个 codex 进程活跃打开,WAL 模式),这恰好反证 **FLY-697 问题真实且正在发生**,与本测试无关。

## 5 个 claim 验证结果(独立 harness,24/24 PASS)

### Claim 1 — TRACE 触发器真拦 `level='TRACE'`(RAISE IGNORE),非 TRACE 正常写 ✅
- `install-trigger` 成功装上 trigger;trigger SQL 经独立断言确为 `BEFORE INSERT ON logs WHEN NEW.level IN ('TRACE') ... SELECT RAISE(IGNORE)`。
- 装后:`INSERT ... level='TRACE'` **静默丢弃**(计数 2→2);`INFO/WARN/ERROR/DEBUG` **各 +1 正常落库**。
- 配置项:`CODEX_LOG_GUARD_LEVELS=TRACE,DEBUG` 时 TRACE 与 DEBUG 都被拦、INFO 仍落库 → 阻断级别可配置。

### Claim 2 — vacuum 回收死页 ✅
- 造一个有死页的临时 DB(bulk insert ~5000 行 padded blob → 删到只剩 20 行)。
- `vacuum` 后:`20537344 → 69632 bytes`(回收 >99%);**存活 20 行数据完整无损**。

### Claim 3 — lsof 安全闸:占用时写操作全 refuse、status/monitor 只读安全、fail-closed ✅
| 子命令 | DB 被占用(`FAKE_LSOF_BUSY=1`)行为 | 结果 |
|---|---|---|
| `install-trigger` | 非零退出、**不写 trigger** | ✅ refuse |
| `vacuum` | 非零退出、**size 不变** | ✅ refuse |
| `remediate` | 非零退出、**无 trigger、无 vacuum**(PR 自带套件未覆盖,本 QA 补) | ✅ refuse |
| `status` | rc=0、报 `in_use=yes`、不 refuse | ✅ 只读安全 |
| `monitor` | rc=0、**不写 DB**、size 行照常记 | ✅ 只读安全 |

- **fail-closed 真路径**:把脚本副本的 `/usr/sbin/lsof` 探针改成不存在路径 + PATH 无 lsof → `resolve_lsof` 返回空 → `db_in_use` 返回「占用」→ `install-trigger` **refuse**(rc≠0、无 trigger)。重现成功。
- 此机 macOS `/usr/sbin/lsof` 恒在,故"lsof 完全缺失"在真机用 env 不可直接复现,以脚本副本复现 + 代码审计双证。

### Claim 4 — monitor:超阈值 meta-alert + 低于静默 + 稳定 reason key(去抖入口)✅
- 超阈值(threshold=1)→ **触发 meta-alert**,reason key = `codex_log_bloat`。
- 第二次同条件再跑 → **复用同一 reason key**(2 个相同 key)→ 下游 `meta-alert.sh` 可据此 dedup 去抖。
- 低于阈值(threshold=1GB,小 DB)→ **静默**,无 alert。
- alert 正文只含路径 + 字节数 + 修复指令,**不含日志正文**(见 Claim 5)。

### Claim 5 — 绝不打印日志正文 / 不拷 DB 出机 ✅
- **Runtime**:在 `feedback_log_body` 植入 `QA705_SECRET_…` sentinel → 断言它**绝不出现**在 `status` / `monitor` 输出 / alert 正文 / monitor.log。
- **Static**:脚本全文无 `feedback_log_body` 引用;无 `scp/rsync/curl/wget/nc/ftp/sftp`(无出机拷贝路径);无 `cp $DB`(DB 不被复制);每条 `SELECT` 都是 `COUNT(*)` / `sqlite_master` 元数据或 trigger body 的 `RAISE(IGNORE)`,**无裸行读取**。

## 交叉确认

| 项 | 结果 |
|---|---|
| 独立 harness(`doc/qa/scripts/qa-fly705-codex-log-guard.sh`) | **24 / 24 PASS** |
| PR 自带 `scripts/__tests__/codex-log-guard.test.sh` | **10 / 10 PASS**(确认 PR claim) |
| `shellcheck -S warning` — PR 的 `codex-log-guard.sh` + 其 `__tests__/codex-log-guard.test.sh` | **CLEAN** |
| `shellcheck -S warning` — 本 QA 自己的 harness(`qa-fly705-codex-log-guard.sh`) | **CLEAN** |
| `bash -n` 语法(PR 脚本 + 本 harness) | OK |
| 真 `~/.codex/logs_2.sqlite` identity+size | 全程**未变**(未被本测试碰) |

## Findings(均非 ship-blocker)

1. **[已知 spec-vs-impl 差异 · Lead 确认非 blocker]** FLY-705 brief 第 4 条写「trigger 缺失 → meta-alert」,但实现 `cmd_monitor` 只在 `size >= threshold` 时告警:trigger 缺失只写进告警 body(informational),不是独立告警路径。设计意图(实现文档已述)= trigger 被 schema 迁移删掉后日志**回涨**,由 size 阈值告警抓住。去抖也不在本脚本,而是把固定 reason key 交给外部 `meta-alert.sh`(不在本 PR)下游 dedup。Tadashi 确认:按实现实际行为判,此条当已知差异如实记录、不当 blocker。

2. **[LOW · 健壮性观察,非生产路径]** `db_in_use` 只在 `resolve_lsof` 返回**空**(lsof 完全找不到)时 fail-closed;若 lsof 能解析但**无法 exec**(如 `LSOF_BIN` 指向坏二进制),`"$lsof_bin" -- "$f"` 返回 127 被当作「没占用」→ 写操作**放行**(fail-OPEN)。与「无法证明空闲就拒绝」的措辞有一处缝隙。但:① `LSOF_BIN` 是 test-only hook,生产不设;② 生产经 `command -v lsof`(已确认可执行)或 macOS 恒在的 `/usr/sbin/lsof` 解析,不会命中此分支。**非生产可达,不阻塞 ship**。可选硬化:`db_in_use` 在 lsof exec 失败(非 1 的退出码,如 127)时也 fail-closed。

## Verdict

**PASS — FLY-697 (PR #395) ship-ready。** 核心保护(TRACE-拦截 trigger + size monitor + lsof 写闸 fail-closed + 不泄漏正文/不拷 DB)全部独立验证通过;两个 finding 均非 blocker(一个是已知 spec 措辞差异,一个是 test-only-hook 的低危健壮性观察)。

## 复现

```bash
# 从 PR #395 branch 取脚本,对它跑独立 harness(hermetic,绝不碰真 ~/.codex)
git show origin/flywheel-FLY-697:scripts/codex-log-guard.sh > /tmp/guard.sh
bash doc/qa/scripts/qa-fly705-codex-log-guard.sh /tmp/guard.sh
# 期望:FLY-705 independent QA: 24 passed, 0 failed
```
