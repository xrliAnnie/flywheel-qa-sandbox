# FLY-2427 Ship gate 死卡收敛 — CLI 消费者 sweep
Issue: FLY-2427 (https://linear.app/geoforge3d/issue/FLY-2427/批准通路-lead-对-approve-to-ship-gate-的非批准回复被接受并消耗掉这道门却不铸-source-event)
日期: 2026-09-07
基于: plan.md

扫描时间：`2026-09-07T19:42:17Z`。关键词覆盖 `flywheel-comm respond`、
`approve_to_ship`/`workflow-gate` 邻接调用、`runner-gate-response` 与
`--kickback`。

| root | 文件数 | 结果与处置 |
|---|---:|---|
| 主仓 `scripts/` + `packages/` | 3,735 | 找到并同步 5 类真实 Lead 指令消费者：shared gate formatter、ambiguous founder handoff、runner messaging/patrol rules、department Lead rules、CoS Lead rules。现在都明确 ship gate 只能让 founder 在 Discord ship 卡上操作；普通非 ship question 继续用 `respond`。endpoint 定义/测试作为 server-side 后卫保留；`--kickback` 参数只为解析兼容且 help 明示不可越权。 |
| `xrliAnnie/claude-plugins-official` fork `external_plugins/` | 60 | 从远端 `main@d0080393ee6672854920f957923adad8d3314bc5` clone 到临时 sparse checkout 后扫描；0 引用。 |
| 本机 `~/.claude/plugins/cache/*/` | 20,340 | 全部可读缓存扫描；0 引用。 |

主仓同步完成后又执行针对旧危险文案的负扫描：

```bash
rg -n -i \
  -e 'Reply via: flywheel-comm respond --db .*--bridge-url' \
  -e 'respond --db .*--bridge-url.*approved' \
  -e 'To reject / request changes, answer with plain-text feedback' \
  scripts packages --glob '!**/dist/**' --glob '!**/node_modules/**'
```

结果 `exit=1`、0 行；即不再有运行时/规则文案继续教 Lead 走旧 ship respond
通路。剩余 `respond` 命中均为普通 question 合同、明确的禁止说明、兼容 help、
server-side 防御端点或测试。
