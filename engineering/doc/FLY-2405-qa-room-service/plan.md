# FLY-2405 起房服务 — 实施计划
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405/载体起房服务-codex-runner-在沙箱里起不了-529-测试房launchctl-bootstrap-eio-看不到沙箱外进程)
日期: 2026-09-28
基于: research.md

> 修订记录：v1 → v2（Codex 设计评审 R1：8 HIGH + 3 MEDIUM）→ v3（R2：5 HIGH + 1 MEDIUM + 3 澄清）→ v4（R3：4 HIGH）→ v5（R4：1 HIGH + 1 LOW），处理表见 §10。

## 0. 目标、非目标、信任模型

**目标**：沙箱内任何 runner（Codex / Claude 一视同仁）用 `flywheel-comm room deploy|status|teardown` 起、查、拆 529 测试房；执行在 Bridge 进程侧（沙箱外，`env -i` 最小环境）；越权被拒并留审计；拆房零残留；Lead 零手工。

**非目标**：不给 runner 任何生产 launchd / 生产 Bridge 操作权；不实现 codex:rescue 与任意"沙箱外 job"（只在 §9 评估）；不实现 e2e driver 代跑（§9 follow-up）；不做 merge / deploy。

**信任模型（诚实边界，R1-#1）**：起房服务**不是**让不可信代码变安全的沙箱。今天 Lead 手工起房时，会在宿主权限下构建并运行 runner 推上去的分支代码——服务保持**同一信任级别**，只把"谁能触发、触发哪份字节、留什么痕"收紧并结构化：

1. **哪份字节**：服务根 `SERVICE_ROOT = $HOME/.flywheel-qa-rooms/`（**不在** `~/.flywheel`、`/tmp`、`/private/tmp`、`$TMPDIR`、任何 worktree 或主仓 `.git` 之下）。服务维护自有 bare 镜像 `SERVICE_ROOT/mirror/<project>.git`（从项目已登记 origin `git fetch`），再从**该镜像** `git worktree add --detach` 物化到 `SERVICE_ROOT/src/<roomId>/`——worktree 元数据落在镜像内，而不是 runner 可写的主仓 `.git`（R2-#1：Codex 的 `buildDaemonSandboxWritableRoots` 把 `~/.flywheel`、worktree 与主仓 git 元数据都列为可写根）。op spec / 回执 / claim token 文件同在 `SERVICE_ROOT`。
   - Bridge 启动断言：`SERVICE_ROOT` 的 realpath 不落在 Codex 可写根集合（按 `buildDaemonSandboxWritableRoots` 同一输入推导的前缀集合 + `/tmp`、`/private/tmp`、`$TMPDIR`）之下，否则拒绝挂载服务并告警。
   - 物化后、执行前：`git -C src status --porcelain` 必须为空、`rev-parse HEAD == expectHead`。
   - 诚实边界：Codex runner（Seatbelt 沙箱）改不了物化字节——QA 判据含"房内 Codex runner 写 `SERVICE_ROOT` 被 EPERM"的实测；**Claude runner 本身不在沙箱内**，与宿主同用户，本来就能直接跑脚本，服务对它不提供字节隔离，只提供结构化与审计（与今天同级）。
   - SHA 必须是 owner exec 所属 issue 分支 `origin/<branch>` 的祖先或 tip（`git merge-base --is-ancestor`），否则 `bad_expect_head`；物化 checkout 必须声明房间协议能力（`scripts/test-deploy.sh --room-protocol-version` 输出 ≥1），旧 SHA 不支持 → `source_protocol_unsupported`。
2. **谁能触发**：只有持本 exec 能力凭据（§3.1）、`session_role ∈ {qa, implement}`、exec 运行中的 runner。
3. **控制脚本**：`test-deploy.sh` / `test-teardown.sh` 取自上述物化 checkout（被测版本本身就可能改这些脚本，这与 Lead 手工 `--expect-head` 流程一致）；服务层的锁、快照、残留判定、审计在 **Bridge 已安装代码** 里，不受被测字节影响。
4. **生产隔离**：服务从不接收 label / plist / 路径 / 配置目录类参数（§3.4 键白名单），env 由服务生成；这是"服务不开后门"的保证，不是"被测脚本不能作恶"的证明——后者与今天手工起房同级，由代码评审 + 分支保护承担。

**字节兼容**：`FLYWHEEL_QA_ROOM_SERVICE` 未设 → 不挂载路由，CLI 从 Bridge 应答判定 `room_service_disabled`（exit 3），手工起房流程逐字不变；脚本改动全部以"服务 claim token 存在"为开关，缺省路径逐字不变。

## 1. 架构

