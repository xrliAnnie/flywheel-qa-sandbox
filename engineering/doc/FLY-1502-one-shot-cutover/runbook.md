# FLY-1502 一次性切换 — 切换手册
Issue: FLY-1502
日期: 2026-07-29
基于: plan.md

## 0. 窗口合同

这是一次 founder 在场的 stop-the-world 切换，不是部署后自动迁移。预计全 fleet
Discord Lead 停用 30–60 分钟。Implement PR 只交付工具和围栏；本手册中的生产命令必须在
该 PR 合并、批次 2 全部完成、所有 FLY pipeline 已停稳之后执行。

角色固定:

- Founder：逐步观察证据，输入 `heldStart` 与 `finalGo` 的精确口令，最终只做 GO/NO-GO。
- Tadashi：主持窗口、转译证据、确认没有遗漏的项目/Lead/旧 writer。
- Implement runner：现场执行唯一的 `flywheel-v2-cutover` 命令并保存 ledger/evidence。

红线:

- 不允许无人值守，不允许生产 `--yes`。
- 不允许旧/新双轨。步骤 3 后旧入口只可用于步骤 7 的受控实弹失败测试。
- `main@37bcb8e2` 是整体回退锚点；不得挑拣式回退。
- 最终 GO 前新 host、thin Discord ingress、scheduler 只能处于 held；Lead 不得注册。
- 最终 GO 后不再做 T1 数据回滚；只做 forward repair。T1 仅在
  `external_effect_intent_count=0` 时可用。

窗口预告口径:

> Flywheel 将进行一次 30–60 分钟的控制面停用切换。期间所有项目的 Discord Lead、
> runner 派发和自动巡逻暂停；消息保留在 Discord，恢复后由 v2 持久游标补取。

## 1. 窗口前准备

### 1.1 发布与冻结

1. 确认批次 2 issue 全部完成，FLY-1502 PR 已由项目 ship workflow 合并。
2. 记录 `git rev-parse main`、构建产物 SHA、Node/pnpm/gh 版本。
3. 清空正在执行的 Design/Implement/QA pipeline；本次切换自身也必须已经
   parked/completed。
4. 运行 GitHub lane 探针，必须证明 actor 非 admin、无 bypass，且 main 有 required
   checks：

   ```bash
   flywheel-v2 probe-github-lane \
     --repo <owner/repo> \
     --branch main \
     --output <absolute-evidence-dir>/github-lane.json
   ```

5. 枚举而不是猜测所有生产输入。至少包括：

   - `~/.flywheel/comm/**/comm.db` 及 `-wal/-shm`
   - `~/.flywheel/inbox-structured/`
   - 每个 Codex Lead 的 `codex-lead/<id>/journal.db` 及 `-wal/-shm`
   - 旧 Bridge/Lead/runner/patrol 的 launchd label 与 plist
   - tmux/cmux 会话、wrapper、旧 credential、相关环境变量

测试项目和历史目录不能因为名字像测试而自动排除；必须逐项判定是否仍可被生产入口写入。

### 1.2 生产 target manifest 复核

manifest 是唯一作用域权威。加载器会拒绝：

- 相对路径、重复 DB authority 路径、显式 symlink fence；
- 旧写路径未被 `tombstonePaths` 覆盖；
- fence 与 v2 DB/ledger/evidence/plist/tmux namespace 相交或互为祖先；
- launchd label 没有对应 stop command；
- 缺 stop、旧 credential 探针、实弹 writer、rollback command；
- rehearsal 使用生产路径、生产 label、默认 tmux socket 或非隔离 cmux target。

生产 namespace 建议固定为 `~/.flywheel/v2/`；旧 `~/.flywheel/comm/`、
`~/.flywheel/inbox-structured/` 和旧 team 目录全部在 fence 集内。v2 team/session
名称统一为 `v2-<leadId>`，不得复用旧 team 名。

所有会改变 launchd/tmux/进程状态的 `stopCommands` 与 `startCommands` 都必须写成
`{"apply":[...],"verify":[...]}`。`verify` 必须是只读探针，只在目标状态完整成立时
返回 0；`apply` 必须能在 `verify` 明确返回非 0 后安全重入。ledger 在 apply 前落
`apply` 子行，崩溃恢复先跑 `verify`：已生效则直接收敛到 complete，未生效才重跑
`apply`。严禁用恒真命令充当生产 verify，否则 manifest 预检虽能解析，窗口证据无效。

