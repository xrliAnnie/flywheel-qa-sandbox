# Codex TRACE 日志 SSD 磨损 — 治理工具 (FLY-697)

**Issue**: FLY-697 ([infra] Codex TRACE 日志高频写盘磨 SSD — ~/.codex/logs_2.sqlite 涨到 1.1GB)
**URL**: https://linear.app/geoforge3d/issue/FLY-697
**Date**: 2026-06-30
**Status**: Implemented

---

## Problem — 根因

Codex 桌面端把 TRACE 级日志高频写进 `~/.codex/logs_2.sqlite`。在 Annie 机器上实测:

| 指标 | 值 |
|------|-----|
| `logs_2.sqlite` 文件大小 | **1.1 GB** (`size_total_bytes=1163947280`) |
| `logs` 表 level 分布 | TRACE 30.9 万行 (**77%**) / INFO 5.5 万 / DEBUG 3.0 万 / WARN 5.9k / ERROR 619 |
| 当前总行数 / `MAX(id)` | 40 万行 / **9931 万** |
| 占用进程 | 3 个 `codex` 进程正活跃打开它(`lsof` 确认,WAL 17MB) |

关键观察:`MAX(id)`(9931 万)远大于当前行数(40 万)= 历史上约 **9900 万行被插入又清掉**。1.1GB 大部分是 SQLite 没回收的**死页**(VACUUM 未跑),而那 9900 万次插入本身就是**写放大 = 磨 SSD 的根因**。

`logs` 表 schema(摘):

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL,
  level TEXT NOT NULL, target TEXT NOT NULL,
  feedback_log_body TEXT, ...
  estimated_bytes INTEGER NOT NULL DEFAULT 0
);
```

upstream 状态:Codex **CLI 已是最新 `0.142.4`**(= `npm view @openai/codex version`),issue 里「更新 CLI」一项已无可更;社区评论说桌面端的修复**还没真正修好**,所以**不能只靠 upstream**,必须本地加 workaround。

Flywheel 自己的 codex-homes(`~/.codex-*`)最大 4.2MB,没问题,本工具默认只盯主 `~/.codex`。

## Fix — `scripts/codex-log-guard.sh`

一个纯 bash + `sqlite3` 工具,子命令:

| 命令 | 写盘? | 说明 |
|------|------|------|
| `status` | 只读 | 打印文件大小 / `in_use` / `trigger_installed` / 阻断级别。任何时候安全。 |
| `install-trigger` | 写 | 安装幂等 SQLite trigger 拦截 TRACE 写入。**DB 被占用时拒绝。** |
| `vacuum` | 写 | `VACUUM` 回收死页。**DB 被占用时拒绝。** |
| `remediate` | 写 | 编排:`install-trigger` → `vacuum` → `status`。一条命令完成治理。 |
| `monitor` | 只读 | launchd 每天调用:记录大小到滚动日志;超阈值发 meta-alert(防回涨)。 |

### 核心 workaround — TRACE-拦截 trigger

```sql
CREATE TRIGGER codex_log_guard_block
BEFORE INSERT ON logs
WHEN NEW.level IN ('TRACE')
BEGIN
  SELECT RAISE(IGNORE);
END;
```

`RAISE(IGNORE)` 在 `BEFORE INSERT` 里**静默丢弃**该行、不报错、不影响其它级别。默认只拦 `TRACE`(保守,保留 INFO/DEBUG/WARN/ERROR);可经 `CODEX_LOG_GUARD_LEVELS` 调整(逗号分隔,如 `TRACE,DEBUG`)。这砍掉约 **77% 的写量**,是真正止磨损的一刀。

### 安全闸 — 绝不碰活动中的 DB

所有写操作(`install-trigger` / `vacuum` / `remediate`)执行前先用 `lsof` 检查 DB(含 `-wal` / `-shm`)是否被任何进程打开,被占用就**拒绝**——对活跃写的 SQLite 硬动会损坏文件(issue 的 ⚠️)。`lsof` 不可用时**fail-closed**(当作占用、拒绝),宁可不动也不冒险。

### 安全 — 日志可能含敏感内容

logs 可能含 token / 凭据。工具**绝不打印任何日志正文**(`feedback_log_body`)、**绝不把 DB 拷出本机**,只输出大小 / 计数 / 元数据。`monitor` 的告警正文只含文件路径 + 字节数 + 修复指令。

## 一次性治理线上 1.1GB(operator 步骤)

> ⚠️ 线上那个 1.1GB DB 现在被 3 个 codex 进程占用,工具会拒绝写。**必须先退出 Codex 桌面端。** 本仓只交付工具,**不在 Codex 运行时碰线上库**。

```bash
# 1. 退出 Codex 桌面端(完全 Quit,不是关窗)。确认无人占用:
lsof -- ~/.codex/logs_2.sqlite        # 应无输出
bash scripts/codex-log-guard.sh status  # in_use=no

# 2. 一条命令:装 trigger + VACUUM 回收 + 复查
bash scripts/codex-log-guard.sh remediate

# 3. 重开 Codex。之后 TRACE 不再写入、文件回到几十 MB 量级。
```

## 监控防回涨

```bash
cp scripts/launchd/com.flywheel.codex-log-guard.plist ~/Library/LaunchAgents/
# 按机器改 plist 里的脚本路径 / Hour / Minute,然后:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flywheel.codex-log-guard.plist
```

每天只读跑一次 `monitor`:把大小追加到 `~/Library/Logs/flywheel/codex-log-guard.log`,超阈值(默认 256MB,`CODEX_LOG_GUARD_THRESHOLD_BYTES`)就走 `scripts/meta-alert.sh`(桌面通知 + 文件 marker,去抖),提醒回去跑 `remediate`。

## Caveats

- trigger 是 DB 内对象,持久存在;但若 Codex 未来一次 schema 迁移**重建 `logs` 表**,trigger 会被一并删掉 → 增长会回来。`monitor` 的大小告警就是为了抓住这种回涨,届时重跑 `remediate` 即可。
- `_sqlx_migrations` 不追踪 trigger,所以装 trigger 不会和 Codex 的迁移冲突。
- 本工具治标(拦写 + 回收 + 监控),不依赖也不阻塞 upstream 真正修好后的卸载(`DROP TRIGGER codex_log_guard_block`)。

## Tests

`scripts/__tests__/codex-log-guard.test.sh` —— 全 hermetic:对临时 sqlite 跑,经 PATH/env 把 `lsof`(占用闸)/`osascript`/meta-alert 全 shim 掉,**绝不碰真 `~/.codex`**。覆盖:TRACE 被拦 / 非 TRACE 落库 / 占用时拒绝写 / 幂等 / `status` 字段 + 不漏正文 / `vacuum` 缩小 + 占用拒绝 / `monitor` 超阈值告警 + 低于阈值静默 + 不漏正文 + 只读不写。接进 `.github/workflows/ci.yml`(装 `sqlite3` 后跑)。