```mermaid
sequenceDiagram
  participant R as Runner(沙箱内)
  participant B as Bridge /qa-rooms (已安装代码)
  participant S as QaRoomStore(SQLite)
  participant L as 物理 claim(/tmp 锁目录)
  participant W as op-runner 包装器(沙箱外)
  R->>B: POST /qa-rooms/deploy + X-Flywheel-Room-Capability + requestId
  B->>S: 认证/角色/幂等/参数/负载 → room(requested)+op(deploy) + 审计
  B-->>R: 202 {roomId, opId}
  B->>L: 原子抢主 slot + extra slots(owner=服务:roomId:claimToken)
  B->>W: spawn node qa-room-op.mjs (env -i, argv 数组)
  W->>W: 物化 checkout → pnpm install+build → test-deploy.sh(claim token)
  W-->>S: 回执文件(exit, dbSeen, pid 化身) → ready / deploy_failed
  R->>B: GET /qa-rooms/:roomId (header 凭据)
  R->>B: POST /qa-rooms/:roomId/teardown + requestId
  B->>W: 逐库快照 → test-teardown.sh(claim token) → residue()
  W-->>S: torn_down + 同事务释放 claim / teardown_failed
```

## 2. 数据模型（StateStore 幂等建表；`QaRoomStore` 封装，StateStore 暴露 `qaRooms`，与既有 store 并存）

**`qa_service_meta`**：`bridge_instance_id`（首次启动生成并持久化，跨重启稳定）。

**`qa_rooms`**：`room_id` PK（uuid）· `request_id` UNIQUE（幂等键）· `request_hash`（规范化请求 sha256）· `owner_exec_id` / `owner_issue_id` / `owner_role` / `owner_adapter`（均服务端推导）· `slot` · `extra_slots_json` · `expect_head` · `source_dir` · `state`（`requested|queued|claiming|deploying|ready|deploy_failed|quarantined|tearing_down|teardown_failed|releasing|torn_down|refused|canceled`）· `planned_slots_json`（有序 slot 集合）· `deploy_id` · `launchd_labels_json`（精确 label 集合，含 extra slots，由脚本 registry 回报并绑定 deployId）· `db_coords_json`· `active_op_id`（CAS 串行化）· `claim_token_hash` · `claimed`（是否真正持有物理 claim）· `last_error` · 时间戳。

**`qa_room_ops`**：`op_id` PK · `room_id` · `kind`（`deploy|teardown`）· `request_id` UNIQUE · `attempt` · `state`（`pending|launching|running|succeeded|failed|supervisor_lost|fenced`）· `op_dir` · `pid` / `pid_start` / `pgid`（化身 = pid + `ps -o lstart=`；pgid = 脚本进程组）· `last_phase`（脚本阶段标记）· `deadline_at` · `receipt_path` · `exit_code` · `result_json`。

**`qa_room_capabilities`**：`exec_id` · `attempt` · `hash`（sha256）· `issued_at` · `revoked_at`；`UNIQUE(exec_id, attempt)`。

**`qa_room_audit`**（只追加）：`room_id?` · `actor_kind`（`runner|lead|unverified`）· `actor_id`（未认证时为 null，payload execId 仅记在 `claimed_actor`）· `action` · `outcome` · `reason` · `at`。

**`qa_room_snapshots`**：`room_id` · `op_id` · `db_role`（`teamlead|comm`）· `source_path` · `dest_path` · `sha256` · `at`——durable snapshot receipt。

## 3. 接口与认证

### 3.1 能力凭据（R1-#3）

- 在 `run-dispatcher` 公共 launch 路径（fresh 与 retry 两个位点，同 `workflowSubmissionCredential` 的接线方式）为 `role ∈ {qa, implement}` 生成 32 字节随机 capability：**先**写 `qa_room_capabilities` hash，**再**经 `BlueprintContext.qaRoomCapability` 注入 `TmuxAdapter` 与 `CodexTmuxAdapter` 的 env（`FLYWHEEL_QA_ROOM_CAPABILITY`）。不依赖 Claude HTTP hook 的 callback token。
- retry / resume 新 attempt → 新凭据，旧 attempt 置 `revoked_at`；exec 终态 → 全部撤销；Bridge 重启不影响已持久化 hash。老 session（无凭据）→ `unauthenticated`，需重派。
- 测试从**两种真实 adapter 构造出的 env** 取凭据发请求，不在路由测试里手造 hash。

### 3.2 认证器（R1-#4）