`legacy.authoritativeLiveLeadIds` 必须在停 Bridge 前从 loopback
`/api/fleet/snapshot` 的项目 Lead registry 生成并由 Tadashi 逐项复核。它是步骤⑤
判断“存续 Lead”的权威集合；`comm.db.sessions` 只能补充存续证据，不能证明 Lead
终结。集合漏项会把相关未读行送入 `manual` 并使窗口 NO-GO，不会静默进 dead letter。

`legacy.runnerSessionDatabase` 必须显式指向停机前的 `~/.flywheel/teamlead.db`。
其 `sessions(execution_id,status,session_role)` 是 Runner 存续/终结的权威登记表；
`lead_id` 不存在也不需要。该路径不得同时放进 `commDatabases`（后者是 payload schema），
必须被 `tombstonePaths` 覆盖，并参与步骤③ lsof、步骤④ WAL-safe backup 和步骤⑥归档。
识别到的 live/terminal execution IDs、权威库路径与未知 status 计数会写进
`migration-plan.json.runnerLiveness`。未知 status 或查无 execution ID 不推断终结，
继续进入 `manual` 硬闸；即使 Runner 仍 live，也不满足“存续 Lead 才可迁移”的规则，
相关业务行仍须逐行人工裁定。权威 registry 存在时，`comm.db.sessions` 中同名或缺席的
Runner 状态一律不能覆盖它；legacy `approved` 等语义歧义状态同样保守进入 `manual`。

`startCommands` 顺序固定：

1. `host`: `flywheel-v2-host`，open-existing-only；
2. `bridge`: `flywheel-v2-discord-ingress`，唯一 Discord 入站写点；
3. `scheduler`: `flywheel-v2-scheduler`；
4. `leads`: final GO 后才启动，每个会话启动时再 register/reattach。

host 必须使用唯一 launchd label `com.flywheel.v2-engine`，不得直接后台运行或另设
fallback supervisor。窗口前先生成 0600 的 host secret 与 0600 runtime config：

```json
{
  "v": 1,
  "dispatch_interval_ms": 1000,
  "lock_root": "/Users/<operator>/.flywheel/v2/runtime-locks",
  "injection_root": "/Users/<operator>/.flywheel/v2/inj",
  "launcher": {
    "kind": "tmux",
    "tmux_bin": "/absolute/path/to/tmux",
    "claude_bin": "/absolute/path/to/claude",
    "claude_credentials": "/Users/<operator>/.flywheel/v2/claude-credentials.json",
    "codex_bin": "/absolute/path/to/codex",
    "client_cli": "/absolute/path/to/packages/v2-cli/dist/cli.js",
    "release_root": "/Users/<operator>/.flywheel/v2/runner-release",
    "state_root": "/Users/<operator>/.flywheel/v2/runner-state"
  },
  "git_bin": "/usr/bin/git",
  "gh_bin": "/absolute/path/to/gh"
}
```

生产必须选内置 `kind=tmux` launcher；它只支持 Claude/Codex，使用全新的 `v2-*`
session namespace 和注册闸，且不加载会写 `comm.db` 的旧 Bridge/adapter。外置
`kind=command` 的严格 JSON seam 仍保留给后续替换，但不是本次生产上电路径。
`injection_root/codex/<24-hex>.sock` 的完整 UTF-8 路径必须不超过本机 Unix socket
上限；launcher 会在开 tmux 前 fail closed。窗口前用最终绝对路径做一次 Codex
socket preflight，路径过长时缩短 `injection_root`，不得用 symlink 绕过。
`state_root` 与 `release_root` 必须位于持久 0700 namespace；每个 session 的绑定、
真实 Codex thread id 与 release 文件均为 0600，host 重启依赖这些事实恢复，不能放在
会自动清理的临时目录。

launcher 通过 `/usr/bin/env -i` 只继承 HOME/PATH/TMPDIR/locale/CODEX_HOME 和明确
列出的 v2 变量，不把旧 Bridge、comm.db 或第三方 secret 带进 runner。窗口前分别用
最终 HOME/CODEX_HOME/Claude config 跑无副作用认证探针；认证缺失是 NO-GO，不允许把
token 复制进 runtime config。

### `claude_credentials` —— 必填，且**已有安装升级时必须先补**（FLY-1503）

