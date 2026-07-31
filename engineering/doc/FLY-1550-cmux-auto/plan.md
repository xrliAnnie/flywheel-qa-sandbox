# Plan: v2 runner 显示对齐 — 环境全继承 + 共用主配置 + cmux 自动可见 — FLY-1550

**Issue**: FLY-1550(https://linear.app/xrli/issue/FLY-1550)
**Date**: 2026-07-30
**基于**: founder 直令版 issue 描述(2026-07-30 20:49)+ Lead 拍板的命名格式

## 背景(founder 三条直令,按优先级)

1. **不洗环境变量** — 删 `cleanRunnerEnvironment` 白名单(FLY-1502 切断旧系统残留的理由已失效),runner 直接继承完整环境;确须拦的旧变量用**具名黑名单**。
2. **不分家目录** — 删 per-activation `CLAUDE_CONFIG_DIR`(隔离凭据副本的唯一理由已在 FLY-1543 消失),runner 与 Lead 共用 `~/.claude` 主配置 → statusLine/主题/插件天生一致。
3. **cmux 自动可见** — 起 runner 自动建 workspace(workspace 名 + tab 名都设);整单结束(FLY-1544⑤)自动回收;兜底复用 `flywheel-cmux-sync.sh --watch`。

**贯穿红线**:v1 已有的行为一律直接用 v1 的东西,不为 v2 重做。

## 改动

### ① 环境(`packages/v2-host/src/tmux-runner-launcher.ts`)

- 删 `cleanRunnerEnvironment` 与 `/usr/bin/env -i` 整段;gate script 直接 `exec "$@"`(vendor 二进制 + args)。
- pane 环境 = tmux server/session 环境(含 tmux 自设的 TERM)+ `-e` 注入的 `FLYWHEEL_V2_*` —— 与 Lead pane 同源。
- **具名黑名单**(gate script 内 unset):`FLYWHEEL_BRIDGE_*` 前缀(旧控制面指针)+ `CLAUDE_CONFIG_DIR`(② 要求主配置,杜绝 stray 继承)。

### ② 配置目录(同文件 + `cli.ts` + `install-v2-host.sh`)

- 删:`claudeConfigDir` / `#prepareClaudeConfig` / `#linkClaudeCredentials` / `#preseedClaudeOnboarding`(含 onboarding lock 全套)/ `#mergeClaudeOnboarding` / injection-root 两个 assert 的 config-dir 用途;options 删 `injectionRoot` / `claudeCredentialsPath` / `onboardingLockTimeoutMs`。
- runtime config 精确键集合更新:顶层删 `injection_root`,launcher 删 `claude_credentials`;`install-v2-host.sh` 的 `RUNTIME_LAUNCHER_KEYS` 与模板同步。**部署注记:merge 后须重生成 runtime-config.json(重跑 installer),否则 host 拒启。**
- 共用主配置的可行性证据:凭据 = keychain/共享(FLY-1543);onboarding/trust = 主 `~/.claude.json` 已有(v1 runner 数年同模式)。**无一处需要 per-activation 隔离**(若 review 发现,PR body 逐条列)。

### ③ cmux(launcher + `dag_issue` envelope + `flywheel-cmux-sync.sh`)

**命名**(正式规范 = **FLY-1255 Locked Display Contract**,
`engineering/doc/FLY-1255-vendor-neutral-model-display/plan.md` §7/§8;Lead 撤回过一版临时格式,以 1255 为准):
window name = workspace title = tab title =
`<ISSUE>-<runner|phase>-<windowLabel>-<title-slug>`,例
`FLY-1550-runner-claude-Fable-runner-lead-config`、三段式节点 `FLY-1548-design-claude-Fable-…`。

- `runner-` 是固定 producer prefix(cmux reaper 的产权证明,不许改开放式 vendor allowlist);三段式节点 kind(design/implement/qa)保留 phase 前缀。
- `windowLabel` **直接复用** `renderRunnerModelDisplay()`(flywheel-config,纯函数):claude → `claude-Fable`,codex → `codex-G`(Plan B 短码,以函数现值为准);display 缺失回退逐字 `design/implement/qa/claude`。
- 组合用 v1 `buildWindowLabel()` + `sanitizeTmuxName()`(flywheel-core,50 字符预算,头部截断天然优先保 issue id + model)。
- **v2 窗口名因此天然落进 v1 `is_managed_runner_title` 既有命名空间,sync 脚本正则零扩展**。
- **标题入 spawn 上下文**:与 FLY-1547(`335cb684`)字节对齐——`IssueDagDescriptor.issueTitle`(可选)→ admission 写 `dag_issue:<issueId>` envelope(`issue_title`,trim 后非空才写)→ `launchContext` 无条件读 → `context.issueTitle`。旧 envelope 无此字段 → slug 回退 taskKind。

**建**(v1 机制,launcher 只发信号):launcher 起 session 成功后向 v1 事件文件 `/tmp/flywheel-cmux-events` 追加一行 `create|<session>|<window_id>|<window_name>`(与 tmux hooks 同一通道、同一格式;best-effort)→ 常驻 watcher ≤15s 内走 v1 完整 create 路径(ledger/竞态/自愈全复用)。60s additive 扫描兜底。

**回收**:整单结束 closure → `requestStop` → `stop()`:kill 前解析 window name,kill 后经 `requestCmuxPinClose`(flywheel-teamlead, FLY-685 v1 实现,新增 subpath export)写 close-request marker → watcher 无宽限期回收;`window-unlinked` 全局钩子 + 30s 清理梯作兜底。closure 本体零改动。

**sync 脚本扩围**(v2 session 纳入 v1 watcher 管辖,行为照抄):
- 6 处 session 闸门加 `v2-*`:`get_tmux_agent_windows` / `collect_agent_window_names_strict` / `register_session_hooks` / `cleanup_event_source_allowed` / `_drain_file` create / `is_pane_alive`。
- `is_managed_runner_title` **零改动**(1255 形状天然在既有 `runner|design|implement|qa` 命名空间内,orphan reaper / close-request 自动获得管辖权)。
- `create_workspace_for_window`:rename-workspace 成功后追加 `rename-tab`(founder:只改 workspace 名不够,tab 名会显示原始命令;v1/v2 同受益)。

## 测试

- launcher vitest:gate script 无 `env -i`/白名单、黑名单 unset 存在、无 CLAUDE_CONFIG_DIR;window name 格式(claude/codex、单/多节点、缺 title 回退);create 事件行字节格式;事件写失败不阻断 launch;stop() 写 close-request marker(session 缺席不写);荒废套件(credential symlink / onboarding preseed / config-dir 隔离)删除。
- runtime-config vitest:新精确键集合,旧形态拒收。
- admission/contract vitest:issueTitle 可选、入 envelope;launchContext 读出 + 回退。
- shell(test-cmux-sync.sh):v2- session 进 roster/hook/create/cleanup 闸门;1255 形状 v2 标题过 `is_managed_runner_title`(含反例哨兵防过宽);rename-tab 调用存在;attach 语法对 v2 标题字节不变。
- 真机验收(merge 后):新起一单 → cmux 自动出现、名字对、界面彩色、状态栏齐、整单结束自动消失(截图)。

## 部署序

1. merge → 生产 `git pull` + `pnpm -r build`。
2. `install-v2-host.sh --migrate-fly1550 <原参数>`:原子迁移现有 runtime-config.json(jq 删除 `injection_root` + `launcher.claude_credentials`,先写 temp 再落盘,随后同一 exact-key 闸门 + 真 host parser 校验)→ 重启 v2 host。推荐先跑 `--migrate-fly1550 --validate-only`(完成迁移并验证,但不触碰 launchd),再正常重装。
3. 重启 cmux watcher(launchd `com.flywheel.cmux-watcher`)使脚本扩围生效。