- 服务启用前提：`apiToken` 与 `ingestToken` 均非空且不同；否则服务拒绝挂载并在启动日志 + 告警里写明（fail-closed）。
- 独立认证器 `qaRoomAuth`（不复用 `tokenAuthMiddleware` 的"未配置即放行"）：
  - runner 面：`Authorization: Bearer <ingest>` + `X-Flywheel-Exec-Id` + `X-Flywheel-Room-Capability`（常量时间比较、未撤销、exec 运行中）。凭据只走 header，永不进 query / body / 日志。
  - Lead 面：`Authorization: Bearer <apiToken>`；ingest token 调 Lead 面 → 401 并审计。
- 每个认证拒绝写 `qa_room_audit`（`actor_kind=unverified`）。

### 3.3 路由

runner 面（`/qa-rooms/*`）：`POST /deploy`、`GET /:roomId`、`POST /:roomId/teardown`、`GET /by-request/:requestId`（找回响应丢失的房）。
Lead 面（`/api/qa-rooms/*`）：`GET /`、`GET /:roomId`、`POST /:roomId/teardown`（代拆；`--accept-missing-snapshot --reason` 仅此面可用）。Lead 不能 deploy。
非 owner 的 runner 查询 / 拆他人房 → `room_not_owned` + 审计（不回显日志）。

### 3.4 参数校验（边界，R1-#5）

- `slot` / extra slots：∈ `test-slots.json`；`expectHead`：`/^[0-9a-f]{40}$/` + §0 祖先校验；`mode` 枚举；`extra-lead`：`^\d+:[a-z][a-z0-9-]{0,31}$`；`seed`：枚举白名单。
- **TEST_* 逐键白名单**（未知键默认拒绝）：`TEST_REPLY_BY_ISSUE ∈ {0,1}`、`TEST_QA_ROOM_SERVICE ∈ {0,1}`。路径、配置目录、插件、token 类键（如 `TEST_LEAD_CLAUDE_CONFIG_DIR`、`TEST_API_TOKEN`、`TEST_INGEST_TOKEN`、`TEST_BOT_TOKEN_*`）一律 `invalid_param`；需要的 token 由服务生成，只以引用形式记录。
- 负向守卫：任一字段含 `com.flywheel.` → `production_label_refused`。

### 3.5 拒绝原因（单一枚举 `QA_ROOM_REFUSALS`，审计 / HTTP / CLI 共用）

`unauthenticated` · `runner_role_refused` · `exec_not_running` · `room_not_owned` · `slot_busy` · `slot_unknown` · `bad_expect_head` · `invalid_param:<field>` · `production_label_refused` · `tool_unavailable:<name>` · `idempotency_conflict` · `room_busy` · `room_service_disabled` · `room_service_draining` · `snapshot_failed` · `snapshot_missing_unobserved` · `probe_error` · `source_protocol_unsupported` · `room_quarantined` · `identity_uncertain`。

### 3.6 CLI（R1-#9/#10，R2-#6）

```
flywheel-comm room deploy --slot <n> --expect-head <sha> [--mode slot|mirror|roundtable]
     [--generalized] [--codex-runner] [--extra-lead <slot>:<dept>]... [--seed <flag>]...
     [--env TEST_X=v]... [--wait]
flywheel-comm room status <roomId> [--json]
flywheel-comm room teardown <roomId> [--lead [--accept-missing-snapshot --reason <text>]] [--wait]
```

- 请求日志根：新专用变量 `FLYWHEEL_QA_ROOM_REQUEST_DIR`，由 dispatcher 在 fresh/retry 位点经 `BlueprintContext` 显式注入两种 adapter，值 = `~/.flywheel/runner-state/<execId>/qa-room-requests`（exec 作用域，在 Codex 可写根内）；**不复用** `FLYWHEEL_RUNNER_STATE_DIR`（其 mailbox/commdb 语义不变）。变量缺失时 fallback 为由 `FLYWHEEL_EXEC_ID` 推导的同一路径，校验可写，不可写 → exit 1。
- CLI 首次请求前生成 `requestId` 并落盘 `<requestDir>/<requestId>.json`（temp+rename，同 `request-review`）；CLI 重启后按未完成的落盘记录继续使用同一 requestId；有界重试同一 requestId；响应丢失后用 `/by-request/:requestId` 找回。服务端：同 owner + 同 `request_hash` → 返回同一 room/op；hash 不同 → `idempotency_conflict`。
- 退出码：0 成功 / 已受理；2 被拒；3 服务关闭或 drain；4 Bridge 不可达；5 异步操作失败（`deploy_failed|teardown_failed`）。`--wait` 按 **opId** 等到该操作终态，不因短暂读到 `ready` 判拆房完成。

## 4. 物理 claim 协议（R1-#2，R2-#2/#3）