`launcher.claude_credentials` 指向 operator 一次性提供的 Claude
`.credentials.json`（regular file、非 symlink、0600 或 0400、合法 JSON）。
host 用**精确键集**校验 launcher 段，所以这个字段缺失时 host 会在
**监听 socket 之前**抛 `runtime launcher has an invalid shape`，
launchd KeepAlive 会空转重启 —— 引擎当场下线。

为什么必填：FLY-1503 把 Claude config root 改成 per-activation，
新目录里没有 `.credentials.json`，而 runner 是 `/usr/bin/env -i` + 白名单启动的，
白名单里既没有 `CLAUDE_CODE_OAUTH_TOKEN` 也没有 `ANTHROPIC_API_KEY`。
不配这个字段，每次 spawn 都会停在交互式登录屏。

**已有安装的升级步骤（先改配置，再重启，顺序不能反）**：

```bash
# 1. 准备凭据源（若尚未单独存放）
install -m 600 ~/.claude/.credentials.json ~/.flywheel/v2/claude-credentials.json

# 2. 补字段（原子写，保持 0600）
jq --arg p "$HOME/.flywheel/v2/claude-credentials.json" \
   '.launcher.claude_credentials = $p' \
   ~/.flywheel/v2/runtime-config.json > ~/.flywheel/v2/runtime-config.json.next
chmod 600 ~/.flywheel/v2/runtime-config.json.next
mv ~/.flywheel/v2/runtime-config.json.next ~/.flywheel/v2/runtime-config.json

# 3. 先验证新配置能被真正解析（不要直接重启去试）
#    --validate-only 会跑 host 自己的 parseRuntimeConfig，并校验 claude_credentials
#    源文件；它在碰 launchd 之前退出，所以不会动线上服务。
#    window / epoch / host-epoch 是脚本必填项，用当前线上值填即可（校验不依赖它们，
#    但缺了脚本会直接退出 2）。
scripts/install-v2-host.sh \
  --window "$WINDOW_ID" --epoch "$EPOCH" --host-epoch "$HOST_EPOCH" \
  --runtime-config ~/.flywheel/v2/runtime-config.json \
  --validate-only
echo "validate exit=$?"   # 必须为 0

# 4. 只有第 3 步 exit 0 才重启 host
launchctl kickstart -k gui/$(id -u)/com.flywheel.v2-engine

# 5. 重启后确认引擎真的在调度，而不是「活着但没武装」。
#    coordinator 必须是 armed；status=degraded 表示 host 起来了但调度没起来。
node "$CLIENT_CLI" health \
  --socket ~/.flywheel/v2/host.sock --secret ~/.flywheel/v2/host.secret
```

安装器的前置校验现在也检查这个字段，所以 `--validate-only` 能在重启前抓到缺失。

第 5 步不是形式：host 在 socket 已监听之后才做 runner 同步，同步失败以前会留下
「进程活着、health 绿、但什么都不调度」的形态（FLY-1503 R6 HIGH-1）。现在同步失败
是致命的（关闭监听并非零退出，launchd 会重启），而 health 也会在 coordinator 未武装
时回 `status=degraded` / `coordinator=not_armed` —— 所以重启后看一眼 health 的
`coordinator` 字段就能区分「真的在跑」和「只是活着」。

role authority 不来自 task payload：
host 每次 spawn 都从项目 `.flywheel/config.yaml` 的 exact logical agent key 解析
`agent_file`，记录 canonical source path + SHA-256 后才调用 launcher；缺失、歧义、
symlink 或同 attempt 内容漂移均 fail closed。
runner 注册后 DAG 会在同一权威链中自动产生 canonical task-assignment mailbox
消息；host 按 attach → activate → push 的顺序投递。Codex 投递使用稳定
`clientUserMessageId=message_uid`，响应丢失时先 `thread/read` 对账再决定是否重发，
不得靠“没有 RPC 响应”推断 absent。

8a 用唯一安装入口启动 held host：

```bash
scripts/install-v2-host.sh \
  --window <window-id> --epoch <epoch> --host-epoch <host-epoch> \
  --db <abs-v2-db> --marker <abs-marker> \
  --authority <abs-authority> --armed <abs-armed> \
  --socket <abs-socket> --secret <abs-0600-secret> \
  --session-proof-root <abs-proof-root> \
  --runtime-config <abs-0600-runtime-config>
```

安装器只接受 launchd，验证 service loaded，并通过 secret 对 Unix socket 做一次
authenticated health；cutover authority 下的 `held` 健康也算 8a PASS，但不代表
final GO。

### 1.3 隔离预演

