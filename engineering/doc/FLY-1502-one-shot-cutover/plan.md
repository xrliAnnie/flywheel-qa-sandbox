# FLY-1502 一次性切换(九步 stop-the-world) — 实施计划
Issue: FLY-1502 (https://linear.app/geoforge3d/issue/FLY-1502/v2批次3-一次性切换-九步-stop-the-world-gono-go-十条-旧系统冻结围栏)
日期: 2026-07-28
基于: research.md(Codex design review R1 修订版)

## 0. 权威与边界

- 设计权威:design-FINAL-v2.md §4(+§0.5/§1.2/§1.5)+ design-chain design-v1/v2/final §4。
  **九步编号与标题逐字继承,不重排不替换**(Codex R1-1):①预演 ②冻结 ③停全部旧写者
  ④一致快照 ⑤迁移 ⑥安全重置 ⑦epoch fence ⑧顺序启动 ⑨回滚点;消息通道切换并入步 2-6;
  实弹测试与 Go/No-Go 检查是**步 7 完成后、步 8 上电授权前的强制子闸/证据**,不是新步。
- Go/No-Go 十条逐字保留;④⑤按 actions 模型映射证据(research §5);另加两项证据:
  围栏/新路径不相交(Lead 裁定 4;上电后零旧写升为步 8 后 acceptance gate,见 §4.6)+
  GitHub lane 探针(FINAL-v2 §4 保持项)。
- Lead 裁定六点(research §0)全部为硬约束。
- **不在本单**:物理删旧码(1503)、Linear 自动 admission ingress(1503 族账)、
  legacy agent 收养 API / payload 列提升 / generic task-effect lane / 多 shippable
  (1503 族账)、StateStore 收敛(1503+)。
- 回滚合同:T1 运行时回滚(步⑨锚;§4.7 水位合同)/ T2 整仓回 main@37bcb8e2(仅当前
  main 旧路径本身坏)/ 首个 v2 外部副作用后 forward-repair。
- **founder 在场硬要求**:B 段不可无人值守;每个不可逆步 founder 明示;隔离预演不可跳过。

## 1. 交付物总览(6 个工作块)

| 块 | 内容 | 新代码落点 |
|---|---|---|
| W1 | v2 常驻接线:host daemon + runtime protocol + agent CLI + Discord 入站 enqueue + admission/approval 入口 | `packages/v2-host`(bin flywheel-v2-host)+ `packages/v2-cli`(bin flywheel-v2)+ thin Bridge B 换写点 + v2-dag sessionRef 映射 port |
| W2 | GitHub lane 探针(non-admin + required-checks,fail closed 保 v1 lane) | `packages/v2-cli`(probe 子命令) |
| W3 | cutover CLI:九步 ledger + 双源对账迁移器 + 归档 + 三重围栏装卸 + 实弹 harness + Go/No-Go checker + T1 回滚 | `packages/v2-cutover`(bin flywheel-v2-cutover) |
| W4 | 机器级 cutover authority + 全 entrypoint 旧 writer 禁用矩阵 | `~/.flywheel/v2-cutover-authority.json` + 各 composition root 检查点 |
| W5 | 隔离预演(target manifest 全控制面隔离)+ 验收测试矩阵 | scripts/rehearse-v2-cutover.sh + 各包 __tests__ |
| W6 | 切换 runbook(founder 视角步卡) | engineering/doc/FLY-1502-one-shot-cutover/runbook.md |

## 2. W1 常驻接线

### 2.1 `packages/v2-host`(运行协调器宿主,launchd `com.flywheel.v2-engine`)
组合根职责:
1. **开库=open-existing-only**(Codex R1-5 / R4-1):核对 realpath、cutover window id、
   cutover_epoch、**精确有序 migration manifest(ID+checksum 全序,止于 0009)**、
   迁移完成 marker、0600/0700 权限;任一不符**拒绝启动**,绝不自行 migrate。全部
   创建/promote/backup/open 点共享同一 manifest 常量,**禁止各处硬编码条数**;
   0001-0008 库(缺 0009)必须被 host/scheduler/CLI/promotion/Go-No-Go 五处一致拒绝
   (fixture)。fresh bootstrap 只允许 cutover/rehearsal 工具调用(§4.3);
   **v2-scheduler cli 的无条件 migrateDatabase 同步改为 open-existing 校验**。
2. EngineDriver 实例化。**8a 阶段只 provision 收件地址(provisionAgentRecipient),
   不注册 Lead**(R4-4:此时无活会话证据);Lead 注册/reattach 在 8b 该 Lead 会话
   真实启动、进程/会话证据可采集时进行。
3. 四循环接线:dispatchOnce 周期 tick、mailbox 冷启动、heartbeat stale→v2-scheduler、
   风暴刹车(restart-storm-gate,wrapper 插入点同 FLY-1501 合同)。
4. v2-dag ports 实现(spawn 复用现有 tmux 基建;角色数据文件合同 FLY-1520 §10)。

### 2.2 端到端 runtime protocol(Codex R1-2 / R2-1 / R2-2;实现前冻结的合同)
- **结算唯一 owner=host EngineDriver**(R2-2 / R3-1):批次 2 现实=driver await
  Converter 后自己调 submitProposal/reportConversionFailure,包级 submitProposal 直接
  结算且无 durable proposal 队列。冻结形态:**authenticated host IPC**(host 私有
  unix socket),**响应边界=hold-until-settlement**(R3-1,消灭受理即回执的崩溃窗):
  CLI 提交 attempt 绑定 proposal → host 内等待中的 Converter 取走 → EngineDriver
  结算事务 commit(mailbox applied + processing_attempt settled 同事务=durable 回执
  本体)→ **之后才回 IPC 响应**。重试合同:CLI 有界重试;重试先查 durable 结算回执
  (键=attempt_uid+message_uid+proposal_digest):同 digest→返回成功;异 digest→拒。
  host 在响应前任意点崩=CLI 未见成功、继续重试到新 host(attempt 恢复按批次 2
  processing_attempts 协议),无"已回执但未结算"的孤儿态。
  **durable 载体冻结**(R4-2 / R5-2,normative DDL 与映射):
  - **0009 DDL(可执行 SQL,normative;R6-1。SQLite 不能事后 ADD CONSTRAINT,
    全部不变量以 trigger 落地;初始约定对齐真实注册事务:provision=generation 0,
    注册≥1)**:
    ```sql
    -- fresh-staging-only 断言:populated-0008 升级 fail loud(CHECK(x=0) 承接
    -- count>0 即 abort;SQLite RAISE 只能在 trigger 内,故用 guard 表)
    CREATE TABLE schema_guard_0009(x INTEGER NOT NULL CHECK (x = 0));
    INSERT INTO schema_guard_0009(x)
      SELECT count(*) FROM agents WHERE generation >= 1;
    DROP TABLE schema_guard_0009;
    ALTER TABLE agents ADD COLUMN instance_id TEXT NULL;
    ALTER TABLE agents ADD COLUMN session_binding TEXT NULL;
    CREATE TRIGGER agents_binding_insert_guard BEFORE INSERT ON agents
    WHEN (NEW.instance_id IS NULL) <> (NEW.session_binding IS NULL)
      OR (NEW.generation = 0 AND NEW.instance_id IS NOT NULL)
      OR (NEW.generation >= 1 AND NEW.instance_id IS NULL)
      OR (NEW.session_binding IS NOT NULL AND NOT (
            json_valid(NEW.session_binding)
        AND (SELECT count(*) FROM json_each(NEW.session_binding)) = 5
        AND json_type(NEW.session_binding,'$.v') = 'integer'
        AND json_extract(NEW.session_binding,'$.v') = 1
        AND json_type(NEW.session_binding,'$.host_epoch') = 'text'
        AND length(json_extract(NEW.session_binding,'$.host_epoch')) > 0
        AND json_type(NEW.session_binding,'$.session_id') = 'text'
        AND length(json_extract(NEW.session_binding,'$.session_id')) > 0
        AND json_type(NEW.session_binding,'$.pid') = 'integer'
        AND json_extract(NEW.session_binding,'$.pid') > 0
        AND json_type(NEW.session_binding,'$.pid_start') = 'text'
        AND length(json_extract(NEW.session_binding,'$.pid_start')) > 0))
    BEGIN SELECT RAISE(ABORT,'agents binding invariant violated'); END;
    CREATE TRIGGER agents_binding_update_guard BEFORE UPDATE ON agents
    WHEN (NEW.instance_id IS NULL) <> (NEW.session_binding IS NULL)
      OR NEW.generation NOT IN (OLD.generation, OLD.generation + 1)
      OR (NEW.generation = OLD.generation AND (
            NEW.instance_id IS NOT OLD.instance_id
         OR NEW.session_binding IS NOT OLD.session_binding))
      OR (NEW.generation = OLD.generation + 1 AND (
            NEW.instance_id IS NULL OR NEW.session_binding IS NULL
         OR (NEW.instance_id IS OLD.instance_id
             AND NEW.session_binding IS OLD.session_binding)))
      OR (NEW.session_binding IS NOT NULL AND NOT (
            json_valid(NEW.session_binding)
        AND (SELECT count(*) FROM json_each(NEW.session_binding)) = 5
        AND json_type(NEW.session_binding,'$.v') = 'integer'
        AND json_extract(NEW.session_binding,'$.v') = 1
        AND json_type(NEW.session_binding,'$.host_epoch') = 'text'
        AND length(json_extract(NEW.session_binding,'$.host_epoch')) > 0
        AND json_type(NEW.session_binding,'$.session_id') = 'text'
        AND length(json_extract(NEW.session_binding,'$.session_id')) > 0
        AND json_type(NEW.session_binding,'$.pid') = 'integer'
        AND json_extract(NEW.session_binding,'$.pid') > 0
        AND json_type(NEW.session_binding,'$.pid_start') = 'text'
        AND length(json_extract(NEW.session_binding,'$.pid_start')) > 0))
    BEGIN SELECT RAISE(ABORT,'agents binding transition violated'); END;
    ALTER TABLE processing_attempts ADD COLUMN proposal_digest TEXT NULL;
    CREATE TRIGGER pa_receipt_insert_guard BEFORE INSERT ON processing_attempts
    WHEN NEW.outcome <> 'running'
      OR NEW.settled_at IS NOT NULL
      OR NEW.proposal_digest IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'processing_attempt must start running without receipt'); END;
    CREATE TRIGGER pa_digest_transition_guard BEFORE UPDATE ON processing_attempts
    WHEN (OLD.outcome <> 'running')
      OR (NEW.outcome = 'running' AND (
            NEW.proposal_digest IS NOT NULL OR NEW.settled_at IS NOT NULL))
      OR (NEW.outcome = 'succeeded' AND (
            NEW.settled_at IS NULL OR NEW.proposal_digest IS NULL))
      OR (NEW.outcome IN ('failed','crashed') AND (
            NEW.settled_at IS NULL OR NEW.proposal_digest IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'processing_attempt receipt immutability violated'); END;
    ```
    以上 SQL 块即 0009 全文,**单一权威、原样入迁移文件**(R8-1:无"未来更强版本",
    验收执行的就是这段)。
    语义钉死:generation 0(provision)binding 必空;注册/换代行 binding 必非空且
    **严格** JSON(恰 5 键、逐键类型、非空身份、pid 定义域);同 generation 改
    binding=拒;generation 只允许 +1 且 binding 元组**必须变更**(R7-1);running 行
    插入必无 settled_at/digest;succeeded 结算**必须同时**置 settled_at+非空 canonical
    digest,failed/crashed 保持 digest 空;settled 行整行不可再改。0005 既有
    generation 单调 trigger 逐字保留。**升级策略钉死(R7-1)**:生产/预演只走 fresh
    staging 全序迁移——0009 迁移体断言 agents 表无 generation>=1 行,**非空 0008 库
    升级=fail loud 拒绝**(不做 grandfather);populated-0008 升级拒绝案入直接 SQL
    验收矩阵。**验收=真跑 0001-0009 迁移后对每条不变量发直接非法 SQL**(含 R7 四
    反例:宽松/错型 JSON、换代不换 binding、running INSERT 带 digest、succeeded 无
    digest;不只测 typed API)。
  - **issuer 定义**(R6-1):capabilities.issuer=**投递 recorded action 的 durable
    action id**(supersede 后=后继 action id)——capability 权威与投递动作一一对应,
    不留实现分歧。
  - **digest 由 host canonical 计算,绝不信 caller**;重试查询=按 attempt_uid/
    message_uid 读 settled 行比对 digest。
  - **capability 完整映射**(复用现有 capabilities 表,行+命名绑定查询**共同**构成
    token 绑定):action='submit_proposal';audience=agent_id;attempt_generation=
    generation;subject_digest=**版本化 canonical v1 digest of {attempt_uid,
    message_uid, agent_id, instance_id, generation, activation_id|null}**(全绑定
    元组入 digest);库存 token hash,raw 只活在注入 envelope。**消费事务顺序
    (逐字)**:(1) 按 hash(raw) 查 capability 行 (2) 精确核 issuer/audience/action/
    attempt_generation (3) host 从结算上下文重算 expected subject_digest 并比对
    (4) join processing_attempts(该 attempt_uid 的 running 行)+ activations
    (runner 时 active 行)完成绑定核验 (5) `FENCE.capabilityConsume` CAS
    (6) settle CAS 写 digest(immutable 回执)+ 库内产出+mailbox applied 同事务。
  - Lead token 绑 {agent_id,instance_id,generation,attempt_uid,message_uid};
    runner 额外绑 activation_id——attempt_uid 在 digest 内,旧 attempt token 对后续
    attempt 结构性无效。caller 自报身份字段一律不作凭据。**测试**:DDL 负例(同
    generation 改 binding 拒 / digest 二写拒)+ stale-instance/stale-activation
    token 拒。proposal 大小校验;投递 action 的 invocationUid 稳定派生(§1.2 三支柱)。
  **intended 投递对账**(R4-3 / R5-1;不违背 actions 黑匣子"重放不重做"):host 崩溃
  留下 `intended` 投递 action 时,重放只返回既有事实、**绝不自动重投**;backend
  证据探针**逐个冻结,fail-closed(探针自身失败=ambiguous,永不判 absent)**:
  - **claude 探针=sidecar/主文件/fingerprint 真值表**(对齐既有 writer 三步序:先
    pending sidecar→写主文件→finalize sidecar,及既有 pending-record 修复语义):
    delivered=主文件存在匹配条目且 fingerprint 合(finalized,或 pending 经既有
    probe 对主条目+fingerprint 校验后修复为 finalized);absent=**仅在持排他锁+
    writer 进程确证死亡前提下**主文件无条目且无匹配 pending 记录才成立;
    fingerprint 不合=conflict→manual;其余(锁不可得/文件不可读/pending 无法核)
    =ambiguous。
  - **codex 探针=CodexTurnExecutor seam**(不存在 inbox 文件;sessionRef 只有
    socketPath+threadId):v2 daemon client 扩展为投递时携带稳定投递关联 id
    (message_uid 派生)作 `clientUserMessageId`,探针经 `thread/read` 严格匹配解析
    该 id;RPC 错误/形状不符/身份不符=**ambiguous,绝不当 absent**(否则重复 turn)。
  证据=delivered→按原 capability 等 proposal(accepted);证据=conclusive absent→
  **有证据 supersede**:同事务 revoke 旧 capability+mint 新 token+新 invocationUid+
  supersedes_action_id+retry_basis 的后继投递;ambiguous→typed/manual,不自动重投。
  token 跨崩溃存活:未投递=hash 行在库、raw 随 supersede 重 mint;已投递=raw 在
  envelope 里。**fixture 覆盖每个证据态**(delivered/absent/conflict/ambiguous ×
  两 backend),不只两个崩溃位点。
  **测试**:收到后崩 / 结算后响应前崩 / 并发同 payload 重复 / 并发异 payload 拒 /
  跨 agent 冒名(token 错绑)/ 旧 attempt token 打新 attempt 拒 / intent 后效果前崩+
  效果后 outcome 前崩 × claude/codex 两 backend 全负例。
- **runner 消费**(R2-2):attachRunner 无 Converter、poll 仅在有 Converter 时起自动
  handler——**host 为 runner 显式起独立 delivery loop**(kernel timer 实际查询+
  durable deliver 合同,设计 §1.2a),不冒用 lead handler 路径;需要的 driver API
  增量在 v2-engine 内新增(不改既有 lead 语义)。
- **投递=recorded action**:intent→事务外执行→outcome;崩溃语义遵循 §1.2e(intent 前
  崩=重投;效果后 outcome 前崩=intended 诚实窗)。
- **sessionRef 兼容合同**(R2-1):activation/attempt/session 身份诞生在 prepareCandidate
  同步 kernel 事务内,SpawnPort.spawn() 是事务后异步调用,Kernel.write 拒 async 回调——
  因此**不由 spawn port 写映射**。冻结 seam:新增纯同步 `InjectionRefBuilder`,在
  prepare 事务内由 v2-dag 自有代码从当时创建的 IDs 派生 exact shim JSON 并写 meta
  `injection_ref:<activation_id>`(同一 activation 事务);SpawnPort.spawn() 在事务外
  只**消费**已持久化映射。requestForSession/恢复路径读同一映射;映射缺失/不匹配=
  typed fail(负例测试);**不给 port 裸 WriteTx、不许嵌套写**。命名合同见 §2.4。
- **host 重启恢复**(R2-2 / R3-2 / R4-4):**不是幂等注册重放**——registration 换代
  需匹配 death evidence 且推进 generation。现 `agents` 表无 Lead instance 身份列——
  **迁移 0009**(纯加列,20 表不变):`agents` 增 consumer binding 列(instance_id、
  host_epoch/session 身份,**可空**;fresh-staging-only,0009 体内断言 agents 无
  generation>=1 行——不存在旧行回填,generation-0 provision 行天然 null)+
  processing_attempts 增 proposal_digest 列(§上文)。binding 的不可变性是 **generation-scoped**:
  provisioned(generation 0)可 null;注册事务原子安装非空完整 binding;同 generation
  内不可改;换代=CAS 推进 generation **同时整体替换 binding**,且必须证旧会话
  absence。reattach=**CAS 精确 binding + 新鲜进程/会话证据**(PID+start-time+会话
  身份三配),任一不符→不 reattach,走安全换代(取得确切 absence evidence 才
  death+generation+1;不许把活会话误判死;binding=null 的行不可 reattach,只能注册)。
  **测试**:空闲 Lead 恢复 / 错 instance 对 generation / stale PID+start-time /
  socket 复用 / stale host epoch / 并发 reattach-vs-reregister / null-binding 拒
  reattach / 换代替换 binding 原子性。in-flight deliver 以 recorded action 账恢复
  (§上文 intended 对账)。
- **跨进程真实链测试**(DoD):真 host 进程 + 真 CLI 子进程 + 真 SQLite 文件 + 真
  unix socket,跑通 mailbox 消息→注入→CLI proposal→host 结算全链(不 mock kernel);
  含 host crash 中途重试、重复 proposal 幂等两个负例。

### 2.3 `packages/v2-cli`(bin flywheel-v2,agent 侧唯一访问面)
kernel 单一**代码路径**进程内复用(BEGIN IMMEDIATE+busy_timeout,设计 §0.5b);禁旁路
SQL。动词表=**逐个列全输入、authority 来源、幂等键、底层 API**(Codex R1-2):
| 动词 | 必需输入(authority) | 幂等键 | 底层 API |
|---|---|---|---|
| admit | issue id + DAG descriptor 文件 + admission actor(Lead 身份) | issue+descriptor digest | admitIssueDag |
| propose / evidence | task/attempt/activation identity + generation + 证据 payload | proposal uid | submitNodeCompletion / recordEvidence |
| approve-ship | issue + exact tip + approval ref(founder 明示记录)+ repo/PR + config digest + action actor 选择合同(§1.5) | gate id+tip | approveShipGate |
| ship | issue + capabilityId + actor + 事务外 head 观测 | capability 单次消费 CAS | executeShip |
| reconcile-ship | issue | — (只读 probe+mint) | reconcileShipActions |
| mailbox pull | agent id + generation(fence 谓词) | message_uid | 候选 SELECT 只读(结算无裸 ack,一律经 proposal) |
| proposal 提交 | attempt_uid + 转化产物 + agent 身份/generation + **proposal capability token**(注入 envelope 携带,R4-2) | attempt_uid(+host 算 digest) | **host IPC**(§2.2;CLI 不直接落结算事务) |
| probe github-lane | repo/branch | — | W2 |
| status | — | — | 只读 |
每个动词的 authority 缺失=fail closed;CLI 也做 W4 authority 检查(§5)。

### 2.4 Discord 入站换写点 + v2 会话命名空间
- Bridge Discord 入站 handler:写 lead_inbox → 改调 v2-engine `enqueue`(kernel 事务;
  source_kind='discord', source_id=canonical Discord key,P3 归位)。目标 Lead 未
  provision 时走 provisionAgentRecipient(注册事务),不 fail open。出站不变。
- v2 会话 team 名一律前缀 `v2-<leadId>`;被墓碑集合=现存旧 team 目录枚举 +
  `~/.flywheel/comm/` 全部 + `~/.flywheel/inbox-structured/`。不相交检查见 §4.6。

## 3. W2 GitHub lane 探针(上线阻塞,Go/No-Go 证据)
真实读取 target branch ruleset/required checks + token actor permission/bypass actors。
403/unknown、required checks 空集、actor=admin、命中 bypass → **fail closed:不注册 v2
merge capability,typed deployment alert,保留 v1 ship lane**。探针是部署 enablement,
不进 gate/ship 事务。输出 JSON 证据文件供 Go/No-Go checker 引用。

## 4. W3 cutover CLI(`flywheel-v2-cutover`)

### 4.1 总合同
- **同码路 dry-run**(裁定 3)+ **target manifest 全控制面隔离**(Codex R1-4):唯一入口
  `run --target <manifest.json> [--step <n>] [--yes]`。manifest 解析出**全部**作用面:
  DB/JSON roots、launchd label 前缀+plist 目录、tmux socket(-L)、cmux 目标、wrapper/
  credential/env 集、host/scheduler/Lead 启动命令。生产 manifest=真值;预演 manifest=
  namespaced 复制品(label 前缀 com.flywheel-rehearsal.*、独立 tmux socket、隔离 HOME
  子树)。**隔离 manifest 加载时拒绝任何生产 label/路径/socket**(校验器);代码零分叉,
  控制面步骤不 stub 不 skip——预演真启动 namespaced legacy writer 与 v2 服务。
  预演前后抓生产 launchd/tmux/路径快照,断言零变化(预演不触生产的机器证据)。
- **durable step ledger**:`<ledger-dir>/ledger.jsonl`(append-only,temp+fsync+rename);
  步级 `{step(1-9 逐字), title, blast_radius(人话), status, started_at, done_at,
  evidence[]}`。**副作用 primitive 子账**(Codex R1-8):每个有副作用的原子操作
  (bootout 单个 label、chmod 单个目录、移动单个文件、撤销单个凭据…)记
  intent→apply→verify→complete 四态子行,崩溃重入按子账 reconcile/compensate,
  不依赖步级粗粒度。--yes 仅隔离 manifest 允许;生产每步打印"将做什么+爆炸半径"等确认。

### 4.2 九步子命令映射(编号=锁定设计逐字;Codex R1-1)
- **步① 预演**:W5 脚本以隔离 manifest 调同一 run,反复跑+幂等断言+对账报告。
- **步② 冻结**:Bridge admission 拒新(维护态)+ 双源未读枚举报告(research §2.1/2.2
  修正谓词)+ **staging DB 独占创建/迁移+cutover intent 写入**(§4.3)+ 不可 drain
  在途落 durable checkpoint 行(预期=0,非 0 列名 No-Go)+ **Codex Lead journal 清账**
  (R3-5):每个 Codex Lead 的 `…/codex-lead/<id>/journal.db`(+WAL/SHM)纳入 target
  manifest 与停新入口序;跑其原生 recovery 后断言 `listUnfinished()==0`(accepted/
  dispatching/dispatched/model-completed/output-pending 全部非终态=0),歧义/死信行
  单列报告;非零=阻塞窗口(不迁移 journal,只证清干、WAL-safe 快照归档)。
  另:lead_inbox `carrier='external'` 未完结义务同样 drain 到零(§4.4 域 B)。
- **步② 末尾(停机前基线)**:**service/filesystem manifest 采集+签名在步③ 任何
  mutation 之前完成**(Codex R2-6):launchd loaded/enabled/disabled overrides、
  plist bytes、owner/mode/ACL/xattr/symlink、WAL/SHM 清单;每个步③ bootout primitive
  的 intent 子行仍各自存 preimage(双保险)。
- **步③ 停全部旧写者**:launchd bootout 清单(W4 矩阵)+ **四面**进程零验证:pgrep /
  tmux / cmux / **lsof 扫描每个 legacy DB、WAL、SHM、inbox root、journal.db 的 open
  fd**(Codex R1-7 / R4-7);host epoch 记 ledger。
- **步④ 一致快照**:全部 comm.db(含 QA/遗留库)+ **每个 Codex Lead journal.db**
  WAL-safe backup+integrity_check(R4-7);JSON 信箱目录 tar 快照;与步② 签名基线互核。
- **步⑤ 迁移**:staging DB 数据导入(§4.4 迁移器)+ 20 表+**migration manifest 全序
  (止于 0009)**核对+integrity/FK/业务 invariant+**原子 promote 到最终路径**(§4.3)。
- **步⑥ 安全重置**:归档移位+chmod 只读(comm.db 族、JSON 信箱、**journal.db 族**;
  R4-7);围栏 (a) launchd 项撤销+旧 token 拒绝清单(凭据合同:可永久撤销,但
  **预制受控 rollback credential/重签路径**,T1 恢复服务不复活泄露 secret;Codex
  R1-8)+ (b) 原路径墓碑(父目录 chmod 500+同名只读占位,覆盖含 journal 路径;
  **realpath 校验:拒绝任何 fence chmod 目标是 v2 路径/新会话路径的祖先**——绝不
  chmod 共享的 ~/.flywheel 本体;Codex R1-7)。
- **步⑦ epoch fence**:meta cutover_epoch 就位核验+transitions fence 接线断言。
- **步⑦→⑧ 授权序(唯一顺序,ledger 与 runbook 同文;Codex R2-5)**:
  (a) 步⑦ 完成后跑实弹测试(§4.5)+ **除② 外**全部 pre-start 检查;
  (b) **founder 决策一「held-start 授权」**(授权对象=可逆的 8a:外部 effects/
  admission 结构性 hold,8a **不可能**产生外部副作用水位);
  (c) **8a held-start**:kernel(host)→thin Bridge→v2-scheduler 以 held 模式起;
  (d) 执行② (旧凭据真打 held 端点被拒)+ 全证据复核;
  (e) **founder 决策二「最终 GO」**;
  (f) **8b release**:原子放开 hold,Lead 回归,上电。
  两个 founder 决策在 runbook 各有命名步卡;两者之间只允许证据采集,零副作用。
- **步⑨ 回滚点**:锚=**首个 v2 外部副作用 durable watermark + rollback CAS**
  (Codex R2-6 / R3-3,防 TOCTOU):水位与回滚状态同住 v2 DB meta(kernel 单事务
  权威;authority 文件是入口投影)。**每个外部 effect 家族**(注入 deliver/spawn/
  Discord/GitHub/scheduler action,含 v2-dag spawn launch-claim 路径)在**外部调用
  之前**、同一 kernel 事务内以谓词「rollback_state=clear」写 action intent+水位;
  `rollback-t1` 调用**命名 kernel primitive `rollbackGateCas`(谓词唯一 normative
  定义在 §4.7,此处不复述)**原子独占(8b 后、首个副作用前的 live 区间同样可回,
  锁定边界=首个外部副作用而非 8b);成功后一切 effect intent 被谓词拒绝;CAS 失败
  即拒并指向 forward-repair。回退发布=带**单调 revision+window 的
  durable rollback receipt/digest**,armed 读者仅凭该 receipt 校验通过才接受 pre,
  其余一切 live/cutover→pre 回退视为篡改 fail closed。水位零→按步② 签名 manifest+
  子账逆序恢复(逐字节/权限/launchd 状态对比)。

### 4.3 v2 DB 建立序列(Codex R1-5 / R2-7 / R4-1,冻结)
步② 内 cutover CLI **独占**创建 staging DB(路径=最终路径旁 `.staging-<window>`)→
migrate **0001-0009(共享 manifest 常量)** → initializeEngineDb → 写 window/intent/epoch meta → 步⑤ 数据导入+
全量验证 → **WAL-safe promote**(R3-6 修正执行序:checkpoint 是连接级 PRAGMA,必须
持连接执行):关闭**其余全部**读写者 → **保留唯一 promotion 连接**执行阻塞
`wal_checkpoint(TRUNCATE)` 并断言返回值 busy=0 且全部 frame 已 checkpoint(看返回
三元组,不只看 sidecar 文件大小)→ 关闭该最后连接 → 校验零 open fd 且 -wal/-shm
不存在/为空 → fsync 主文件+所在目录 → 同目录原子 rename 到 DEFAULT_V2_DB_PATH →
再 fsync 目录 → 校验 promoted DB(integrity/ledger)→ 断言无残留 staging sidecar/
open fd(lsof)→ 最后 durable 发布迁移完成 marker(写+fsync)。checkpoint/rename/
目录 fsync/marker 四个边界各定义 crash reconciliation(重入判定属地),测试按此
精确顺序演练。生产 host/scheduler/agent CLI 一律 open-existing(§2.1 前置核对),
缺失/不匹配拒启。

### 4.4 双源对账迁移器(Codex R1-6 / R2-4,**本节即 normative 规格,不推给 runbook**)

**三个不相交枚举域**(Codex R4-5 / R5-3 / R6-2;**先按来源定界,再 A、再 B、
C=余集**;谓词对齐真实 legacy mutator,各自独立报告):
- **第 0 步来源定界**:A/B 只对 manifest 标记为**生产迁移源**的库/目录求值;
  QA/测试目录、顶层遗留库整体=域 C(来源定界先于谓词,未读 QA 行不会漏进 A)。
- **域 A:canonical 未读迁移输入**(进分类表与守恒式)——
  comm.db `messages`:`read_at IS NULL AND relay_state<>'terminal_disposed'`
  (open 与 protected 都算);comm.db `lead_inbox`:`carrier='inbox' AND
  consumed_at IS NULL AND processed_at IS NULL AND disposed_at IS NULL AND
  disposition IS NULL`(**markDisposed 只置 disposed_at 不置 consumed_at——
  disposed-but-unconsumed 归 C 并单列异常计数**;processed-but-unconsumed 同;
  R5-3/R6-2);JSON inbox:主文件条目 `read=false`。
- **域 B:未完结外发义务账**(**清零前置条件**,不是迁移行;谓词以 durable 终态
  证据为准,不以 disposition IS NULL 为准——正常成功路径 markExternalDelivered 会
  置 disposition='external_delivered' 而回执仍未处理,R6-2):
  - 投递义务:`carrier='external' AND delivered_at IS NULL AND disposed_at IS NULL`
    ——其中 `disposition='delivery_quarantined'`(quarantineExternalDelivery 隔离态)
    子类=**blocking manual**(不可自动 drain,人工裁);
  - 回执义务(完整 SQL,R7-2):`carrier='external' AND delivered_at IS NOT NULL
    AND processed_at IS NULL AND disposed_at IS NULL AND receipt_exempt_reason IS
    NULL`(接受 disposition='external_delivered' 的正常在途回执;**豁免的现态权威
    =行列 receipt_exempt_reason,append-only 的 receipt_exemption_audit 只作校验
    证据,不作现态谓词**);
  - 加 Codex Lead journal `listUnfinished()` 非终态行。
  步② 内 drain 到零;drain 不掉=blocking manual 项,**阻塞窗口**;独立守恒报告
  (delivery_obligations=0 且 receipt_obligations=0 且 journal_unfinished=0 才可过)。
- **域 C=来源定界后 A∪B 的余集**(read/consumed 已置、relay terminal_disposed、
  义务已清/已 disposed 的 external 行、processed/disposed-but-unconsumed 异常
  (计数单列,**显式报告而非静默归档**)、sidecar-finalized-but-main-read)=
  只归档,枚举报告单列行数,founder 过目。
- **断言:每条原始记录恰入一域**;fixture **经真实 legacy mutator 构造**
  (markExternalDelivered→回执义务、quarantineExternalDelivery→blocking manual、
  markDisposed→C 异常计数、真未读 QA 库行→C、**delivered-but-unprocessed 的
  carrier='inbox' 行不入域 B**、**receipt_exempt_reason 非空的 external 行不入域 B**;
  R6-2/R7-2)各归属唯一。

**canonical key 解析序**(R3-4 / R4-5:Discord 去重键必须与未来 enqueue 同形):
1. 先解析 **comm 行**的最终键:可溯源 Discord/founder 源头行(lead_inbox 及可溯源
   messages)→ key=**(discord, <canonical Discord message key>)**,与切换后 Bridge
   入站 enqueue 用**同一派生函数**——从 source/ref_message_id/content 派生并交叉
   校验;**自称 Discord 溯源但派生失败**=unknown provenance→manual(不吞合法
   vendor-only,后者无溯源主张,走规则 4)。非 Discord comm 行→(legacy-comm,
   <project>/<message-id>);非 Discord lead_inbox 行→(legacy-comm,
   <project>/inbox/<id>)。
2. 有 flywheelId 的 JSON 条目:先按 flywheelId 找 comm 同源行;找到→**继承该 comm 行
   解析出的最终键**(这才构成 overlap;payload_digest 不一致=conflict→manual);
   找不到→(legacy-comm, <project>/<flywheelId>)。
3. 切换后同一 Discord 消息重放命中 mailbox UNIQUE(source_kind,source_id),不双投
   (fixture:迁移行+JSON copy+切换后重放三方=恰一行)。
4. vendor-only/surrogate-id/sidecar-less JSON 条目:key=(legacy-json, canonical 元组
   **{team, 收件路径, from, timestamp, text, 碰撞序号}** 的确定性 hash);碰撞序号=
   **不可变快照证据**(快照内相对文件路径+数组稳定出现序),同文异次不塌缩
   (枚举两遍稳定性断言)。

**分类映射表(normative;仅对域 A 求值;按行序 first-match=显式优先级,构造性互斥;
manual=0 才可过步⑤)**:
| 序 | 源 | 状态组合 | 处置 |
|---|---|---|---|
| 1 | 任意 | payload_digest 冲突 / 自称溯源派生失败 / 无法归入下表 | manual |
| 3 | messages | 未读 + 已过期(expires_at<now) | business(question/instruction/response)→dead+event;notice(progress/ack_receipt)→tombstone+event |
| 4 | messages | 未读 + notice 类 | tombstone+decision event |
| 5 | messages | 未读 + business 类 + 收件人=终态 runner/不存在 agent | dead+decision event(DLQ 报告) |
| 6 | messages | 未读 + business 类 + 收件人=存续 Lead | migrate-pending |
| 7 | lead_inbox | 未消费 inbox 行 + deadline_at 已过 | model→dead+event;protocol→tombstone+event |
| 8 | lead_inbox | 未消费 inbox 行 + msg_class='protocol' | tombstone+decision event |
| 9 | lead_inbox | 未消费 inbox 行 + msg_class='model' + **Lead 缺失/终态** | dead+decision event |
| 10 | lead_inbox | 未消费 inbox 行 + msg_class='model' + Lead 存续 | migrate-pending |
| 11 | JSON | 未读 + 有 flywheelId + **comm 同键行且该行也在域 A** | overlap copy(canonical 取 comm 行分类) |
| 12 | JSON | 未读 + 有 flywheelId + comm 无同键 **或 comm 同键行在域 C**(后者继承 comm 解析键但按 JSON-only 活行处理;R5-3——主文件无 type/class 元数据,不可执行 messages 规则) | 收件人=存续 Lead→manual(报告);否则 tombstone+decision event |
| 13 | JSON | 未读 + vendor-only/surrogate | 收件人=存续 Lead→manual;否则 tombstone+decision event+报告单列 |

**守恒式**(分项打印,差额即 No-Go):
`raw_comm_unread + raw_json_unread = unique_canonical + overlap_copies`;
`unique_canonical = migrated + dead + tombstoned + manual`;`manual=0`;`conflict=0`。

**目标写=migration-only typed kernel API**(新增,cutover 包专用;W4 authority 检查
拒绝生产进程调用):同一短事务内 provision 存续 Lead + 保留**原 message_uid/source
key/payload_digest** + 写切换 epoch + 冲突 CAS。禁 raw SQL、禁普通 enqueue(其生成新
UUID 且拒未 provision 收件人)。
**fixture=按上表逐行**(每行至少一例)+ 负例:双源同键 digest 冲突、vendor-only 致
manual 的 Lead 收件人样本、protected 未读、**域 B 两种义务态各一**(投递义务/回执
义务,R4-5/R5-3)、processed-but-unconsumed 归 C、**未读 JSON 链接到已读/终态 comm
行走行 12**(R5-3)、QA 库只归档、枚举两遍 hash 稳定、**discord 三方去重**(迁移行+
JSON copy+切换后重放=恰一行)。**映射表本身驱动 fixture 生成**(表驱动测试),
不留实现自由裁量。

### 4.5 实弹测试(步⑦→⑧ 子闸)
真启动旧 comm.db writer(flywheel-comm 子进程指向原路径)+ 真触发旧 JSON writer
ensureFileExists 重建 → 断言 fail loud(非零退出+EACCES)+ 原路径零新文件/-wal/-shm
(find -newer 基线)+ 新 mailbox 零旧 epoch 行。

### 4.6 Go/No-Go checker(十条逐字+两项新增证据;力学修正 Codex R1-7)
research §5 表为规格,修正:① 增 lsof open-fd 扫描;② 在 8a held-start 后对真实
endpoint/auth handler 做旧凭据真调用;④ 只验 effect_key UNIQUE+invocation→effect_key
派生合同(schema 无 invocationUid 列);不相交检查=realpath 集合求交+祖先/后代+symlink
三类,拒绝 fence 目标为 v2 路径祖先;**"上电后旧路径零新写入"=步 8b 后 acceptance
gate**(强制:失败即停新 admission 入口+进入预定义 forward-repair),不伪装成 pre-GO。
**⑧ 增设命名子检查「journal 清账」**(R4-7):manifest 内每个 Codex Lead journal 必须
在证据集出现,`listUnfinished()==0` + 歧义/死信计数单列;任一 journal 缺席证据或存在
非终态行=**8a 不可被授权**(失败 fixture 背书)。
checker 输出逐条 PASS/FAIL+证据路径报告;任何 FAIL=停在步界。

### 4.7 T1 回滚合同(Codex R1-8 / R2-6 / R4-6)
- 依据:**步②** 签名 manifest(停机 mutation 前基线)+ primitive 子账(intent/apply/
  verify/complete,各存 preimage)+ 预制 rollback credential/重签路径。
- 谓词=**命名 kernel primitive `rollbackGateCas`,唯一定义,逐字**:
  `state IN ('cutover','live') AND effect_intent_count=0 AND rollback_state='clear'
  → rollback_started`。§4.2 步⑨、本节、W4、测试与 runbook 一律引用该 primitive,
  不得另写谓词副本(R4-6)。每个外部 effect 在外呼**前**同事务写 intent+水位并检
  `rollback_state='clear'`——回滚与 effect 经同一 durable fence 串行化,无
  check-then-act 窗口。
- 验收:每个副作用 primitive 前后注入 crash → 恢复后逐字节/权限/launchd 状态对比;
  **并发竞态测试:rollback-t1 对每个 effect 家族真并发**(不只 crash 前后)。

## 5. W4 机器级 cutover authority + 禁用矩阵(Codex R1-3)

- **authority 载体**:`~/.flywheel/v2-cutover-authority.json`(原子写 temp+fsync+rename;
  内容:window id、epoch、state∈{pre,cutover,live}、签发时间)。**机器级、fail-closed、
  单调**(Codex R2-3):
  - **部署即播种显式 pre 文件**;另设**独立 durable armed 哨兵**(`~/.flywheel/
    v2-cutover-armed`,一经步② 写入永不删除)区分"从未切换"与"authority 丢失"。
  - 读者合同:armed 哨兵存在时,authority 文件缺失/畸形/窗口不符/epoch 不符/状态
    回退=**一律 fail closed**(拒绝启动/执行,人话报错指向 runbook);armed 不存在
    且 pre 文件在=旧世界照常(off 字节等价)。所有读者(每个 entrypoint+两个 DB
    侧检查)核对同一 window/epoch。
  - **状态转移是 primitive 子账里的 CAS 行**:步② `pre→cutover`(armed 哨兵同时落)
    先于任何冻结动作;8b `cutover→live`;T1 `{cutover,live}→pre` **仅经
    `rollbackGateCas` primitive(§4.7 唯一定义),且发布必附带单调 revision+durable
    rollback receipt**(R3-3)——
    armed 读者仅在 receipt 校验通过时接受 pre,否则一切回退=篡改 fail closed。
  - 测试:删除/截断/stale rename/状态回退四类破坏各一例 fail closed;live+零副作用
    可回滚 / live+已有 intent 拒回滚 / 伪造 pre 投影拒 / stale rollback receipt 拒。
  每项目 config 只作派生配置,不承载总开关。
- **禁用矩阵**(runbook 附录 normative;"进程/entrypoint → 旧路径 → 启停 owner →
  cutover 后行为"穷举):Bridge plugin.ts(C 档子系统不构造)、**Codex Lead TUI runtime /
  headless runtime / gateway**(各自的 RestPollDiscordInboundSource+LeadInboxQueue 打开
  点加 authority 检查)、Claude Lead(claude-lead.sh 环境)、flywheel-comm CLI(入口
  authority 检查,fail loud 人话)、巡逻/定时 launchd job 逐项、launchd wrappers。
  每个独立 composition root 指定修改文件+on-path 测试。
- **不删任何代码**;authority 文件+各检查点全部列入 1503 删除清单。
- off 路径 reverse-compat 哨兵:**仅在 armed 哨兵不存在时**,authority 文件缺失=全部
  入口行为字节等价(armed 之后缺失一律 fail closed,见上;R3-3 修正)。

## 6. W5 隔离预演与验收矩阵

### 6.1 隔离预演(步①,A 段完成,不可跳过)
`scripts/rehearse-v2-cutover.sh`:构建隔离 manifest(namespaced labels/socket/HOME 子树)
+ rsync/sqlite backup 复制真生产状态 → 全九步 run(--yes)→ 断言:二次 run 幂等 skip /
守恒式全平 / 实弹三断言 / Go/No-Go 全绿(GitHub 探针打真 API 只读)/ **生产快照前后
零变化**。预演证据目录保留给 founder。

### 6.2 测试矩阵(implement DoD;R1 增补)
- 迁移器:§4.4 全部负例 fixture(表驱动);守恒式差额报错;migration-only API 拒绝非
  cutover 调用;**Discord 同键重放去重 fixture**(迁移行+切换后同消息 enqueue=一行)+
  **同文异次 vendor 条目不塌缩** fixture(R3-4);**journal 非终态各状态一例**
  (accepted/dispatching/dispatched/model-completed/output-pending → 阻塞窗口,R3-5)。
- 围栏:墓碑后旧 writer EACCES(真子进程)/ ensureFileExists 拒 / realpath 祖先拒绝
  样本(fence ~/.flywheel 本体必须 FAIL)/ 不相交人为相交样本 FAIL。
- ledger:**每个副作用 primitive 前后 crash 注入→恢复对比**;done skip;failed retry;
  同码路断言(唯一入口函数两种 manifest 调用);**staging promote 四边界(checkpoint/
  rename/目录 fsync/marker)crash reconciliation 各一例**(R2-7)。
- T1:**rollback-t1 对每个 effect 家族的真并发竞态测试**(R2-6);live+零副作用可回 /
  live+intent 拒 / 伪造 pre 投影拒 / stale rollback receipt 拒(R3-3);**源码级断言:
  rollback CLI 与每个 effect fence import/调用同一 `rollbackGateCas` primitive,
  仓内无第二处谓词副本**(R5-4)。
- IPC:收到后崩 / 结算后响应前崩 / 并发同异 payload / 跨 agent 冒名 token 负例(R3-1);
  reattach 六负例(R3-2)。
- Go/No-Go checker:每条 PASS+FAIL 样本;lsof 扫描真 fd 样本。
- W4:各 entrypoint authority 检查 on-path 测试;off 字节等价哨兵;**authority 破坏
  四类(删除/截断/stale rename/状态回退)fail closed**(R2-3)。
- W1:**跨进程真实链测试**(§2.2,含 host crash 重试+重复 proposal 幂等);
  InjectionRefBuilder 映射缺失/不匹配负例(R2-1);reattach API 窄栅栏单测(R2-2);
  host open-existing 拒绝样本(缺 marker/错 epoch/错权限);scheduler 不再自 migrate
  哨兵;CLI 动词 authority 缺失 fail closed 表驱动。
- thin Bridge:on 时 C 档零构造(spy);Discord 入站落 v2 mailbox canonical key 幂等。
- 全仓 `pnpm lint` + `pnpm -r build` + 相关包测试绿。

## 7. W6 runbook(founder 视角,B 段执行合同)
每步一卡:步名(1-9 逐字)/ 将做什么(人话)/ 爆炸半径 / 可逆性(T1 可回?)/
founder 动作(拍板 or 明示不可逆)/ 验证输出。另含:停用窗口预告口径(**全部 Lead
预计停用 ≤1 小时**;Tadashi roundtable 引用)/ W4 禁用矩阵附录 / §4.4 源状态映射附录 /
命名空间合同 / T1 步卡 / 上电验收三件套(真 issue 全链、FLY-1507 swap、founder page
探针)/ 步 8b 后 acceptance gate(零旧写)的失败预案(停新入口+forward-repair 预定义)。

## 8. 实施顺序(A 段)
1. W4 authority 骨架+off 字节等价哨兵(先立基线)
2. W1 host/CLI/协议/换写点(W2 探针随 CLI;v2-dag sessionRef 映射 port 先行)
3. W3 cutover CLI(依赖 §4.3 staging 序列)
4. W5 预演脚本+全矩阵;隔离预演跑绿
5. W6 runbook 定稿
6. PR(codex code review + 独立 QA;Tadashi legacy 手合,不重启)
B 段:等 founder 拍窗口时刻 → Implement runner 现场按 runbook 执行九步(本设计节点
park 保活)。

## 9. 诚实边界
- 上电形态=thin Bridge(Discord I/O)+ v2(编排/消费/派发);StateStore 与出站 Discord
  不动;Linear 自动 ingress 缺位=admission 由 Lead CLI 驱动(1503 族账)。
- 十条④⑤为 actions 世界映射表述;原 commands 措辞不可字面执行(FLY-1500/1518)。
- 预演对 GitHub 探针只读真调用,不能预演 v2 merge capability 注册本身。
- B 段停机窗口内 Linear webhook 事件丢失=恢复后 Lead 对账。
- 本 pipeline 自身是旧系统在途:PR ship+pipeline park/completed 后才满足步② 前置
  (runbook 第 0 步核对)。
- "上电后旧路径零新写入" acceptance gate 只能在步 8b 后判定——它是上电验收,不是
  pre-GO 证据(Codex R1-7 定性)。
- **有记录偏离:迁移 0009**(纯加列:agents consumer binding 两列 + processing_attempts
  proposal_digest 一列;20 表数不变)。设计终版 schema 止于 0008;0009 是本单 runtime
  protocol(reattach 栅栏+proposal 回执)所需的最小 schema 增量,列语义见 §2.2,
  历史迁移 0001-0008 逐字不动(checksum-bound)。