**claim 形态**：锁路径仍是 `/tmp/flywheel-test-slot-<N>.lock`（手工流程的 `mkdir` 锁不变）。服务 claim 是该路径上的**符号链接**，指向预先写好的服务目录 `SERVICE_ROOT/claims/<roomId>/slot-<N>/`，内含 `owner`（`service:<bridgeInstanceId>:<roomId>:<sha256(claimToken)>`）与 `pid`（内容 `service`）。注意：`pid=service` **本身不提供**兼容保护——旧脚本的"非空且 `kill -0` 失败即 stale"判定会把它当死 PID；安全性完全依赖本节下方"所有入口先识别 `service:` owner + token 校验"的新 guard（覆盖实现基线全部入口），guard 测试用 `pid=service` 作 fixture。未升级的旧脚本不会自动尊重服务 claim——由 §0 协议版本门（`source_protocol_unsupported`）保证服务只调用已升级的 checkout。claimToken 明文只存 `SERVICE_ROOT/claims/<roomId>/token`（0600），DB 存 hash。

**原子不覆盖发布（R3-#1）**：`symlink(target, lockPath)` 是单个系统调用，路径已存在（手工 `mkdir` 出的空目录、别的锁、任何东西）即 `EEXIST`，**绝不替换**既有目标；成功时 owner 负载已随目标目录一并可见（目标目录在 symlink 前写完）。反之手工 `mkdir lockPath` 遇到服务 symlink 也 `EEXIST` → 视为占用。不使用 `rename`。
- 残留风险（诚实）：`/tmp` 对 Codex runner 可写，runner 理论上能删锁 symlink——与今天手工锁同级；服务在每个破坏性步骤前 `readlink` 复核，锁丢失 → room `quarantined:claim_lost` 并告警，不继续删除。

**获取序列（intent-first）**：
1. DB：room `claiming` + `planned_slots_json`（升序）+ token hash（事务提交后才有副作用）。
2. 按序逐 slot `symlink` 发布；任一 `EEXIST` → 回滚本 room 已发布的锁（只删 `readlink` 指向本 room 目录者）→ `refused/slot_busy`，`claimed=0`，**无任何 teardown 权**。
3. 全部成功 → `claimed=1` → 进入 §5 launch。
- 重启恢复 `claiming`：逐 planned slot `readlink`——指向本 room 目录 → adopt；不存在 → 未发布；其他 → 不属于本 room。然后若 owner exec 仍有效则继续补发布，否则整组回滚 → `canceled`。因为发布是单调用，不存在"半发布、无主"的锁。

**所有入口一致识别服务 claim（与调用者是否带 token 无关）**：`test-deploy.sh` 的 claim / stale reclaim、失败 trap、`campaign_abort`、borrowed-lock cleanup，`test-teardown.sh` 的主锁与 borrowed 锁删除，以及实现基线中存在的多 Lead helper（`scripts/lib/qa-multilead.sh`）——凡见 owner 以 `service:` 开头：
- 有 `FLYWHEEL_QA_SLOT_CLAIM_TOKEN` 且 hash 匹配 → 允许按服务模式运行（deploy 不自抢锁；teardown 清理但**不删锁**）；
- 否则 → 拒绝，打印 `slot <N> is owned by the QA room service (room <roomId>); use: flywheel-comm room teardown <roomId> --lead`，退出非零；**绝不**以 PID 死亡为由回收。
- 兼容范围明确为"非服务 claim 的手工房保持原行为"。

**释放**：residue 为空且快照回执齐全后：DB `releasing` → 删全部 owner 匹配的锁 → 删 claims token 与 `SERVICE_ROOT/src/<roomId>`（`git worktree remove --force` 于镜像）→ `torn_down`；崩溃后按 `releasing` 重放。

**多 Bridge**：互斥由物理锁目录保证；DB 只记录本 `bridgeInstanceId` 的 claim。

## 5. 操作执行与恢复（R1-#6）

- **op-runner 包装器** `scripts/lib/qa-room-op.mjs`（Bridge 已安装代码的一部分）：由 Bridge `spawn(process.execPath, [wrapper, opSpecPath], {env: minimalEnv, detached: true, shell: false})`；包装器负责物化 checkout、pnpm install + build、跑脚本、记录阶段、最后**原子写回执** `<opDir>/receipt.json`。
- **launch 交接（R2-#3）**：
  1. DB：op `launching`（`op_dir` 已定）提交后才 spawn。
  2. 包装器第一件事：把完整、不可变的启动记录（`kind:wrapper, pid, lstart, pgid`，含校验和）写入私有临时文件 `started.<pid>.tmp` 并 fsync，再 `link(tmp, <opDir>/started)`——`link` 原子且**不覆盖**（目标存在即 `EEXIST`），成功即意味着完整记录已可见（R3-#2）。**在 link 成功前不做任何副作用**；`EEXIST` → 删自己的 tmp，立即退出、无副作用。
  3. Bridge 读到有效 `started` 后写 op `running`（pid/pgid）。
  4. 恢复 `launching`：Bridge 以同样方式写完整 `kind:fence` 记录再 `link` 到 `started`——Bridge 赢 → 包装器的 link 必然失败而退出，op `fenced`，以新 attempt/新 op_dir 重派；包装器赢 → 读其记录按 running adopt。`started` 只可能是两种完整记录之一；`*.tmp` 残片不参与裁决，恢复时清理。校验和不符的 `started`（理论上不可能，防御）→ room `quarantined`。