预演 manifest 必须使用独立 HOME、`com.flywheel-rehearsal.*` labels、独立 tmux socket
和 cmux target。预演走生产相同的九步代码，且真启动 namespaced legacy writer 与 v2
服务：

```bash
pnpm --dir packages/v2-cutover build
scripts/rehearse-v2-cutover.sh /absolute/path/rehearsal-target.json
```

脚本会在前后采集生产 launchd label/disabled 集、tmux session 和生产树元数据；任何
diff 都使预演 NO-GO。只有脚本写出的
`production_unchanged=true + matching window_id/epoch` 证据可解锁生产步骤 1。
若 `launchctl list` 无法枚举生产 labels，脚本会在创建 cutover ledger 前明确
NO-GO；不得把空输出当作“没有旧服务”。

> **FLY-1503 后续闸（2026-07-29 QA 发现）**：当前通用 wrapper 对整棵
> `productionHomeRoot` 逐文件 `stat`，在真实 `~/.flywheel` 上无时间上界，而且
> 采样发生在旧 writer 停止前，会把无关生产活写混入 diff。FLY-1502 的真数据 QA
> 改用 `scripts/__tests__/qa-fly1502-real-rehearsal.sh` 对 manifest 可触及路径与
> launchd/tmux 控制面做归属证据；在 FLY-1503 完成 bounded attribution 闸并经 Lead
> 复核前，通用 wrapper 产出的 `production_unchanged` 不得单独作为生产上电依据。
> 这条记录不放宽步骤①；缺可归属证据仍是 NO-GO。

## 2. 九步操作卡

统一入口：

```bash
flywheel-v2-cutover run --target /absolute/path/production-target.json --step N
```

每步完成后读取 `<ledgerDir>/ledger.jsonl` 与 `<evidenceDir>/step-N.json`。ledger 是
hash-chain append-only，并为 stop/start/archive 等副作用记录
`intent → apply → verify → complete`；崩溃后重跑同一步，不手工跳账。

### ① 预演

动作：校验窗口/epoch 完全匹配且预演证明生产控制面零变化。

PASS：`step-1.json` 为 pass，rehearsal evidence 包含相同 window/epoch 与
`production_unchanged=true`。

NO-GO：无证据、旧窗口证据、epoch 不同、生产快照有 diff。

回退：无生产变化，修复预演后重跑。

### ② 冻结

动作：停止新 admission；创建独占 staging DB；写 cutover intent；枚举双源未读与
Codex journal 未完结义务。

PASS：

- `lead_inbox carrier=external` delivery/receipt obligation 为 0；
- journal 的 accepted/dispatching/dispatched/model-completed/output-pending 为 0；
- staging 只在隔离目标创建，迁移 manifest 精确止于 0009；
- 记录 service/filesystem 基线，且此时尚未停进程。

NO-GO：任何不可 drain 行、dead-letter 歧义、未知 schema 或 populated-0008 升级。

回退：取消冻结，保持旧系统；不得进入步骤 3。

### ③ 停全部旧写者

动作：执行 manifest 的每个 stop/bootout/disable command；验证 Bridge、Lead、
runner CLI、scheduler/patrol 的 PID/tmux/cmux/daemon 全退出；用 lsof 检查旧 DB、
WAL、SHM、JSON inbox 零 fd。

PASS：`check-1-writers.json` 零匹配，lsof 零持有者。

NO-GO：任一旧 writer、会话、自动 KeepAlive 或 fd 仍存在。

回退：在尚未迁移时可按 manifest rollback commands 恢复旧服务并取消窗口。

### ④ 一致快照

动作：所有 SQLite（含独立的 Runner session registry）先
`wal_checkpoint(TRUNCATE)`，再走 SQLite backup API，`integrity_check=ok` 后
chmod 0400；JSON/journal 做同窗口快照。

PASS：每个 legacy DB、journal、JSON root 都有只读快照和 digest。

NO-GO：checkpoint busy、log/checkpointed 不等、integrity 失败或源集合变化。

回退：保持停机，排除持有者后重做；不要复制活 WAL。

### ⑤ 迁移

动作：按 canonical key 对账迁移到 staging，再原子 promote，最后发布 migration
complete marker。三个域必须分别守恒：

- A：comm messages + `carrier=inbox` 未读；
- B：external delivery/receipt obligations 与 journal drain；
- C：JSON inbox + sidecar。

Discord key 是 message id；其他 vendor row 使用稳定来源 hash。冲突或 manual 行不得
自动吞并。

