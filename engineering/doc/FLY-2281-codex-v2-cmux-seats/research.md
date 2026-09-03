# FLY-2281 Codex v2 cmux 座位持续死行 — 调研
Issue: FLY-2281 (https://linear.app/geoforge3d/issue/FLY-2281/cmux-codex-v2-%E5%BA%A7%E4%BD%8Dflywheel-codex-infra-bot-lead-growth-mufasa-leadcmux)
日期: 2026-09-03
基于: exploration.md

## 结论

根因位于 production 配置读取与 cmux surface 命令生成之间：FLY-2264 的 cutover
runbook 把原生 tmux 3.7c binary 写入 `~/.flywheel/.env` 的
`FLYWHEEL_CMUX_ATTACH_TMUX_BIN`，但 launchd 启动的 watcher 不 source 该文件；
`managed_view_command_variants`、`_cmux_carrier_classify`、`build_attach_command` 与
`_cmux_attach_birth_records_uncached` 四个独立 consumer 又都只读取继承环境。因此
production watcher 为新 surface 生成的 helper 命令没有注入该绝对路径，helper 在 cmux
app 的旧 PATH 上解析到旧 tmux 客户端，无法稳定附着 3.7c server；即使只修前三处，
第四处仍会让 pinned `processTitle` 无法进入 birth/UUID authority join。

结果与现场证据闭合：严格 tmux view 仍活，但 tmux client 数为 0，cmux terminal surface
不可读，workspace receipt 停在 `prepared`。watcher 在后续 pass 把缺失 view 当作 dead
display 拆除；同一 pass 中 `title_source_authorized` 随即因严格 view 不存在而拒绝 title
stock，产生大量 `topology proof refused`。拒绝本身是安全护栏的正确行为，不是应放宽的
根因。

## 生产事实与代码事实

| 观察 | 证据 | 判断 |
| --- | --- | --- |
| 两个 Lead 的 tmux pane 存活 | `flywheel:@1/@2` 均为 `pane_dead=0` | roster source 仍有效 |
| 两个 view 已回到严格 A0B1 | owner 为 `flywheel`，marker 为 `0`，仅链接准确 window id | topology classifier 当前正确 |
| sidebar 红项一致 | sandbox-adapted 的真实 `_verify_sidebar_once` 对两行逐字给出 `rule=client-count observed=0`、`rule=render observed=unavailable`、`rule=receipt observed=prepared,count:1` | 失败在 attach/surface transaction，不在 Lead 进程 |
| render 失败已消歧 | 同一次 verifier 前置日志为 `cmux read-screen failed … Terminal surface not found`；只有 `named:1,mapped:1` 才会进入并产生 `rule=render` | `unavailable` 是已执行 probe 后失败，不是 row-shape 跳过 |
| watcher 反复 close/create | 日志先 `reconcile-*-view-dead`，再 `topology proof refused`，再创建 workspace | refusal 是 teardown 后的同轮派生症状 |
| cutover pin 已持久化 | `.env` 中为 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux` | 正确 client 路径已存在 |
| watcher 未加载 pin | launchd 环境只有 supervised 标记和 PATH；autostart 只补 PATH | pin 不会进入 shell 继承环境 |
| 四个 consumer 只读 inherited env | sync 脚本四处使用 `${FLYWHEEL_CMUX_ATTACH_TMUX_BIN:-}`，birth join 自带第二份 argv grammar | persisted pin 同时被 command 与 birth authority 绕过 |
| 已有 hardened env parser | `load_flywheel_env_value` 仅解析指定 key，继承值优先 | 无需 source 全量 `.env` |
| 已有默认标题恢复 | UUID-bound prepared test 覆盖 `Terminal 7` → 双标题 rename → committed | 不需扩大 title authority |
| 已有 birth adoption | exact generation/ref/UUID/surface/kind/target/token 后才接管 | helper 存活后可安全收敛 drift |
| 00:11 后最终自愈 | watcher 经 restored-adoption 关闭旧 `workspace:71/72`，新建 `98/99`；当前两行各有 1 client、render 可读、receipt committed | 当前绿来自破坏性重建后的新 episode，不消除下一次 cutover/rebuild 的 persisted-pin 断层 |

## 因果链

1. FLY-2264 正确持久化 `FLYWHEEL_CMUX_ATTACH_TMUX_BIN`，但 watcher 只继承 launchd
   环境，不读取 `.env`。
2. `build_attach_command` 看不到 pin，生成未携带
   `FLYWHEEL_CMUX_ATTACH_TMUX_BIN='<absolute>'` 的 helper command。
3. cmux surface 里的 helper 退回 `tmux` PATH lookup；旧 3.5a client 对 3.7c server
   曾在 cutover 现场返回 `server exited unexpectedly`。
4. helper 退出或重试不成功，strict view 的 `session_attached` 保持 0；现场 verifier 的
   `read-screen` 明确返回 `Terminal surface not found`。
5. title transaction 缺少可读 surface/birth proof，receipt 保持 `prepared`；若只修 command
   producer 而遗漏 birth join，pinned `processTitle` 仍会被解析成零 birth rows。verifier 正确
   报 `row-dead` / `receipt-dead`。
6. watcher 重建 episode 放大日志；拆 view 后的 `title stock topology proof refused`
   是 fail-closed 安全行为。

## 最小修复边界

新增一个内部 resolver，复用 `load_flywheel_env_value` 读取单一 key，保持优先级：

1. 当前进程显式继承的值；
2. `FLYWHEEL_ENV_FILE`（production 默认为 `~/.flywheel/.env`）中的值；
3. 两处均为空时保持历史未 pin 行为。

非空值必须满足绝对路径、不含单引号/换行/回车、且当前可执行；任何失败都 fail-closed。
四个相关 consumer 必须共享 resolver 与同一 pass snapshot：

- `build_attach_command`：把 pin 注入新建/修复 surface command；
- `managed_view_command_variants`：让 prepared/raw title recovery 接受同一 canonical
  command，同时保留历史无 pin/helper/direct-tmux variants 供滚动升级；
- `_cmux_carrier_classify`：让普通 process/carrier census 解析同一 canonical command；
- `_cmux_attach_birth_records_uncached`：把 persisted `processTitle` 纳入 exact
  ref/workspace UUID/surface UUID/kind/target/token birth join。

watcher 每个 additive/verify/oneshot pass 在任何 birth census、title reconcile 或 create
之前只读取并验证一次 pin；同一 pass 的所有 command substitutions 消费该 immutable
snapshot。pass 外的聚焦 helper 调用才按需读取一次。这样 `.env` 原子替换只在下一 pass
生效，不会让同一 create/guard transaction 分别看到旧、新路径，也不会在 per-title hot loop
反复 fork `awk`。

不修改 `title_source_authorized`、receipt mutation guards、UUID/birth ownership 规则、
verifier 判定或 production 配置内容。

## TDD seam 与反例

采用独立 shell test source 真实 `scripts/flywheel-cmux-sync.sh`，只用临时 `.env`、临时
可执行文件与环境变量构造 OS 边界。先证明当前代码在“继承值为空、`.env` 有有效 pin”时
生成未 pin 命令（RED），再实现 resolver。

必须覆盖：

- `.env` 中有效绝对 executable 会进入 `build_attach_command`；
- 同一命令同时被 variants 与 parser 识别，token 仍能往返；
- 只有 `.env` pin 时，session JSON 中 pinned `processTitle` 必须产出 exact birth row，
  保留 workspace UUID、surface UUID、kind、target 与 token；
- pass 内把 env file 从 A 原子替换为 B 后仍使用 A；下一次 prime 后统一使用 B；
- 显式继承值优先于 `.env`，便于受控测试和一次性 override；
- relative、不可执行、含单引号的值全部拒绝，且不退回未 pin command；
- 未配置值继续产生现有 helper command，保持兼容；
- helper boundary 在 hostile PATH 下仍调用注入的 binary；
- 现有 UUID prepared/default-title 与 birth-adoption tests 保持 green，证明修复没有
  扩大 workspace 接管权限。

## 风险与控制

- **测试被开发机真实 `.env` 污染**：修改的 harness 自带空临时 env file；其余聚焦 suites
  用 `FLYWHEEL_ENV_FILE=/dev/null` 运行。operator-fixture/manual-only 的 roster suite 不混入
  hermetic regression。
- **命令解析漂移**：生成器、variants、两个独立 classifier 共用同一个 resolver snapshot；
  两份 argv grammar 仍存在，但同一 pinned processTitle 必须由 executable birth-row test 锁住。
- **把配置错误降级成 PATH fallback**：非空无效值必须返回失败；只有真正未配置才能
  保持 legacy fallback。
- **错误配置扩大停摆/日志风暴**：invalid snapshot 对 view build/variants fail-closed，但普通
  Lead/legacy carrier parse 继续工作；以 process-local config episode latch 只记一条 WARN，
  并通过 `_alert_cmux_cleanup` 发一个 bounded/deduplicated alert，配置恢复后重新 armed。
- **误接管 founder workspace**：不改 title authorization；现有 UUID/birth/CAS guards
  原样保留并重跑相关 negative tests。
- **实现节点误碰运行态**：不重启 watcher、不写 production ledger、不关闭 workspace；
  合入部署后的真实 sidebar PASS 由独立 QA 执行。

## 可执行验收

实现阶段除新增测试外，至少重跑 attach command、view attach、prepared receipt、birth
adoption、dead-view rebuild、verifier 相关 hermetic shell suites。最终执行仓库规定的
`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，以及所有本任务新增的
`scripts/__tests__/*.test.sh`。