- **预登记进程组与"不再产生资源"条件（R2-#4，R3-#3）**：Bridge 以 `detached:true` 启动包装器，包装器自身即新进程组 leader，**pgid = 包装器 pid**，在第 2 步的启动记录里随 link 一起发布——即在任何子进程存在之前已登记。包装器启动的所有创建者（git fetch/worktree、`pnpm install`、build、`test-deploy.sh`/`test-teardown.sh`）一律**不** detached，留在同一进程组。于是"失联后找不到创建者"的窗口不存在：只要该 pgid 还有成员，组 ID 就不会被复用；组内无成员即证明所有创建者已退出。包装器只在 `waitpid` 到脚本退出**且**本组除自己外无存活成员后才写成功/失败回执——回执即"本操作不会再创建资源"的提交。自行 `setsid` 出去的房间进程（如房内 Bridge）是**资源**，由 §6 residue 覆盖，而非创建者。
- **op 归属证明（R4-#1）**：包装器生成随机 `opNonce`（写入启动记录），并以 `FLYWHEEL_QA_OP_NONCE=<opNonce>` 放进传给所有创建者的 env。一个进程"属于本 op"当且仅当：它在进程组 P（= 登记的 pgid）中、`lstart ≥ A`（包装器启动时间），**且** `ps -E -ww -o command= -p <pid>`（同用户进程可读）显示的环境含该 nonce。**组号相等永远不足以授权发信号。**
- **失联屏障**：包装器消失且无回执 → op `supervisor_lost`，room `quarantined`（不是 `deploy_failed`）。每次 tick（含首次）按下表裁决，**每次 TERM、每次 KILL 之前都重新计算**，只对逐个通过证明的 pid 单独 `kill(pid, sig)`，**从不** `kill(-pgid)`：

| 观察 | 裁决 | 动作 |
|---|---|---|
| `ps -g P` 为空 | 原组已消失 | 转 `deploy_failed`，开放屏障 |
| pid P 当前存在但 lstart ≠ A | 已确认编号复用（组 ID 只能由 pid P 的进程创建，原 leader 已死即说明原组早已清空） | 不发任何信号；视为原组已消失，开放屏障；新组不阻塞本 op |
| 组内有成员通过归属证明 | 原组仍有已验证成员 | 仅对这些 pid TERM →（下个 tick 重新证明）→ KILL；直到无已验证成员 |
| 组内有成员但全部**明确不含** nonce | 非本 op（leader 死后编号被复用、新 leader 又死） | 不发信号；视为原组已消失 |
| 某成员环境不可读 / 探测出错 | 归属无法证明 | 不发信号；保持 `quarantined`，room 标 `identity_uncertain` 并告警；claim 保留；Lead 核实后可 `room teardown --lead --accept-identity-uncertain --reason` 放行并审计 |

  超时同样走此流程。房内 `setsid` 出去的资源进程（如房内 Bridge）同样继承 nonce，residue()（§6）用同一证明识别它们。
- **串行化**：`UPDATE qa_rooms SET active_op_id=? WHERE room_id=? AND active_op_id IS NULL` CAS；deploy 进行中收到 teardown → teardown op 记为 `pending` 并在 deploy op 终态后执行（屏障），不并发。所有回写带 `(op_id, attempt)`，旧 attempt 回写被丢弃。
- **toolDirectories**：必需 `bash node pnpm git jq tmux python3 gh sqlite3 claude`，`--codex-runner` 另需 `codex`；在 Bridge 的 `PATH` 上解析真实路径取目录去重 + `/usr/bin:/bin:/usr/sbin:/sbin`；缺失 → `tool_unavailable:<name>`，不 spawn。零写死用户路径。该 PATH 同时传给脚本、launchd plist env 投影（脚本用 `PATH` 生成 plist `EnvironmentVariables`，测试断言投影结果含 codex 目录）。
- **minimalEnv**：`HOME USER LOGNAME TMPDIR LANG PATH` + 白名单 TEST_* + `FLYWHEEL_QA_DEPLOY_ID` + `FLYWHEEL_QA_SLOT_CLAIM_TOKEN`；`TEST_QA_ROOM_SERVICE=1` 由 `test-deploy.sh` 映射为房内 Bridge 的 `FLYWHEEL_QA_ROOM_SERVICE=1`（R1-#11，脚本改动 + env 投影测试）。
- **pretrust**：`--codex-runner` 房的 workspace 预信任（`$HOME` 根锁）在包装器内、沙箱外完成（沿用现有 pretrust 脚本，若存在）。
- **重启恢复矩阵**（Bridge 启动 + 既有周期 tick piggyback，零新 timer）：