`migration-plan.json` 必须携带本窗口 `windowId` 与 epoch。人工裁定入口会逐字段验证
canonical row、守恒式、域 B 与 GO 值，并要求窗口/epoch 与 target 完全一致；畸形或
被替换的证据不能写入 authority ledger。

第一次步骤⑤ NO-GO 会先原子写出 `evidence/migration-plan.json`。若 F1-b 权威源接入后
仍有畸形/截断收件人，Founder 与 Tadashi 必须逐行查看
`decisions[] | select(.disposition=="manual")`，并对 canonical key、payload digest、
原始 reason 和原始消息证据作出明确裁定。唯一入口是：

```bash
node packages/v2-cutover/dist/cli.js adjudicate-manual \
  --target "$TARGET" \
  --source-kind legacy-comm \
  --source-id 'project/message-id' \
  --payload-digest '<64-char-lowercase-sha256>' \
  --disposition dead \
  --reason 'Founder verified this truncated Runner ID is terminal'
```

`--disposition` 只能是 `migrate|dead|tombstone`；每次命令只绑定一行。记录按
window/epoch/source key/digest/original reason 写入步骤⑤ hash-chain ledger 的
`intent→apply→verify→complete` primitive。同一 payload 重放幂等，不同理由或结果
冲突即 fail loud。只裁一部分时重跑步骤⑤仍是 NO-GO；所有 manual 行有 complete 裁定后，
重建 plan 才会重算守恒并继续。严禁脚本批量自动豁免、按收件人前缀匹配或手改
`migration-plan.json`。

PASS：每域 `source = migrated + duplicate + terminal + manual + conflict`，且
manual/conflict 为 0；`manualAdjudications` 与 ledger complete 记录逐行一致；promotion
后 DB/marker/authority window/epoch/0001–0009 完全一致。

NO-GO：任一守恒式不平、canonical payload digest 冲突、FK/integrity/权限失败。

回退：删除未 promote 的 staging 后重来；promote 后仍未产生 external effect 时走 T1。

### ⑥ 安全重置

动作：每个旧路径原子移动到 evidence archive，递归只读；在原路径创建非空 0500
目录 tombstone（内含 0400 marker）。旧 DB 即使原来是文件也使用同名目录 tombstone，
使普通 open 与递归删除都 fail loud，同时绝不 chmod 共享的 `~/.flywheel` 父目录。
旧 launchd plist、wrapper、credential 同属 fence 集合。

PASS：`archive-receipts.json` 的 digest 与 archive 实体一致；原路径只剩合法
tombstone（目录 0500、唯一 marker 为普通文件 0400、无 symlink），共享父目录 mode
保持归档前值；旧启动入口已 disable。实弹前后同时比对 digest 与 mode，任何 chmod
弱化都按路径变更 NO-GO。

NO-GO：路径未覆盖、archive/tombstone 冲突、symlink/special file、权限未生效。

回退：仅 T1 按 receipt 逆序恢复原 mode/path；禁止手工 copy 回去。

### ⑦ epoch fence

动作：以 cutover window/epoch 打开最终 DB；真实启动 manifest 中的旧 Bridge 与
flywheel-comm writer 一次。

PASS：每个旧 writer 都非零退出，并在 stderr 明确出现 frozen/EACCES/EPERM/read-only；
旧 DB/WAL/SHM/JSON 路径 digest 前后完全相同。随后生成 prestart Go/No-Go；此时只有
第 ② 项因为 held endpoint 尚未启动可为 pending。

NO-GO：旧 writer 成功、静默退出、创建 WAL/SHM、递归重建目录或修改任一旧路径。

回退：保持新系统 held，修复围栏；不得进入步骤 8。

### ⑧ 顺序启动

必须由 founder 两次精确确认。

8a `heldStart`：

1. 启动 v2 host；
2. 启动 `flywheel-v2-discord-ingress`；
3. 启动 v2 scheduler；
4. 不启动/注册 Lead，不放行任何 mutation/effect；
5. 用旧 token/capability 真打 held endpoint。

旧凭据必须得到 401/403/denied/revoked/frozen/unauthorized 类明确拒绝。host 与
scheduler 每次请求/运行都重新核对机器 authority 与 DB authority；两者漂移立即
fail closed。

8b `finalGo`：

