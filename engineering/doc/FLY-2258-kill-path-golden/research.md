# FLY-2258 kill-path golden 对账 — 调研
Issue: FLY-2258 (https://linear.app/geoforge3d/issue/FLY-2258/hotfix-main-红-kill-path-inventory-golden-漏-fly-2240-的-4-条-qa-only)
日期: 2026-09-01
基于: exploration.md

## 机制审计

`scanKillPathInventory()` 递归扫描 `packages/` 与 `scripts/` 下的受支持源码后缀，
排除 `node_modules`、`dist` 与 `.git`。每个命中先规范化行内空白，再根据
`path + code + occurrence` 生成唯一 key，最后按 key 做 `localeCompare` 排序。
因此 fixture 的正确生成源是 scanner 的完整返回值，不需要也不应手工插入或排序。

分类函数的第一条规则覆盖 `test`、`tests`、`__tests__` 及 qa/test/e2e 等测试路径。
这条规则先于 `kill -0` 的 `signal-0-probe` 规则执行，所以测试脚本中的同行双探针仍是
一个 `qa-only` inventory entry，和 issue 的验收一致。

## 当前基线数据

| 分类 | fixture 552 | scan 556 | 变化 |
|---|---:|---:|---:|
| `qa-only` | 389 | 393 | +4 |
| `runner-affecting-mutation` | 16 | 16 | 0 |
| `signal-0-probe` | 63 | 63 | 0 |
| `service-mutation` | 2 | 2 | 0 |
| `out-of-scope` | 82 | 82 | 0 |

独立比较 `classification !== "qa-only"` 的有序数组得到：更新前后均为 163 条，
JSON 字节级比较相等。

## 缺失的四条

1. `claude-profile.test.ts:process.kill(-callerGroup.pid, "SIGKILL");#1`
2. `claude-profile.test.ts:process.kill(-callerGroup.pid, "SIGKILL");#2`
3. `claude-profile.test.ts:process.kill(-callerGroup.pid, "SIGKILL");#3`
4. `restart-account-switch-runtime-preflight.test.sh:if kill -0 "$LEADER_PID" ...#1`

四条的 `classification` 都是 `qa-only`。前三条来自同一规范化代码行的三次出现；
第四条将两个 `kill -0` 写在同一源码行，因此 inventory 按行只记录一次。

## 方案选择

采用 scanner 全量返回值覆盖 golden fixture。拒绝以下替代方案：

- 不改 scanner 或 classifier：当前分类已符合预期，改逻辑会扩大范围。
- 不手工只拼四个 JSON 对象：容易破坏 scanner 的确定性排序或遗漏后续格式细节。
- 不修改 FLY-2240 测试代码：这些命中是合法测试清理/探针，不是缺陷。

## 验证策略

1. 使用现有失败测试作为 RED。
2. 将 scanner 输出序列化为 tab 缩进、尾随换行的 fixture，作为最小 GREEN 改动。
3. 对基线 fixture 与新 fixture 做独立 delta 审计：新增恰好四条，零删除，新增均
   `qa-only`，所有非 `qa-only` entry 完全相等。
4. 执行目标测试、仓库固定 gates 与全部 `scripts/__tests__/*.test.sh`。