| 持久状态 | 观察 | 处置 |
|---|---|---|
| room `requested`，op `pending`，未 spawn | — | 重新校验身份/凭据/claim 后 spawn；owner 已终态 → `canceled`（释放本服务 claim） |
| room `queued` | 每 tick | 重新校验身份、凭据、负载；owner 终态 → `canceled` |
| op `running` | 有回执 | 按回执落终态 |
| op `running` | 无回执，pid+lstart 匹配存活 | 保持 running，tick 复查；超 `deadline_at` → 按进程组 TERM→KILL，确认退出后 `failed:timeout` |
| op `launching` | — | §5 launch 交接第 4 步 `link()` 裁决 |
| op `running` | 无回执，pid 死或化身不符 | `supervisor_lost` → room `quarantined` → pgid 屏障确认后 `*_failed`；快照策略按"未完整观测" |
| room `claiming` | — | §4 恢复 |
| room `releasing` | — | 重放删锁 → `torn_down` |

- 探测工具（ps / lsof / launchctl）自身出错 → `unknown`，拆房判 `teardown_failed:probe_error`，**不**当无残留。

## 6. 快照与残留

**DB 坐标（R2-#5，R3-#4）**——区分两类：
- **预期库（expected）**：deploy 开始前由物化 checkout 的 `test-teardown.sh <slot> --list-db-coordinates`（协议 v1 新增：打印本布局**会创建且会删除**的 DB，每行 `role path`，不执行删除）得出，写入 `db_coords_json`。缺失规则只对预期库生效。
- **发现候选（discovery）**：静态兜底 `slot 根 teamlead.db`、`state/comm/<project>/comm.db`、`$HOME/.flywheel/comm/<project>/comm.db`（单数 `comm`）。候选中**现存**的库一律快照；**不存在的候选直接忽略**，不触发缺库规则——不适用的另一种布局不会阻塞拆房。
- **每次** teardown 前重新探测两类。测试 fixture：新、旧布局各只建本布局实际使用的库，owner 首次 teardown 均无需 Lead；只在正确 `comm` 路径建库、错误 `comms` 路径不存在 → 必须先导出再清理；只建 CommDB 场景同测。

**规则**（R1-#7）：
1. 任一现存 DB → 必须快照：`sqlite3 <db> ".backup <dest>"`（一致性含 WAL）到 `~/.flywheel/qa-evidence/qa-rooms/<roomId>/<opId>/`，逐文件 sha256 写 `qa_room_snapshots` 回执；任一失败 → `snapshot_failed`，不拆。
2. 逐库：某库当前不存在，但本房此前 teardown op 对**该库坐标**有快照回执且回执文件 sha256 复核通过 → `already_taken:<opId>`，该库放行（QA@2 "物理已清再拆"场景）。不能用别的库或别房的回执推导。
3. 逐**预期**库：不存在、无回执，且 deploy op 有完整回执、阶段文件证明脚本**从未对该库写过** `db_init:<role>`（服务模式下 `test-deploy.sh` 在创建每个 DB 前向 `FLYWHEEL_QA_PHASE_FILE` 追加 `db_init:<role>`，包装器把阶段文件并入回执）→ `skipped:no_db_created`（QA 返工 2 "建库前失败"场景，无需 `--skip-snapshot`）。"没采样到"不算证明。
4. 其余预期库缺失（已写过该库的 `db_init` 但库缺失且无回执；或 deploy 未完整观测）→ `snapshot_missing_unobserved`，拒拆；仅 Lead `--accept-missing-snapshot --reason` 可放行并审计。
5. 多库中任一快照失败 → 整体 `snapshot_failed`，已成功的库回执保留，不拆。

**residue()**（QA@2 HIGH-1）：只认房间归属集合——带本房任一 op nonce 的进程（§5 归属证明）、`launchd_labels_json` 中每个**精确** label（主 slot + extra slots，deployId 绑定）的 `launchctl print gui/<uid>/<label>` 存在、`lsof -iTCP:<slotPort> -sTCP:LISTEN`、`lsof -d cwd` 在房间目录内的进程。**命令行文本永不参与**。为空 → 进入 §4 释放流程 → `torn_down`。