1. 展示最终 Go/No-Go 报告；
2. founder 输入精确 final GO 口令；
3. DB authority CAS `cutover → live`；
4. 原子发布机器 authority `live`；
5. 逐个启动 v2 Lead，采集真实 PID/start-time/session identity 后
   register/reattach；
6. 放行 admission/dispatch/effect。

PASS：所有启动命令有 receipt；health 从 held 变为 live；不存在旧写入。

NO-GO：旧凭据未拒、双 authority 不一致、Lead 无会话证据、任何 Go/No-Go 红项。

回退：final GO 前可 T1；final GO 后只 forward repair。

### ⑨ 回滚点

动作：读取 rollback fence，记录 `external_effect_intent_count` 与 rollback state。

PASS：证据明确写出 T1 是否仍可用。第一个外部 effect intent 一旦写入，T1 永久关闭。

T1 命令（仅 founder 明示且计数为 0）：

```bash
flywheel-v2-cutover rollback-t1 \
  --target /absolute/path/production-target.json
```

该命令先做 DB rollback CAS，逆序恢复 archive receipt，执行旧服务恢复命令，写
rollback receipt，再把机器 authority 发布回 pre。任一步失败都保持 fail closed，
不得绕过 receipt 手工双轨。archive restore 可从 tombstone 已转 0700、tombstone
已删除、archive 根已临时转为可写、archive 已 rename 回原路径但原 mode 尚未恢复这
四个文件系统边界重入；每次都先绑定 receipt 的 digest/path/mode 元数据。restore
全程不 chmod 共享旧路径父目录，完成后必须逐路径恢复原 mode 并再次严格验证。

## 3. 最终 Go/No-Go

checker 输出每项 PASS/FAIL 与证据路径；一项失败即 NO-GO。

1. 旧 writer PID/tmux/daemon 全退出。
2. 旧 API token 与旧 capability 被明确拒绝。
3. 每个 active task 至多一个 active attempt。
4. actions `effect_key` 唯一，invocation 派生合同成立。
5. 已启动 action 有 settled outcome，或保持诚实 intended。
6. migrated ship gate 绑定 exact head。
7. v2 DB 0600、父目录 0700、integrity/FK/migration manifest/WAL backup 全通过。
8. 双源 canonical 迁移守恒，journal 与 external obligation 清零。
9. 旧信箱只读 archive 与原路径 tombstone 全部匹配。
10. 旧 writer 实弹测试全部 fail loud 且零旧路径新写。

另外两个同等级上线阻塞项：

- namespace：fence 与 v2 新路径不相交，上电后的旧路径零新写；
- GitHub lane：required checks 存在，actor 非 admin 且不在任何 user/team/app bypass。

## 4. 旧入口冻结矩阵

| 入口 | 主围栏 | 路径围栏/实弹 |
|---|---|---|
| `flywheel-comm` CLI | 启动时读取机器 authority，cutover/live 拒绝 | comm.db 墓碑 + CLI 实弹 |
| 旧 Bridge `teamlead` | 组合根启动前读取机器 authority | comm/JSON/plist/wrapper 墓碑 |
| Codex Lead headless/TUI/gateway | 各入口启动前读取机器 authority | journal/comm 墓碑 |
| `claude-lead.sh` | shell 启动前调用共享 kernel authority 检查 | team/inbox 路径墓碑 |
| 旧 launchd/patrol/scheduler | bootout + disable + plist 归档 | PID/lsof/launchd 实弹 |
| 新 thin Discord ingress | 不加载旧 queue，只调用 `flywheel-v2 enqueue` | host held/live 双 authority |

围栏是兜底，主刀仍是“停进程 + 撤启动入口 + 撤旧凭据”。FLY-1503 才物理删旧代码；
本窗口只做可逆禁用。

## 5. 上电后验收

final GO 后立即执行一个真实、低风险 issue：

1. Discord 新消息只产生一个 `(source_kind=discord, source_id=message_id)` mailbox row；
2. Lead 注册绑定当前 host epoch 与真实 session evidence；
3. admit → dispatch → proposal settlement → gate → founder approval → ship 全链完成；
4. host 响应丢失重试返回相同 durable receipt，不产生第二次 effect；
5. scheduler 有新 run receipt，restart-storm gate 仍生效；
6. `find -newer <8b-baseline>` 在所有旧路径返回 0；
7. 观察一个 patrol 周期，无旧 daemon/launchd/tmux 复活。

任一验收失败：立即停新 ingress/effect，保留 live authority 与证据做 forward repair；
不得恢复旧 writer 形成双轨。
