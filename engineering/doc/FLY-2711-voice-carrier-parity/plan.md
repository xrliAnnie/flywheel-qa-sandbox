# FLY-2711 语音载体对齐 — 实施计划
Issue: FLY-2711 (https://linear.app/geoforge3d/issue/FLY-2711/语音载体-语音只能在-raya-上起claude-载体-lead-与-529-slot-的-codex-载体都起不来合并-fly-2712)
日期: 2026-09-24
基于: research.md

**Version**: v2.1 · **Status**: Codex R2 APPROVED；v2.1 只吸收 R2 两项 LOW，待确认轮

## 0. 一句话与范围

让 Claude 载体 Lead 也能通过语音准入：把早已写好、却一直卡在 fork 的 Claude 插件 self-filter 探针（fork PR #28）修掉三个缺陷后合入并走受管上线；主仓只补跨仓合同测试与运维文档。原 FLY-2712 的 `/tmp` ↔ `/private/tmp` 问题已由 FLY-2655 PR #1243 在 main 修复，本单只保留回归判据。

| 两件事 | 现状（main 637752fcc） | 本单动作 |
|---|---|---|
| ① Claude 载体 `start` 503 `self_filter_unverified` | 客户端就绪；服务端在 fork PR #28，未合入、有 3 缺陷 | 修 fork（§2），主仓补测试/文档（§3），slot 真机 QA（§5） |
| ② slot Codex full-access `ConfigGateError`（原 FLY-2712） | 已修：`mcp-config.ts:104-121` + `mcp-config.test.ts:216`，QA attempt 6 Codex slot 已进房 | 零新代码；QA 回归一行（§5 Q8） |

选择路线 A（插件补服务端），拒绝路线 B（preflight 给 Claude 载体替代验证）：B 只能改看源码版本/安装指针/配置开关，FLY-2598 合同明文禁止这些替代运行中探测，且「可配置」等于留一个能把门打开的旋钮（exploration §3）。

## 1. 不变量（实现与评审都按此核）

- **I1 不丢 founder 消息**（Lead 硬要求 a）：任何 Claude Lead 的非自身作者入站，在断线/resume 重放/`client.user` 暂缺期间都不得因本改动被丢；丢弃集合只允许是「作者 = 已固定的自身 bot ID」以及「身份从未固定」（discord.js 首次 ready 前不派发 messageCreate，故后者实际为空集）。
- **I2 自身作者一律不进入**：自身 bot 发的消息（含语音镜像 🗣️/📻/🤖）在任何连接态、任何 recorder 模式下都不进入 access / 路由 / 回执 / reaction / notification；`allowBots` 含自身也不例外。
- **I3 探针同函数**：探针报告的 `selfDropped/unknownDropped/otherPassed` 由入站使用的同一个 guard 函数计算；ready=true 时，探针调用 guard 的参数与入站完全相同。guard 被替换（mutation）时探针必须失败。
- **I4 探针只在「现在确实连着且接线完整」时给 ready**：ready = 已固定身份且有效 ∧ 当前连接已就绪 ∧ `client.user.id` 等于固定 ID ∧ `RECORDER_MODE==='enabled'`。重连中探针 ready=false（语音准入暂时关闭），但入站不受影响（I1）。
- **I5 残留 socket 自动回收**（Lead 硬要求 b）：socket 的唯一主人由内核文件锁决定；只有持锁者能删除残留名、绑定、发布公共名；活主人始终持锁，因此绝不会被抢占或误删；symlink / 非 socket / 他人属主一律不删；拿不到锁或被阻挡时每 5 s 重试，直到本进程退出。
- **I6 线协议零变化**：请求/响应字段、MAC 序列、分帧、4 KiB / 2 s 上限与 research R1 表完全一致；两仓用同一组黄金向量钉住。
- **I7 主仓生产代码零 diff**：`packages/*/src/**` 非测试文件、`scripts/**` 非测试文件不改；Codex 路径行为不变由此直接成立。
- **I8 不触生产**：runner/QA 不写 `~/.claude/plugins/`，不重启任何生产 Lead，不跑 updater / restart-services；上线由 Lead/更新器窗口执行。

## 2. fork 改动（`xrliAnnie/claude-plugins-official`，`external_plugins/discord/`）

分支：`flywheel-FLY-2711-self-filter`，从 PR #28 head `07fffea10f5ddf723a7e7c45e473dbebe0004af0` 切出，保留 #28 的三个 commit 作历史；新 PR 标题 `fix(discord): ship live self-author filter probe for voice (FLY-2711)`，body 写明 supersedes #28（#28 由 Lead 在合入时关闭，runner 不关）。

### F1 入站判定改用「固定身份」，探针才看连接态（修缺陷 1）

`self-author-filter.ts` 重写 `SelfAuthorFilter` 与 `attachSelfAuthorFilter`，`selfAuthorAllowed` 保持逐字不变（与主仓 `voice-self-filter-contract.ts` 同式）：

```ts
export class SelfAuthorFilter {
  private botId?: string          // 首次合法 ready 固定，之后永不清空
  private invalid = false         // 一旦见到不同 ID 永久置 true
  private connected = false       // 仅供探针
  constructor(private readonly guard = selfAuthorAllowed,
              private readonly onInvalid: (seen: string) => void = () => {}) {}
  pin(id: string | undefined): void      // ready / clientReady / shardReady / shardResume
  disconnected(): void                   // shardDisconnect / shardReconnecting / invalidated → connected=false
  noteCurrent(id: string | undefined): void  // 仅当 botId 已固定 且 id 存在 且 id ≠ botId → invalid=true, connected=false, onInvalid(id)；botId 未固定时什么都不做
  identityValid(): boolean               // Boolean(botId) && !invalid
  allowsIntake(authorId: string): boolean   // guard(botId, identityValid(), authorId)
  isSelf(authorId: string): boolean      // Boolean(botId) && authorId === botId
  observe(p: { recorderEnabled: boolean; currentUserId?: string; clientReady: boolean }): SelfFilterObservation
}
```

- `pin(id)`：`invalid` 时忽略；`id` 非 17–20 位 snowflake → `connected=false` 后返回；已有 `botId` 且不同 → 走 `noteCurrent` 的 invalid 分支；否则 `botId ??= id; connected = true`。
- `observe(p)`：先 `noteCurrent(p.currentUserId)`；`ready = connected && p.clientReady && identityValid() && p.currentUserId === botId && p.recorderEnabled`；其余三项与主仓 `observeVoiceSelfFilter` 逐式相同：`selfDropped = !guard(botId, ready, botId ?? '')`，`unknownDropped = !guard(undefined, true, other) && !guard(botId, false, other)`，`otherPassed = guard(botId, ready, other)`。ready=true 时 `identityValid()` 必为 true，`guard(botId, ready, x)` 即入站的 `guard(botId, identityValid(), x)`（I3）。
- `attachSelfAuthorFilter(client, filter, effects)`：注册 lifecycle 监听如上；`messageCreate` 回调第一行 `filter.noteCurrent(client.user?.id)`，然后 `if (!filter.allowsIntake(author)) { if (filter.isSelf(author)) effects.onSelfEcho(msg); return }`，否则 `effects.onOther(msg)`。**不再读取连接态**，也不再因 `client.user` 暂缺而丢弃。
- `noteCurrent` 与 `fork self-author-filter.ts:28` 现有条件保持同式（`id && this.botId && id !== this.botId`）：首次 `pin` 之前 `client.user.id` 已存在的窗口（discord.js `handlers/READY.js` 先设 user，`WebSocketShard` 等 guild 到齐或 15 s 超时后才 `shardReady`）里来的探针只会得到 ready=false，**不得**触发 invalid。
- `onInvalid` 在 `server.ts` 里只写一行 stderr + `gatewayHealthFiles.log('self-filter identity changed; intake closed')`（本地文件，无 Discord 文本，符合 FLY-1730 裁定）。invalid 只可能由「已固定 A 之后又看到 B」触发；同一进程 token 固定，Discord 对同一 token 的 user id 不变，此分支按构造不可达，仅作防御。I1 的「允许丢弃集合」据此补充第三项：已检测到身份漂移后的全部入站（防御性、不可达）。
- `server.ts` 的 `messageCreate` 接线保持 PR #28 形状（`onSelfEcho` → `gatewayHealth.onSelfEcho`；`onOther` → 原 `allowBots` 判定 + `handleInbound`）。voice socket 的 `observe` 闭包改为传 `{ recorderEnabled: RECORDER_MODE.kind === 'enabled', currentUserId: client.user?.id, clientReady: client.isReady() }`。

先红后绿（在 `07fffea1` 上必须红）：
- `F1-T1 resume 重放不丢`：ready(A) → `shardReconnecting` → messageCreate(founder) → messageCreate(A) → `shardResume` → messageCreate(founder2)。期望 received=[founder, founder2]、echoes=[A]；在 `07fffea1` 上 received=[founder2]（红）。同时断言诊断行序号严格递增为 `reconnecting` < `admitted-while-reconnecting message=<founder>` < `resume`，且 founder2（resume 之后）不产生 admitted 行。
- `F1-T2 断线且 client.user 暂缺`：ready(A) → `shardDisconnect` → `client.user=undefined` → founder、A。期望 received=[founder]、echoes=[A]；`observe(...).ready=false`。
- `F1-T3 invalidated 后重新 IDENTIFY`：ready(A) → `invalidated` → founder（收）→ `shardReady` → `observe.ready=true`。
- 保留并改写 #28 既有用例：首次 ready 前一律不收（不变）；ID 变化（ready(A)→ready(B) 或 messageCreate 时 `client.user.id=B`）→ 之后全部不收、`observe.ready=false`、`onInvalid` 恰一次；recorder 非 enabled → `observe.ready=false` 但自身仍丢；guard mutation（`() => true`）→ 探针 `selfDropped/unknownDropped=false`。原「断线期间 founder 被丢」「client.user 消失后全部不收」两条期望按 I1 反转。
- `F1-T4 allowBots 含自身`：access `allowBots=[A]` 时 A 的消息在所有连接态仍零 `handleInbound`（接线级测试，用真实注册的回调）。
- `F1-T5 首次 ready 前的探针不毒化身份`：`client.user={id:A}`（尚未 emit ready）→ `observe(...)` = ready=false 且 `onInvalid` 调用 0 次 → emit `ready` → founder 进入、A 仍被过滤、`observe.ready=true`。按 v1 的写法此用例红。

**重连窗口诊断（供 QA Q6 取证，常驻、有界）**：`attachSelfAuthorFilter` 维护进程内单调序号 `seq`；在 `gatewayHealthFiles.log` 写三类行，只含 ID 与计数、不含正文/token：`self-filter lifecycle pid=<process.pid> seq=<n> event=reconnecting|disconnect|invalidated|resume replayed=<k>|ready`；当 `connected=false`（身份已固定）期间有非自身消息被放行时写 `self-filter admitted-while-reconnecting pid=<process.pid> seq=<n> message=<snowflake> channel=<snowflake>`。后者每个断线窗口最多 50 行，超出只计数并在该窗口结束（下一条 resume/ready 行）时写 `suppressed=<k>`。

### F2 socket 生命周期：内核锁定主人，持锁者回收残留（修缺陷 2）

v1 的「connect 得 ECONNREFUSED + 再 lstat 一次」无法消除「最后一次 inode 复核与 unlink 之间」的跨进程竞态（Codex R1 #2）。v2 改为**用内核文件锁决定唯一主人**：只有持锁者可以删、建、发布公共名；锁随进程死亡由内核释放，因此崩溃后无需任何用户态「陈旧证明」协议。

锁的实现（2026-09-24 本机实测，Bun 1.3.11 / darwin 25.6）：`openSync(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW | 0x20 /* O_EXLOCK */ | O_NONBLOCK, 0o600)`。第二个进程得 `EAGAIN`；持锁进程 `close(fd)` 或被 `SIGKILL` 后，下一个进程立即拿到锁。`lockPath = STATE_DIR/voice-self-filter.lock`，打开后 `fstat` 核 `isFile()` 且 `uid === process.getuid()`，否则 `'blocked'(lock_unsafe)`。锁文件**永不删除**（删锁文件本身会重新引入竞态）。

平台：`0x20` 只在 darwin 表示 `O_EXLOCK`；生产与 529 slot 都只在 macOS 上跑插件。`process.platform !== 'darwin'` 时不创建 socket，stderr 一行 `voice self-filter probe unsupported on <platform>; voice admission remains closed`（fail closed）。锁通过构造参数注入（`acquireOwnerLock(): OwnerLock | 'busy' | 'blocked'`），Linux CI 用进程内假锁跑全部逻辑用例；真实内核锁用例 `it.skipIf(process.platform !== 'darwin')`，由 implement 在本机 macOS 跑并存输出。

`VoiceSelfFilterSocket` 生命周期：

1. `listen()` → 先 `acquireOwnerLock()`：`EAGAIN` → 返回 `'busy'`（另一个本 Lead 插件进程活着并持有），什么都不碰。
2. 持锁后清理残留（此时没有任何其他进程能改这几个名字）：
   - 公共名 `voice-self-filter.sock`：不存在 → 跳过；是 symlink / 非 socket / 非本 uid → 释放锁，返回 `'blocked'(path_symlink|path_not_socket|path_foreign_owner)`，**不删**；是本 uid socket → 它只可能是已死主人的残留 → `unlink`（记 `reclaimed stale`）。
   - 私有名：同目录中文件名严格匹配 `^\.v[0-9a-f]{12}$` 的项（最多 64 个），仅当是本 uid socket 才删；其他项一律不碰。
3. 绑定：沿用 #28 的「私有名 listen → chmod 0600 → `linkSync` 发布公共名」；持锁状态下 `EEXIST` 不应出现，若出现视为外部写入者 → 关闭自己、删自己的私有名、释放锁、`'blocked'(path_raced)`。
4. 返回 `'bound'`，**锁 fd 持有到 `close()` 为止**。
5. `close()`（shutdown 或自检发现公共名被外部改动时）严格按序：按 inode 删自己的公共名 → 删自己的私有名 → `server.close()` → 最后 `closeSync(lockFd)` 释放锁。因为删名发生在释放锁之前，新主人只能在旧主人删完之后拿到锁，不存在 v1 那种「旧主人 close 删掉新主人公共名」的交错。

`server.ts`：删除 `await voiceSelfFilterSocket.listen()`（不再阻塞 `client.login`），改为 `ensureVoiceSelfFilterSocket()`：立即尝试一次；`'busy'` / `'blocked'` 时 `setTimeout(…, 5000).unref()` 重试，直至 `shuttingDown`；已 bound 时每 30 s `lstat(public)` 核 `dev/ino` 仍是自己，若被外部删除/替换 → 走 `close()` 后重试（持锁期间只有外部非本协议的写入者能改它，属运维误操作，自愈即可）。stderr 与 `gatewayHealthFiles.log` 只在结果或原因变化时写一行（`bound`、`reclaimed stale`、`busy`、`blocked:<reason>`、`unsupported`），不含秘密。

测试：
- `F2-T1 崩溃残留回收（darwin 真实锁）`：子进程 bun 起 socket 后 `SIGKILL` → 公共名与私有名都残留 → 新实例 `listen()` = `'bound'`、两个残留名被删、探针请求成功。`07fffea1` 上红（抛 `path_exists`）。
- `F2-T2 活主人不抢（darwin 真实锁）`：子进程 A bound → 本进程 B `listen()` = `'busy'`，A 的公共名仍可应答；A 正常退出后 B 的 ensure 下一轮 = `'bound'`（注入重试时钟）。
- `F2-T3 交接不互删（darwin 真实锁）`：A bound → A `close()` 与 B `ensure` 并发启动 → 结束时公共名存在、inode 属于 B、探针成功；循环 50 次无一次公共名缺失或属于已关闭的 A。
- `F2-T4 不碰不该碰的（假锁，Linux+darwin）`：公共名为 symlink / 普通文件 / 非本 uid（注入 `getuid`）→ `'blocked'`、原样保留、锁已释放；不匹配正则的 `.vX`、`foo.sock` 残留 socket 不删；锁文件为 symlink（`O_NOFOLLOW` → `ELOOP`）→ `'blocked'(lock_unsafe)`。
- `F2-T5 外部删除后自愈（假锁）`：bound 后外部 `unlink(public)` → 30 s 自检（注入时钟）→ 重新 bound，新探针成功。
- `F2-T6 非 darwin fail closed`：注入 `platform='linux'` → 不建 socket、`observe` 不被调用、stderr 恰一行。
- 保留 #28 既有：0600、MAC、畸形/跨 Lead 请求拒绝、4097 B 拒绝且不调 observe、Node 客户端换行分帧（在假锁下跑）。删除 #28 的「never steals active sockets」旧写法，由 F2-T2/T4 取代。

### F3 版本与文档（修缺陷 3）

- `external_plugins/discord/.claude-plugin/plugin.json`：`0.0.7` → `0.0.8`，同 PR 内。
- `VOICE-SELF-FILTER.md`：补「入站看固定身份、探针看连接态」「陈旧回收判据」「回滚前先结束语音会话」三段。

### F4 黄金向量（跨仓 drift 守卫）

新增 `voice-self-filter-vectors.test.ts`：固定输入 `secret="fly2711-golden-vector-not-a-token"`、`leadId="fly2711-vector-lead"`、`expectedBotUserId="100000000000000005"`、`nonce="0123456789abcdef"×4`、`runtimeId="11111111-2222-4333-8444-555555555555"`、观测全 true；断言插件的请求 MAC 与响应 MAC 等于两个 64-hex 字面量。字面量由主仓实现先算出（§3 M1），两仓逐字相同；任何一侧改序列化，两边之一必红。

## 3. 主仓改动（本分支 `flywheel-FLY-2711`）

- **M1** `packages/teamlead/src/bridge/__tests__/voice-self-filter-vectors.test.ts`：同 F4 输入，断言 `makeVoiceSelfFilterRequest(...).auth` 与 `signVoiceSelfFilterResponse(...).auth` 等于同两个字面量；再断言 `verifyVoiceSelfFilterResponse` 接受该响应、改任一字段后拒绝。实现顺序：先在主仓用现有函数算出字面量写死，再复制到 F4。
- **M2** `voice-self-filter-probe.test.ts` 新增 Claude 分帧正向用例：fake server 只在收到 `\n` 时应答、记录应答前是否收到过 `end`（期望 false，即客户端未半关）、返回合法签名响应 → `probeVoiceSelfFilterSocket({backend:"claude"})` resolve 且 `runtimeId` 等于服务端值。现有 Claude 用例全是拒绝路径，正向路径此前只在 fork 侧测过。
- **M3a** `engineering/doc/FLY-2598-voice-host-activation/self-filter-contract.md` §1/§3 与同目录 `plan.md:75` 加 FLY-2711 修订注：入站由「已固定身份是否有效」决定，连接态只额外决定语音探针 ready；原「未 ready/重连时拒收」「重连期间 probe 失败与事件丢弃一致」两句作废（给出原因与本 plan 链接）；socket 主人由内核锁决定，替代「遇已有可连接 owner 不抢占」的文字判据。
- **M3** `engineering/doc/FLY-2598-voice-host-activation/host-runbook.md` 增「Claude 载体前提」小节：插件 ≥ 0.0.8 且该 Lead 已在上线后重启；`<discordStateDir>/voice-self-filter.sock` 存在且 0600；用 `scripts/qa/fly2598-voice-preflight.mjs` 只读核验；插件回滚前先结束该 Lead 语音会话，回滚后该 Lead 语音 = 503（fail closed）属预期。
- **M4** implement 收尾：`engineering/doc/milestones/FLY-2711.md`（一 issue 一文件），记录 fork PR 号/合入 SHA、主仓 PR、QA 收据路径。
- 不改：Bridge 探针客户端、preflight、services、StateStore、Codex 后端、test-deploy、QA 工装。若 QA 发现工装对 Claude 槽有缺口，另开单，不在本 PR 扩范围。

## 4. 实施分块（implement 节点）

| 块 | 内容 | 完成判据 |
|---|---|---|
| C1 | fork 切分支；先写 F1-T1..T4 在 `07fffea1` 跑红并存输出；实现 F1 转绿 | `bun test` 全绿；红输出存 `engineering/doc/FLY-2711-voice-carrier-parity/evidence/fork-red.txt` |
| C2 | F2-T1..T6 先红（T1 必红）；实现 F2（锁注入 + darwin 真锁）与 `server.ts` ensure 循环 | 本机 macOS `bun test` 全绿且 darwin-only 用例实际执行（输出存 `evidence/fork-darwin-bun-test.txt`）；fork CI（ubuntu，真锁用例 skip）绿 |
| C3 | M1 算字面量 → F4 → F3 bump 与文档；开 fork PR | fork PR CI 绿、`plugin.json`=0.0.8、PR body 含 supersedes #28 |
| C4 | M2、M3；主仓 PR（`## Linear Issue` 段；依赖 fork PR 链接） | 主仓 CI 全绿；`git diff origin/main --stat -- packages/*/src scripts` 仅测试文件 |
| C5 | 代码复审两仓；M4 milestone | 两 PR 有效 review 通过 |

fork 与主仓 PR 都走各自 review；两者都不由 runner 合入。

## 5. QA 判据（qa 节点；开 claude-code 槽前 ask Lead，由 Lead 开）

被测物冻结为 fork PR head `<X>`（40 位）与主仓 PR head。全程按 FLY-1439 配方钉插件字节，不写生产插件目录。

- **Q0 生产快照**（前后各一次，逐字节比）：`~/.claude/plugins/installed_plugins.json`、`known_marketplaces.json` 中 flywheel-plugins 条目、`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts` SHA-256、生产 `~/.flywheel/test-slots.json` SHA-256（只读，QA 不改）。
- **Q1 字节证明**：`TEST_LEAD_CLAUDE_CONFIG_DIR=$SLOT_DIR/claude-config` + `TEST_SKIP_PLUGIN_FORK_CHECK=1` 部署一个 **claude-code** 槽；运行中 adapter 的 argv 指向隔离根；隔离目录插件文件清单 SHA-256 与 `git archive <X>:external_plugins/discord` 逐文件零 diff；`plugin.json` = 0.0.8；插件 stderr 无 `MAILBOX WIRING BROKEN`。
- **Q2 socket**：`$SLOT_DIR/discord-state/voice-self-filter.sock` 存在、0600；`lsof` 显示该 adapter pid 同时持有该 socket 与 `voice-self-filter.lock`。
- **Q3 slot 预检（真实探针，只读）**：两条现成入口都不能直接用——`fly2598-voice-preflight.mjs` 的 CLI 固定读生产 `~/.flywheel/{projects.json,voice-host.json,.env}`；`fly2655-voice-room.mjs prepare` 的 READY 不含 self-filter。配方：QA 在收据目录用 Write 落一个本地 `.mjs`（不提交），从 slot 实际使用的主仓 checkout（`room-info` 的 `flywheelRepo`，已 `pnpm -r build`）`import { runPreflight } from "<repo>/scripts/qa/fly2598-voice-preflight.mjs"`（模块有 main 守卫，import 不执行 CLI）；`projects` = 读 slot Bridge 启动 env 里的 `FLYWHEEL_PROJECTS_FILE`（即 `fly2655-voice-room.mjs loadSlot` 校验过的同一文件）后经 `parseAndValidateProjects`；`env` 只含 `{ [lead.botTokenEnv]: <从 ~/.flywheel/.env 用 node:util parseEnv 解析的该键值> }`；`codeSha` = slot build sha；`projectName` = `room-info.projectName`、`leadId` = `room-info.agentId`（与已校验的 slot topology 一致，缺失会返回 `project_not_unique/lead_not_unique`）；`deps` 不传（真实 fetch + 真实探针，零 mock）。输出只写 `ok/reason/checks.stage/checks.selfFilter{runtimeId,botUserId,ready,…}` 与时间，不写 token。判据：`ok=true`、`checks.stage="ready"`、`checks.selfFilter.botUserId` = slot bot，记录 `runtimeId=R1`。该配方只做 Discord GET 与只读探针，不建会话。
- **Q4 起会话到 live（主判据）**：先与 Lead 约好 founder 进 529 语音房（`voice-codex` 只有检测到 founder 在房内才 `setState(live)`，否则以 `no_human` 结束，见 `packages/voice-codex/src/daemon.ts:600-627`）。`fly2655-voice-room.mjs` 对该 claude-code 槽 `start`：HTTP 非 503 → 用同一 sessionId 有界轮询 slot Bridge `GET /api/voice/sessions/<id>`（工装已有的认证方式）直到 `state="live"`（上限 = 该会话 presence 等待时长 + 60 s）；`claimed/warming` 不是 live，`ended/no_human` 记「founder 未在房」重来，不判 PASS。证据：start 响应码、live 时刻的 session 行（sessionId/projectName/leadId/voiceBotUserId/state）、Discord 语音频道成员含 slot bot。founder 说话属加分记录。
- **Q5 无回环**：会话期间用 Discord API GET 取该 bot 在 Lead 频道/会话线程发出的全部消息 id（镜像 🗣️/📻/🤖 与正常回复）；slot comm.db `mailbox` 中 `source_kind='discord_chat'` 且 `source_ref='chat:<agentId>:<这些 id>'` 的行数 = 0；Lead pane 无把镜像当 founder 输入的回合。
- **Q6 resume 不丢消息（Lead 硬要求）**：目标是让一条 founder 消息**只能**经 resume 重放窗口到达。步骤：① `kill -STOP <adapter pid>`；② 每 5 s 用 `lsof -a -p <adapter pid> -iTCP` 查看其到 Discord gateway 的连接，等到该连接变为 `CLOSE_WAIT`（服务端因心跳缺失已关闭旧连接；上限 150 s，超时记 HARNESS INVALID 重来）——此后创建的消息不可能进入旧连接的接收缓冲；③ 请 founder 在该 Lead 文字频道发一条带唯一短语的消息，记下 messageId；④ `kill -CONT`。PASS 需同时满足：`gateway-health.log` 中按 `pid=<该 adapter pid>` 筛选后的诊断行序号满足 `lifecycle event=reconnecting` < `admitted-while-reconnecting message=<该 messageId>` < `lifecycle event=resume replayed=<k≥1>`；`mailbox` 中 `source_ref='chat:<agentId>:<该 messageId>'` 恰好 1 行；Lead 回合里出现该短语。若看到的是重新 IDENTIFY（`event=ready` 而非 `resume`）或目标 messageId 不在两行之间，记 HARNESS INVALID 重做（最多 3 次，仍不成则如实报 Lead，不判 PASS）。founder 需在 Q4 同一时段配合，QA 先 ask Lead 约时间。
- **Q7 残留回收**：`kill -9 <adapter pid>`（内核随即释放锁）→ 确认公共 sock 与私有 `.v<hex>` 仍在（残留）→ `kill -TERM <claude pid>` 让 launchd 拉起新体（`claude-lead.sh` 的 child 退出重生路径）→ 新 adapter 的 gateway-health / stderr 出现 `reclaimed stale` 与 `bound` → 重跑 Q3 配方：`ok=true` 且 `runtimeId=R2 ≠ R1`；目录中只剩新主人的一对名字 + 锁文件。
- **Q8 Codex 回归**：必做 = 主仓 diff 满足 I7 + 语音/Codex 相关测试全绿（CI）；可选 = Lead 另提供 codex-app-server 槽时，同工装 `start` 到 live 一次。
- **Q9 收尾**：拆房前复制 gateway-health.log、launchd json、pane capture、startup log、socket `ls -l` 到收据目录；`scripts/test-teardown.sh <slot>`；复拍 Q0。

## 6. 上线与回滚（Lead / 更新器，不属于 design、implement、QA 节点）

- **合入 fork PR = 生产上线触发器**：fork `main` 就是生产指针，合入后下一个 `restart-services.sh` 窗口的 `check_discord_plugin_fork` 会判 OUTDATED → 更新到 0.0.8 → Lead 重启波次。因此 fork PR 合入按 ship 动作处理，须在 Q1–Q7 PASS 之后；主仓 PR（只含测试/文档）可先可后。
- 上线影响面：生产 14 个 Claude Lead 在 registry 里已有 `voiceRoom` + `voiceModes.meeting=true`（2026-09-24 读 `~/.flywheel/projects.json`）。上线后它们的会议模式语音不再被 self-filter 挡住；这正是本单目标，但属于行为开放，Lead 需知情。
- 上线后只读核验（Lead 执行）：挑一个 Claude Lead（建议 `flywheel/flywheel-eng-lead`）跑 `scripts/qa/fly2598-voice-preflight.mjs --project flywheel --lead flywheel-eng-lead --out <json>`，期望 `stage=ready`；只做 Discord GET + 只读探针，不起会话。
- 回滚：fork revert 除 `plugin.json` 外全部改动、`plugin.json` → 0.0.9，按 FLY-1730 §D3 断言 revert 与 preimage 仅差 `plugin.json`；回滚前先结束所有 Claude Lead 的活动语音会话。回滚后 Claude 语音回到 503、文字入站回到 0.0.7 行为；主仓无需回滚。
- **两条现有上线触发路径**：(1) `restart-services.sh` 的 `check_discord_plugin_fork`；(2) 任一 Claude Lead 自然重生时 `claude-lead.sh:1129-1139` 也会跑 checker→updater→recheck。所以 fork 合入后**没有确定的等待窗口**，第一个重生的 Lead 就可能把共享插件指针更新到 0.0.8（已运行的其他 Lead 仍跑旧字节，直到各自重启）。窗口协调与 fork-main 冻结必须在合入**之前**由 Lead 安排。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| F1 改动覆盖所有 Claude Lead 的入站路径 | 非自身作者行为 = 0.0.7 原样（F1-T1..T4 + 既有 244 个 bun 测试）；自身作者比 0.0.7 更严（0.0.7 在 `client.user` 暂缺时自身消息会落到 allowBots 判定） |
| 回收误删活 socket / 并发互删 | 只有持内核锁者能删建发布，锁在删名之后才释放，活主人永远持锁；F2-T2/T3（darwin 真锁，50 次交接循环）/T4 |
| Bun 不透传 `O_EXLOCK` 的未来版本 | F2-T1..T3 在 darwin 上用真实锁跑，Bun 升级若失效测试即红；运行时拿不到锁只会 `busy`→语音 503，不会误删 |
| Linux CI 与 macOS 行为差 | F2 测试两平台都跑；私有名方案已覆盖 Bun Linux close 时 unlink |
| Q6 无法稳定触发 resume | `CLOSE_WAIT` 门 + 诊断行序号绑定；最多 3 次，失败如实报 Lead；单元层 F1-T1 已钉住事件序 |

## 8. Lead 裁定记录

- 2026-09-24 ask `3c33dd1c`：同意本方案；硬要求 (a) 不丢 founder 消息，resume 重放先红后绿 + slot 实测；(b) 残留 sock 自动回收有用例；(c) 插件 0.0.8 bump；生产上线走 updater/班车，runner 不重启任何 Lead；开 claude-code 槽 ask Lead；test-slots.json 由 Lead 核。

## 9. 修订轨迹

- v1（2026-09-24）：初稿。
- v2（2026-09-24，Codex R1 6 项全收）：#1 `noteCurrent` 仅在身份已固定后判漂移 + F1-T5；#2 F2 改为 darwin 内核锁（`O_EXLOCK`，本机 Bun 1.3.11 实测）决定唯一主人、删名先于释放锁，取消 ECONNREFUSED 陈旧证明，新增 F2-T3 交接循环与非 darwin fail closed；#3 Q3 写定 slot-only `runPreflight` 配方、Q4 约 founder 在房并有界轮询到 `live`；#4 新增重连窗口诊断行，Q6 用 `CLOSE_WAIT` 门 + 序号绑定判 PASS；#5 M3a 修订 FLY-2598 合同原文；#6 §6 列出 Lead 自然重生也会更新插件。
- v2.1（2026-09-24，Codex R2 APPROVED 后）：吸收 R2 两项 LOW——Q3 配方显式传 `projectName/leadId`；诊断行统一带 `pid=`，Q6 先按 pid 筛选再比 seq。无设计变更。