**幂等收尾**：`teardown_failed` 房可由 owner 或 Lead 重拆；重拆从快照规则 1 开始重新走，residue 为空即释放 claim。

## 7. 拆房坑（R1 补充）

- 陈旧 launch marker：`test-deploy.sh` 写 marker 时写入 `FLYWHEEL_QA_DEPLOY_ID`；所有读者（本快照为 `test-teardown.sh`；实现基线若含 `scripts/lib/qa-launchd-lead.sh` 一并改）只在 deployId 匹配时判 `runtime_started`。
- 死 Codex socket 软链：reaper（本快照 `test-teardown.sh`；基线若含 `scripts/lib/qa-reap-codex-slot-daemons.mjs` 一并改）区分三态：目标不存在或 `lsof -U` 确认无持有者 → 死，删软链 + 审计；有持有者 → 活；探测失败 → unknown（拒拆，不删）。

## 8. 分块与测试（先红后绿，只跑相关测试）

| 块 | 内容 | 测试 |
|---|---|---|
| C1 | `QaRoomStore` 五张表 + StateStore 接入 + 幂等迁移 | 状态机合法转移、CAS、幂等键、审计追加 |
| C2 | 能力凭据 + 请求目录变量：dispatcher 发放（fresh+retry）+ 双 adapter env 注入 + 撤销 | 从 `TmuxAdapter`/`CodexTmuxAdapter` 真实 env 构造取凭据；retry 旧凭据失效 |
| C3 | `qaRoomAuth` + 路由 + 参数白名单 + 负载门 + drain | 无 token / 两 token 相同→不挂载；ingest 调 Lead 面 401+审计；generic 角色 `runner_role_refused`；他人房 `room_not_owned`+审计；`TEST_LEAD_CLAUDE_CONFIG_DIR`/`TEST_API_TOKEN` 拒；生产 label 拒 |
| C4 | 物理 claim 协议 + 所有脚本入口识别服务 claim + 协议版本/`--list-db-coordinates`/阶段标记 | 两个独立 StateStore 抢同 slot；手工房占槽 → `slot_busy` 且不 teardown；**无 token 显式 teardown 服务房被拒**；**死 PID 不触发自回收**；borrowed slot；kill-at-boundary：symlink 发布前后、主→extra、claim→DB；**手工 claim 暂停在 mkdir 后 pid 写入前 → 服务抢同 slot 得 `slot_busy`、目录 inode 不变、无 service owner**（主 slot 与 extra slot 各测）；释放后崩溃重放；非服务 claim 手工行为字节不变（sentinel） |
| C5 | `SERVICE_ROOT` + 镜像物化 + 启动断言；op-runner 包装器 + launch 交接 + 进程组屏障 + toolDirectories + minimalEnv + 恢复矩阵 | **最小 env 中 codex 可解析且投影进 plist env**；缺 codex → `tool_unavailable:codex`；无写死路径；`SERVICE_ROOT` 落在可写根下 → 拒挂载；kill-at-boundary：spawn→tmp 写入中、tmp→link、started→running、commit→ack；link 裁决两种结局 + `*.tmp` 残片；**在子进程已创建、刚要执行副作用时杀包装器 → 重启 → teardown 请求 → 放行旧子进程 → 它已被 KILL，不产生新房资源，claim 最终释放（不永久 quarantine）**；**PGID 复用 fixture**（可控进程探测注入）：①重启前旧组消失 → 同 PGID 新 leader、不同 lstart；②TERM 后旧组消失 → KILL/下个 tick 前编号复用；③leader 死后新组成员不含 nonce——三者断言无关组收到的 TERM/KILL 为 0；④leader 已死、原 op 子进程仍存活（含 nonce）→ 安全停止后开放屏障；⑤环境不可读 → `identity_uncertain`、零信号；超时 |
| C6 | 快照 + residue + 幂等收尾 | **回归①** 外来进程命令行含房间路径 → 仍 `torn_down`；**回归②** 物理已清 + `teardown_failed` → 重拆成功、锁与 claim 释放；**回归③** 建库前失败 → `skipped:no_db_created`；只有 CommDB；WAL 未落盘数据被快照；部分快照失败拒拆；`supervisor_lost` 缺失回执拒拆 |
| C7 | 拆房坑：marker deployId、socket 三态 | `scripts/__tests__/qa-room-teardown-guards.test.sh` |
| C8 | CLI `flywheel-comm room` + `FLYWHEEL_QA_ROOM_REQUEST_DIR` 注入 | 退出码；requestId 落盘 + 响应丢失找回 + CLI 重启沿用；并发重复请求；`--wait` 按 opId；真实 Codex env 未继承 `FLYWHEEL_RUNNER_STATE_DIR` 仍可用；Claude commdb 模式；不可写路径 exit 1 |
| C9 | 指引：`agents/qa-executor.md`、`packages/qa-framework/agents/qa-parallel-executor.md`、Blueprint QA 节点一句"要房就调起房服务"；**不改 implement/engineer 提示词** | Blueprint 片段断言 |

