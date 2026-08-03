# FLY-1605 cmux workspace 名字显示成原始命令 — 调研

Issue: FLY-1605 (https://linear.app/geoforge3d/issue/FLY-1605/cmuxfounder-直令-workspace-名字显示成原始命令1621-两条-spawn-路径缺-rename-调用-刷新现存名字)
日期: 2026-08-02
基于: exploration.md

## 1. 代码路径地图(实证,非推断)

### 1.1 唯一的 workspace create/rename 收口

`scripts/flywheel-cmux-sync.sh` → `create_workspace_for_window(source_session, window_id, window_name)`
(`flywheel-cmux-sync.sh:4764`)。生产代码全仓 grep 只有此处调用 `cmux new-workspace`
(另一处在测试 `scripts/__tests__/fly1364-live-e2e.test.sh`)。调用点 4 个,全在本脚本内:
`drain_events`(事件驱动,`:5640`)与 `sync_additive` 等 sweep(`:5768/:5826/:6059`)。

新建成功后的命名序列(FLY-1550 后,strict/ledgered 路径 `:4967-5035`):

```
new-workspace --command <attach_cmd>
→ _ledger_upsert prepared            ← 根因 A 的断点:lease 自断言失败 → 整体回滚
→ rename-workspace --workspace <ref> <window_name>
→ readback 确认
→ rename-tab --workspace <ref> <window_name>
→ _ledger_upsert committed
```

legacy(非 strict)路径 `:5036-5045`:rename-workspace 成功后 rename-tab,best-effort。

### 1.2 spawn 侧从不直接建 workspace

- v2 runner/design 节点:`packages/v2-host/src/tmux-runner-launcher.ts` 的
  `#announceCmuxCreate`(`:933`)只往 `CMUX_EVENT_FILE` 追加 `create|session|window|name`
  一行;watcher 15s 内 drain 并走完整 create 路径。
- Lead(claude-lead.sh / restart-services 一族):只建 tmux 窗口;`restart-services.sh` 的
  `trigger_cmux_refresh`(`:1251`)只做 `--refresh`(tmux-only)+ `refresh-surfaces`,
  不建 workspace。Lead workspace 同样由 watcher 的 additive sweep 建。

**结论:issue 假设的「两条缺 rename 的 spawn 路径」不存在;rename 调用在收口里都有,坏的是收口
上游的 lease 前置条件(根因 A)和存量刷新缺失(根因 B)。**

### 1.3 lease 机制与 TZ 脆弱点

- lease 目录 `/tmp/flywheel-cmux-watcher.lock`,owner 文件 `pid|incarnation|mode|nonce`
  (`:6341` `_create_mutator_lease_dir`)。
- incarnation = `ps -o lstart= -p <pid>`(`_process_incarnation`,`:6126`)——
  **本地时区渲染的 wall-clock 字符串**。测试 seam:`FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE`。
- 自断言 `assert_or_reuse_owned_lease`(`:6533`):
  1. 读 owner 文件,比对 `OWNER_PID == $$`、`OWNER_INCARNATION == $MUTATOR_LEASE_INCARNATION`、
     `OWNER_NONCE == $MUTATOR_LEASE_NONCE`(后两者为进程内存变量);
  2. 再跑 `_owner_process_matches`(`:6155`):**重新渲染** `ps lstart` 与 owner 文件比对
     —— 此步是 TZ 脆弱点,时区/时钟一变即失败,且对「自己」这个 case 没有安全增量
     (nonce 随机、只在本进程内存,文件三元组全等已证明文件是本进程写的;`$$` 进程正在执行,
     不存在 PID 复用问题)。
- 所有 ledger 写入走 `_ledger_transaction`(`:3690`),第一步就是该自断言 → 失败即
  `ledger upsert refused`。
- 跨进程使用渲染比对的位置(这些**有**防 PID 复用的实际作用,须保留但渲染要稳定):
  `acquire_mutator_lease`(`:6450`,别人 lease 是否活)、`_classify_mutator_lease_for_rebuild`
  (`:6271`)、`probe_mutator_lease`(`:6552`)、`_pid_is_watcher`(`:6616`)。

## 2. 生产时间线(日志 + 文件系统证据)

| 时刻(MDT) | 事件 | 证据 |
|---|---|---|
| 08-01 11:45 | watcher(pid 1752)启动,lease 建立;当时系统时区 PDT,incarnation 渲染 `Sat Aug 1 10:45:06 2026` | `/tmp/flywheel-cmux-watcher.lock/owner`;`ps -o lstart -p 1752` 现渲染 `11:45:06`(同一时刻,新旧时区差 1h) |
| 08-01 下午 | LEARN-219 / FLY-1597 workspace 正常建立(双面命名齐全) | 二者是仅有的 panel.customTitle 已设者;create 各只 2 次 |
| 08-02 02:43:49 | **首次** `ledger upsert refused`(时区已切到 MDT) | watcher log `:6504`;与 FLY-1602 记录的通宵事故同窗 |
| 08-02 02:43 起 | create→rollback 死循环:FLY-1603×83、tidal-echo-content×74、tidal-echo-cos×73、mufasa×43、FLY-1604×39、eng-lead×30、FLY-1605×10、FLY-1602×8;累计 183 次 refused | log 统计 |
| 08-02 ~04:43-04:48 | restart-services 重启全部 Lead(FLY-1602 事故处置) | `~/.flywheel/logs/lead-*-startup.log` mtime |
| 08-02 早 | issue 快照:21 workspace、16 个 panel/tab title = 原始命令、3 个正确 | 与当前 session JSON panel 层完全吻合 |
| 08-02 ~10:13-10:23 | FLY-1602 design workspace 循环;workspace:62 回滚失败留孤儿;**人工 rename-workspace 后循环停止**(存在性检查按 title 命中) | log `:18445-18758`;workspace:62 现名正确、tab 名仍 raw |
| 08-02 12:1x | 现状:25 个 workspace,6 个 raw 标题 design 孤儿重复(116/117/175/176/177/178)+ 循环仍在跑 | `cmux --json list-workspaces` |

## 3. cmux CLI 能力(本机 build 实测)

| 需求 | 命令 | 备注 |
|---|---|---|
| 读 workspace 标题(=侧栏行) | `cmux --json list-workspaces` | 字段 `ref`/`title`/`index`/`pinned`/`selected`;title = customTitle,未设时回落显示原始命令 |
| 读 tab/surface 标题(=顶栏+窗口标题) | `cmux --json list-pane-surfaces --workspace <ref>` | `surfaces[].title`;这是幂等比对的读路径 |
| 改 workspace 标题 | `cmux rename-workspace --workspace <ref> <title>` | 必须显式 `--workspace`(历史踩坑:缺省会改到当前选中者) |
| 改 tab 标题 | `cmux rename-tab --workspace <ref> <title>` | 单 surface workspace 下无需 `--tab` |

## 4. 真机判定性实验(本 session 实施,生产 cmux)

### Spike 1 — rename-tab 生效面
`cmux rename-tab --workspace workspace:15 "flywheel-flywheel-eng-lead"`
→ `list-pane-surfaces` readback 立即返回新名;5s 后 session JSON `panels[0].customTitle`
持久化为新名。证明:tab 面可写、readback 可用、对 legacy grouped Lead workspace 同样生效
(FLY-169 教训「rename 意图可能 no-op」在此路径不成立)。

### Spike 2 — 侧栏绑定判定
对无名孤儿 `workspace:117` 只执行 `rename-workspace`(不动 tab)→ **侧栏行立即变为可读名**
(截屏留证),`list-pane-surfaces` 的 surface title 仍是原始命令。
判定:**侧栏行 = workspace title;顶部 tab 条 + macOS 窗口标题 = surface/tab title**。
两面独立,必须都设。

### 附带实证
- adopt-by-rename 止循环:workspace:62(FLY-1602)、eng-lead、tidal-echo×2、mufasa 均在人工
  rename 后 create 循环终止 — 即「把无名 workspace 改成窗口名」能让存在性检查命中、根治重复创建。
- cmux 的 macOS 窗口标题(`kCGWindowName`)显示当前选中 workspace 的 surface title —
  同一病灶的第三个可见面,rename-tab 一并治愈。

## 5. 命名规范与单一真相源

tmux 窗口名**已经是**规范名(FLY-1255/FLY-272 定型):

```
flywheel|@157|flywheel-flywheel-eng-lead            ← Lead:<project>-<leadId>
runner-flywheel|@164|FLY-1605-design-claude-Fable-cmux-founder-workspac  ← issue 节点:FLY-XXX-<node>-<backend>-<slug>
```

`get_tmux_agent_windows`(`:506`)已枚举全部(flywheel 会话 Lead 窗口 + runner-*/v2-* 会话),
并做 v2 身份校验(FLY-1550 HIGH-1)。reconcile 以窗口名为期望值,不需要新的命名逻辑;
raw workspace 的归属通过其 surface title 内的 attach 目标 `=cmux-<window_name>` 反解。

## 6. 测试基建

- `scripts/test-cmux-sync.sh`:source 脚本(main dispatcher 有 guard)+ 用 bash 函数覆盖
  `tmux`/`cmux` 的 shim 模式;**必须 /bin/bash 3.2**(生产 macOS 系统 bash;文件头有版本闸)。
- 新测试按现行命名放 `scripts/__tests__/fly1605-*.test.sh`(CI 会跑 `scripts/__tests__/*.test.sh`)。
- lease 侧已有 seam:`FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE` 可在测试中模拟
  「acquire 后渲染漂移」(acquire 时设值 X,断言前改为 Y)——旧代码自断言失败、新代码应通过,
  即变异判据的正向;反向(去掉修复)同一夹具变红。

## 7. 风险与负载注意

- 每 tick 全量读 25 个 workspace 的 surface title = 25 次 socket IPC;参照 FLY-1601
  (per-tick 负载教训),reconcile 应挂 tick%4(与 sync_additive 同拍)且只对「能映射回自家窗口」
  的 workspace 读 surface,稳态时全部命中即零 mutation。
- reconcile 绝不能碰无法映射回自家 tmux 窗口的 workspace(founder 私人 tab 保护)。
- 部署时序:watcher 是长驻 bash 进程且经 fd 持有脚本文件,**改脚本必须重启 watcher 才生效**,
  且重启会重建 lease(顺带清除当前失效态)。