依赖顺序：C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → C9。

## 9. 评估项（本单不实现）

- **e2e driver 代跑**：现有 driver 的 slot/CommDB 坐标契约与新布局不一致（R1-#8），需先修 driver 契约再做"受管 driver op"（绑定 issue/slot/manifest、超时、拆房前停止屏障）→ follow-up。本单 pretrust 在 deploy 包装器内完成，runner 在房内的"真验证"用自己能做的手段（访问房内 Bridge health、跑房内 runner 流程）。
- **codex:rescue / 嵌套诊断**：同一"受管 op"模式可承载，但会把模型会话带出沙箱，风险面更大 → follow-up，`qa_room_ops.kind` 预留扩展位。

## 10. 验收、回滚、R1 处理表

**QA 判据**：精确头 full CI 全绿；房内 Codex runner 尝试写 `SERVICE_ROOT` 被拒（EPERM）；外层房 N 由 Lead 起（`--generalized --codex-runner`，`TEST_QA_ROOM_SERVICE=1` → 房内 Bridge 启用服务）；房内真 Codex runner 只用 `room deploy|status|teardown` 起内层房 M、做一项真验证、拆房零残留；Claude runner 同样走通；INTRUDER `room_not_owned`；generic 节点 `runner_role_refused`；拆房期间宿主挂一个命令行含房间路径的观察进程 → 仍 `torn_down`。

**回滚**：`FLYWHEEL_QA_ROOM_SERVICE=drain` → 拒新 deploy，保留 status/teardown 让既有房收尾；`=0`/未设 → 若库中无非终态房则不挂载，否则启动时自动按 drain 运行并告警，直到非终态房归零（启动时读取，改值需重启 Bridge）。代码回滚 = revert PR（先 drain 至零）。

| R1 项 | 处理 |
|---|---|
| #1 可信执行面 | §0 信任模型 + 服务物化 checkout + 祖先校验 |
| #2 物理 claim | §4 |
| #3 双 adapter 凭据 | §3.1 / C2 |
| #4 认证 fail-closed | §3.2 |
| #5 TEST_* 白名单 | §3.4 逐键 |
| #6 恢复与并发 | §5 包装器 + 回执 + CAS + 恢复矩阵 |
| #7 逐库快照 | §6 |
| #8 driver | 移出本单（§9），pretrust 保留 |
| #9 幂等键 | §3.6 |
| #10 status 凭据 | header 凭据 + `/by-request` |
| #11 开关映射与回滚 | §5 映射 + §10 drain |
| R2-#1 物化目录可写 | §0 `SERVICE_ROOT` + 自有镜像 + 启动断言 + EPERM 实测；Claude 边界诚实写明 |
| R2-#2 所有入口识别服务 claim | §4 |
| R2-#3 崩溃交接 | §4 symlink 发布 / intent-first；§5 `link()` launch 交接；`bridgeInstanceId` |
| R2-#4 失联子树屏障 | §5 进程组 + `quarantined` + 回执提交条件 |
| R2-#5 CommDB 坐标 | §6 `--list-db-coordinates` + 单数 `comm` + fixture |
| R2-#6 请求日志根 | §3.6 `FLYWHEEL_QA_ROOM_REQUEST_DIR` |
| R3-#1 不覆盖发布 | §4 symlink 锁（EEXIST 语义）+ 手工 claim 暂停测试 |
| R3-#2 启动身份原子 | §5 完整记录 + `link()` 不覆盖发布 |
| R3-#3 预登记进程组 | §5 包装器 = 组 leader，pgid 随启动记录发布，创建者不 detached |
| R3-#4 非适用 DB 坐标 | §6 预期库 vs 发现候选；逐库 `db_init:<role>` |
| R4-#1 历史 PGID 复用 | §5 nonce 归属证明 + 五分支裁决表 + 逐 pid 发信号前复核 + fixture ①–⑤ |
| R4-#2 pid=service 说明 | §4 更正：安全性只来自新 guard + 协议版本门 |
| R2 澄清 | 精确 label 集合；阶段标记替代采样；逐库回执复核；协议版本拒绝；源 checkout 纳入释放 |
