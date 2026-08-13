# FLY-1726 Lead 统一 Identity — 实施计划(单一权威源方案)

Issue: FLY-1726 (https://linear.app/geoforge3d/issue/FLY-1726/设计议题基础层-lead-统一-identity-身份在-n-处以不同形式表现无单一权威今日三重嵌合体活爆雷标本annie-直令立单)
日期: 2026-08-12
基于: research.md(Codex design review R1 反馈已折入)

## 0. 一句话

registry 行(`~/.flywheel/projects.json` 的 `projectName` + `leads[].agentId`)成为 Lead 身份的**唯一权威源**;一个 **resolver 单实现**把它编译成 immutable 的 `CanonicalLeadIdentity` 交付物;其余每一张「脸」(env、state dir、token、bot id、lease key、Agent Team 名、launchd/manifest 键)都改为**该交付物的派生投影**;manifest 与环境只能携带 **selector**(project+lead+registry 文件路径),不再携带可取值的身份字段;三道**启动断言**让任何拼装错误在产生身份副作用前 fail-loud;身份缺失一律报错,**不再有静默 fallback、sentinel 默认值或任何形态的第二身份权威**。

## 1. 目标不变量(验收即验这五条)

| # | 不变量 | 违反时的行为 |
|---|---|---|
| I1 单源 | 身份事实只在 registry 行声明一次;manifest/env/launcher 只携带 selector;身份字段在别处出现只允许「与 canonical 比对后拒绝冲突」,不允许取值 | 配置校验 fail-loud(Bridge 拒启 / fleet 写入拒绝 / launcher 退出) |
| I2 一次解析 | 一个 Lead 进程一生恰一次 resolve,产出带 digest 的 immutable 交付物;launcher→pane→adapter→lease→写边界全链消费同一交付物;后续任何 registry 重读只允许作「新鲜性/fencing 校验」,冲突 fail-closed,不允许重新决定身份 | 交付物缺失/digest 不匹配 = 拒绝动作 |
| I3 启动断言 | env 一致性(A1)、login bot-id(A2)、lease bind(A3)全过才注册任何 handler;断言失败=零身份副作用退出(定义见 §4:A1/A3 零 Discord 调用;A2 仅允许认证握手/一次只读 `/users/@me`,禁止 handler/polling/发言/铸章) | 进程退出;本单不发远端通知——未来若消费失败 marker,只能走 system-attributed durable 通道(另行立单) |
| I4 不自证 | 期望值(botUserId)只来自 registry 登记;禁止从 token/`/users/@me` 运行时派生期望值 | resolver 对 managed Lead 缺 botUserId 直接报错 |
| I5 不外溢 | 身份/secret env 不隐式穿越 spawn 边界;raw registry(`FLYWHEEL_PROJECTS` JSON)不投影进 Lead server/child;每个边界要么显式设全套一致值,要么显式清除 | 夹具测试:祖先污染环境下 child 只能拿到 canonical 投影 |

## 2. 数据模型

### 2.1 CanonicalLeadIdentity(运行时只读交付物)

```ts
// packages/flywheel-comm/src/lead-identity.ts(新;底座=现有 canonical-lead.ts,该文件的宽松解析收敛进本实现)
export interface CanonicalLeadIdentity {
  schemaVersion: 1;
  leadId: string;          // ≡ registry leads[].agentId — 裸形态唯一合法来源
  projectName: string;
  leadKey: string;         // `${projectName}-${leadId}` — dash 复合键唯一合法派生点
  agentTeamName: string;   // ≡ leadId — Agent Team 邮箱 teamName 的显式化(path-helpers 合同不变)
  botUserId: string | null;   // registry 独立登记的 Discord snowflake;managed Lead 必非空(§3 失败合同)
  botTokenEnv: string | null; // secret selector(env 名);token 值绝不进对象
  discordStateDir: string;    // 解析后的绝对路径(realpath 规范化;§2.3 优先级)
  backend: "claude-code" | "codex-app-server";
  role: "cos" | "dept" | "companion" | "external";
  projectsDigest: string;  // 本次 resolve 所读 registry 内容 hash — 仅诊断/整库快照证据,不参与 fencing
  identityDigest: string;  // 仅本 Lead 身份字段的稳定 canonical encoding hash(排除 projectsDigest 与自身)— 跨进程绑定/新鲜性校验的锚
}
```

**digest 语义(R2-1)**:`identityDigest` 只覆盖本行身份字段——别的 Lead 的 registry 变更**不得** fence 本进程;本行变更才触发拒绝。`projectsDigest` 只作诊断记录。

**交付形态**:CLI `--format env` 输出投影(`FLYWHEEL_LEAD_ID` / `FLYWHEEL_PROJECT_NAME` / `FLYWHEEL_LEAD_KEY` / `DISCORD_STATE_DIR` / `DISCORD_EXPECTED_BOT_USER_ID` / `FLYWHEEL_LEAD_IDENTITY_DIGEST` / `FLYWHEEL_LEAD_PROJECTS_DIGEST`)+ `--format json` 全对象。

**耐久绑定(R2-1,digest 不止活在 env)**:env 投影可被旧进程重设,单靠它证明不了「本 generation 启动时绑定的就是这份身份」。因此:
- **Claude 路径**:`lead_lease` 表加 `identity_digest` 列;acquire CAS/新 generation 写入;bind 与后续 validate 要求 **generation + identityDigest 同时匹配**;存量 NULL 行不兼容放行——必须重启重获;
- **Codex 路径**:`CarrierRuntimeAssertion` → FleetPoller evidence → self-check receipt 全链携带并校验 `identityDigest`(现状 TUI 只传手拼 leadKey,`codex-lead-tui-runtime.ts:877-888` 补齐);
- 测试:Claude lease、Codex carrier 各一条「registry 改本行→旧进程拒绝;改别行→本进程不被误 fence」。

### 2.2 registry schema 增量(校验并入 `parseAndValidateProjects` 唯一权威)

```ts
export interface LeadConfig {
  // …现有字段不动…
  botUserId?: string;        // 新:^[0-9]{17,20}$;全局唯一;managed Discord Lead(有 botTokenEnv)最终必填
  discordStateDir?: string;  // 新:绝对路径;缺省走派生规则;QA slot 的自定义目录写在这里(不再走 manifest 身份覆盖)
}
```

校验新增(全部 RED 测试先行):
- **裸 `agentId` 跨 project 全局唯一**(R1-1):现状只查复合键唯一;但 Discord state dir(无 project 前缀)、Agent Team teamName、mailbox to_agent 全是裸形态,裸名撞车=多面串线。同 project 重复/跨 project 重复/复合键不同但裸名相同,三类夹具全 fail-loud。现网 16 行实测无撞车,迁移安全;
- `botUserId` grammar + 全局唯一;
- **state-dir 有效路径唯一(R2-6)**:对**每一行**先算 `effectiveDiscordStateDir`(显式字段或派生默认),`path.resolve` 词法规范化后全局唯一——「A 行显式指向 B 行的派生默认目录」也必须撞出来;路径已存在时再 realpath 关闭 symlink 别名,不存在时 realpath 最近存在祖先+拼接剩余段(**不要求待 provision 目录预先存在**,fleet 写入验证不依赖 provisioning 顺序),launcher 创建目录后复验最终 realpath;
- B0 写 registry 的迁移工具与 Bridge 启动共用同一校验函数(单实现)。

### 2.3 派生规则(全部收进 resolver,别处删除)

| 面 | 规则 | 取代的现状 |
|---|---|---|
| leadKey / manifest 名 / launchd label / lease key | `${projectName}-${leadId}` | 各脚本手拼(保留拼接,但必须断言与交付物 `leadKey` 一致) |
| socket | 现状不动:`sha256("<project>/<leadId>")` 派生,消费者重派生比对 | ✅ 已是健康形态 |
| discordStateDir | registry `discordStateDir` > 派生 `~/.claude/channels/discord-<leadId>`;**manifest launchEnvironment 与 ambient env 都不参与取值**——manifest 若出现身份键,只做与 canonical 值的比对,不一致即拒启(治 G6 冻结错值永续) | `claude-lead.sh:183` 继承优先 / wrapper-v2 `:221` manifest 优先 / #815 bash 第三实现,三处全删 |
| token | `botTokenEnv` 名→父进程解引用取值→只以泛名 `DISCORD_BOT_TOKEN` 投影进本 Lead 私有 server env;解析失败=启动失败 | `ProjectConfig.ts:328` warn+回落全局 token |
| expected bot id | registry `botUserId` 原样投影(`DISCORD_EXPECTED_BOT_USER_ID`) | roundtable-registry 自报发布(保留为观测/allowBots 物料,不再是断言依据);`voice-routes.ts` token 解码改造为消费 registry |
| Agent Team | `deriveRunnerMailboxIdentity` / `teamName = leadId` 不变,输入必须是 canonical `leadId` | ✅ 器官保留 |

**QA slot 身份数据**(R1-4):`qa_multilead_build_projects` 生成 slot registry 时,`test-slots.json` 的 `botAppId` 映射为 `botUserId`、slot 自定义 state dir(`${SLOT_DIR}/discord-state`)写为 `discordStateDir` ——主 Lead、extra Lead、单 slot 三条生成路径全覆盖,并加生成 JSON 的 schema 测试 + multi-lead 启动 preflight E2E。此项是 B1 的前置(否则 managed-Lead-缺-botUserId 硬错误会先把 529 房打死)。

## 3. resolver 单实现与消费矩阵

**落点**:`packages/flywheel-comm/src/lead-identity.ts` + CLI 动词 `flywheel-comm lead-identity resolve --projects-file <path> --project <p> --lead <id> --format env|json`。

- **输入只有显式 selector**:projects 文件路径 + project + leadId。manifest 只携带这三样(现状 manifest 已有 projectName/leadId;新增可选 projectsFile,缺省 `${FLYWHEEL_STATE_DIR}/projects.json`)。**resolver 不读 `FLYWHEEL_PROJECTS` env**;该 env 入口仅 Bridge 进程自身保留(现状),且其内容不得投影进任何 Lead server/child(I5;QA 的 `test-deploy.sh` 同步改为只传文件路径)。
- **manifest 生产者矩阵(R2-4,B1 修改面明列)**:manifest schema 收缩为身份 selector 三元组——`materialize-lead-manifests.sh:70-90` **停写顶层 `botTokenEnv`**;`lead-body.sh:44-63` **停读 manifest token selector、停止重投影 token**(只消费 wrapper 已投影的 `DISCORD_BOT_TOKEN`);`test-deploy.sh:1181-1186` QA manifest 同步停写。负测:manifest 顶层出现 `botTokenEnv`/`botUserId`/`discordStateDir` → 拒绝,不取值(与 launchEnvironment 身份键同一 compare-and-reject 合同)。
- teamlead 的 `parseAndValidateProjects` 对身份字段 import 本模块的校验函数(依赖方向 teamlead→flywheel-comm 已实测成立);`canonical-lead.ts` 宽松二号解析器收敛进同一实现,消除现存双权威。
- 失败合同:缺行/多行/grammar 违规/managed Lead 缺 botUserId/state-dir 冲突 → CLI 非零退出 + 结构化错误名(`identity_row_missing` / `identity_row_ambiguous` / `identity_bot_user_id_missing` / `identity_state_dir_conflict` / `identity_bare_id_collision`…);**调用方一律 fail-closed,禁止任何「解析失败就用旧办法拼」的降级**。

| 消费者 | 怎么消费 | 改动 |
|---|---|---|
| `flywheel-lead-wrapper-v2.sh` | 启动时 CLI resolve(输入=manifest selector),输出 env 投影进 `SERVER_ENV`(env -i 全量替换机制保留) | 删自身 state-dir/token 拼接;launchEnvironment 中出现身份键→与交付物比对,不一致 fail-loud;raw `FLYWHEEL_PROJECTS` 不再进 SERVER_ENV |
| `claude-lead.sh` | 信任 wrapper 投影 + **A1 断言**(§4);`:183` 派生删除 | pane `-e` 覆写集合从「FLYWHEEL_* 子集」升级为「身份全集」(含裸名);digest 随投影进 pane |
| lease preflight(A3) | **消费交付物,不再重 resolve**(R1-2):`lead_identity_prepare_lease` 改为以投影的 `leadKey`+`identityDigest` 请求 lease(acquire CAS 落库,§2.1 耐久绑定);`valid_but_lead_absent` 自拼 key 的路径删除——带 Lead selector 而 registry 缺行 = fail-closed | `lead-identity-preflight.sh:29-81` 重构;`lead_lease` 加 `identity_digest` 列 |
| 写边界(A4) | `validateLeadWriteAuthorization` 语义重定义为**新鲜性/fencing 校验**:lease 行的 `generation+identity_digest` 与调用方交付物同时匹配→放行;本行 registry 变更→按撤销处理 fail-closed;**Lead 语义下的 absent/ambiguous/source_error/digest mismatch 一律拒绝,不再落 `unprotected`**(现状 `lead-lease.ts:2455-2459` fail-open 洞关闭)。**identity-integrity 硬拒绝不可 audit、不可 bypass、在读取 lease mode 之前执行(R2-2)**:`mode=off/audit_only/enforce` 与 `FLYWHEEL_LEAD_LEASE_BYPASS` 只控制 lease liveness/generation rollout,永不放行身份完整性失败(现状 `lead-lease.ts:2405-2415` mode=off 短路、`:2525-2564` bypass/audit_only 放行,两条路径对 identity 失败关闭) | `lead-lease.ts:2405-2602` 收紧 |
| **system/unmanaged writer(R2-3)** | 两个不可混用入口:`authorizeLeadWrite`(默认且永远按 Lead 语义,失败=拒绝)与 `authorizeSystemWrite`(仅 Bridge 进程内部可调,trusted principal 在进程内注入,**不可由 CLI flag/env 选择**);`send`/`respond` CLI 不暴露 system 开关;实现前盘点并分类全部现有调用点(含 `write-gate-response.ts:366-378`、`founder-routing-response-route.ts:59-70` 两条 Bridge 代 Lead 路径),unknown 一律按 Lead 拒绝。**清空全部身份 env marker 不能把 Lead write 降级成 unprotected**(现状 `hasLeadMarker` 启发式的逃逸口关闭) | 负测:unset 所有 marker → 仍拒绝 |
| Codex launchers(全矩阵,R1-5):`codex-lead.sh`、`run-codex-lead-mufasa-tui-fullaccess.sh`、`run-codex-infra-bot-tui.sh`、QA/headless/rollback 形态 | 同样 CLI resolve;launcher 只保留 **selector**(project+lead)硬编码;botUserId/token selector/Discord 身份坐标**同版本删除硬编码**,只消费 resolver——不留「双保险」过渡(它就是被禁止的第二身份声明) | `FLYWHEEL_CODEX_LEAD_STATE_DIR`(Codex thread/记忆连续性)**不是** discordStateDir,不纳入本合同,保持现状 |
| Codex `codex-lead-runtime.ts` | `req("FLYWHEEL_LEAD_ID")` 等改为消费投影 + digest;`FLYWHEEL_LEAD_BOT_USER_ID` 来源改 registry 投影 | — |
| Discord plugin fork | 新 env `DISCORD_EXPECTED_BOT_USER_ID`(投影);login 后断言(§4 A2) | plugin PR(独立仓,回收 #21 login-assertion 器官) |
| Bridge / DirectEventSink / run-dispatcher | `ctx.leadId` 已来自 registry,不变;读侧守卫推广(§5) | — |
| FLY-1710 ChannelAuthority compiler | 同一次 resolve/compile 产出(接口合同,实施在 1710 线) | — |
| FLY-1725 销账游标 | 销账键 = `(canonical leadId, cursor)` | 只消费 |

## 4. 三道启动断言(A 系)与失败合同

**A1 env 一致性断言**(新,`claude-lead.sh` 启动序列最前 + preflight 扩展):
- `LEAD_ID`(若存在)==`FLYWHEEL_LEAD_ID`==manifest selector `leadId`==交付物 `leadId`;`DISCORD_STATE_DIR`(若存在)==交付物值;`PROJECT_NAME` 族同理;
- 任一不等→按失败合同退出;过后 launcher 以交付物**重设全套**(从此 pane 内所有面必同源)。

**A2 login bot-id 断言**(新,两条 adapter 路径):
- Claude plugin:login 完成、**注册任何 inbound handler 之前**,`client.user.id === DISCORD_EXPECTED_BOT_USER_ID`,不等即退出;managed 模式下 expected 缺失同样退出;
- Codex gateway:startup 以 token 调一次 `/users/@me` 与投影 expected 比对,不等 fail-loud(现状「信 env 不验 login」修复);
- 期望值只能来自 registry 投影(I4);自报发布仅存观测。

**A3 lease bind**(FLY-1697 已有):改为消费交付物(§3);其余不动。
**A4 写边界**(已有):按 §3 收紧为 fail-closed 新鲜性校验。

**失败合同(R1-8 + R2-5 收敛)**:
1. 失败进程:结构化诊断写 stderr(launchd log 可查)+ 本地原子诊断文件(0600,write+fsync+rename;文件键用 **selectorDigest**——`identity_row_missing`/`ambiguous` 等失败发生在拿到 canonical leadKey **之前**,不能用 leadKey 作键;不含 secret)→ 立即退出。marker 写失败也必须立即退出,零身份副作用合同不受影响;
2. **零身份副作用(按断言精确分层,R3-1)**:A1/A3 失败=零 Discord 调用;A2 本身就是认证断言,**允许**完成 login 握手(Claude)或唯一一次只读 `GET /users/@me`(Codex)——否则永远发现不了「token 登进了错误 bot」;断言通过前一律禁止 handler 注册、channel/message polling、typing、message POST、receipt/CommDB 写入及其他任何 Discord 动作(现状 Codex gateway start 先注册 handler 再起 source,`CodexDiscordGateway.ts:170-175`,认证 probe 需前置);
3. **远端通知降为非阻断 follow-up(R2-5)**:本单只保证 stderr/launchd log + 原子本地诊断,可满足运维排障(launchd KeepAlive 重启循环本身即是可观测信号,现有 LeadWatchdog pane 面也会看到 Lead 不在线)。marker 的 Bridge 侧耐久消费(claim/ack/去重/崩溃重放)如需要,复用既有 durable outbox/reconciler 模式**另行立单**——不在本单顺手造一个欠设计的新检测器(修结构不加报警器);
4. 负测试:以 §8 第 7 项为唯一负测试合同——A1/A3 零 Discord API;A2 仅允许上条第 2 项定义的认证流量;三者共同断言零 handler 注册、零身份写副作用、零 CommDB Lead 行。

## 5. fail-loud 清扫(杀静默 fallback 与 sentinel)

**Bridge 启动失败粒度(R1-7,定死一种合同)**:registry schema/全局唯一性/managed Lead 身份字段(botUserId、botTokenEnv 可解析性)任何错误 → **Bridge 整体拒启**,启动日志逐条列错。不建 per-Lead quarantine 子系统(修结构不加报警器;半舰带病运行正是本单要消灭的状态)。fleet 写入侧用同一校验,坏配置根本进不了 registry,拒启只会发生在带外手改后。

| 现状 | 处置 |
|---|---|
| `ProjectConfig.ts:328-331` botTokenEnv 解析失败→回落全局 `DISCORD_BOT_TOKEN` | 删;并入 Bridge 拒启合同 |
| `bridge/tools.ts:484,619,832`、`lead-inbox-runtime.ts:607` `?? globalBotToken` | 以 Lead 身份发言的路径删 fallback;system sender 保留自己显式的 system token,不混用 |
| flywheel-comm `ack` 默认 `"lead"`(`index.ts:383`) | 必填化:`--lead`/env 双缺=报错退出 |
| `plugin.ts:4861` `cos ?? leads[0] ?? "unknown"` | 路由不出唯一 Lead=显式错误事件进告警,不铸 `"unknown"` 行 |
| `config.ts:126-145` `TEAMLEAD_DEFAULT_LEAD_AGENT` 默认 `"product-lead"` | **不删机制、删默认值**:该配置改必填,Bridge 启动时解析并校验为唯一 canonical Lead,后续 system 路由继续消费该对象(身份选择不散回各调用点,R1-7)。交付面同步闭环:fresh/resume setup 把生成的 `cos-lead` 写入 live `.env` + `env.example`;存量 self-host restart 在全局锁内、任何 build/service mutation 前,仅当 registry 恰有一枚历史 `product-lead` 时把旧隐式选择一次性物化为显式 `.env`,否则保持旧 Bridge 在跑并 fail-close 要求 operator 明选。迁移值不是运行时 fallback。 |
| `flywheel-restart-guard.py:337` 兜底 `"flywheel-eng-lead"` | `--lead` 缺失=告警落 system 名义并标注 `lead_unknown`,不冒名 |
| `runs-route.ts:1583` `"unassigned"` | 保留(诚实的「未选定」语义+已有读侧守卫),纳入 sentinel 清单文档,禁止新增同类 |

实施节奏:每条独立 blast-radius 评估 + 独立测试;触发真实流量报错=暴露存量错身份,是目的不是事故。

## 6. spawn 边界身份卫生(I5,与 FLY-1715 的分界)

**本单落**(实测有缺口的 seam,R1-5 修正范围):
- **Claude** `TmuxAdapter.ts` Runner 开窗 `-e` 列表补齐:显式置空/覆写裸名族(`LEAD_ID=`、`DISCORD_STATE_DIR=`、`DISCORD_BOT_TOKEN=`、`PROJECT_NAME=<canonical>`)——嵌合体结构性复现通道就此关闭;
- `lead-body.sh` source `~/.flywheel/.env`(`set -a`)前后:身份键族 snapshot→还原(现状只防 token/carrier 两族,扩到 `LEAD_ID`/`FLYWHEEL_LEAD_ID`/`DISCORD_STATE_DIR`/`PROJECT_NAME`);
- **Codex runner 侧不改**:`CodexTmuxAdapter`+`codex-home` 已有 `stripInheritedSecretEnv` 全量清洗(实测 `CodexTmuxAdapter.ts:1406-1475`),只补「祖先污染」负测锁住现有 allowlist,不新增重复清洗实现。

**FLY-1715 落**(接口):全 spawn 面盘点、非 Lead 进程禁载 Discord plugin、adapter census、污染 server 退场。本单交付「身份 env 合同」文档节,1715 横扫。

**语义澄清入文档**:`FLYWHEEL_LEAD_ID` 统一定义为「本进程所属的 Lead lane」(Lead=自己,Runner=owner)。改名方案(`FLYWHEEL_OWNER_LEAD_ID`)评估后不做:消费面太宽,收益仅命名清晰;两义的实际危险由 1715+1710 gate 结构性消除。

## 7. 数据迁移(先数据、后代码,不加 flag)

1. **botUserId 0/16 → 16/16**(与 FLY-1710 §9.1 共用工序,归属本单):Discord Developer Portal 独立建 16-row expected roster → `env -i` 干净环境逐 token 调 `/users/@me` 只取 snowflake → 与 roster exact-diff 一致才原子写 registry → 写后全量 diff。任何不一致/继承 token abort。
2. **QA slot registry 生成升级**(§2.3,B1 硬前置):botAppId→botUserId、slot state dir→discordStateDir,三条生成路径 + schema 测试 + preflight E2E。
3. **state-dir 杂散清账**(1710 §9.1 已列,归属本单执行序):`~/.claude/channels/*` 逐目录 = 某 registry 行 canonical dir,或取证退休。
4. **部署顺序**:registry 数据齐 → resolver+断言代码上线(managed Lead 缺 botUserId 此时=fail-loud,数据已齐故无需过渡 flag)→ fail-loud 清扫逐条上。回滚=回退 release + registry snapshot;不提供 legacy 身份模式。

## 8. TDD 与验收

**RED 夹具(核心)**:
1. 污染 lineage 夹具(1710 §8.2 同形):parent env 带 eng 的 `LEAD_ID`/`DISCORD_STATE_DIR`/token,请求 product 身份 → launcher 只产出 product canonical 投影;A1 在 login 前 fail-loud;child 环境无未 allowlist 的身份键;
2. resolver 合同:缺行/多行/botUserId 缺失/重复/**裸名跨 project 撞车**/state-dir 冲突(含「显式指向他行派生默认」与「合法但尚不存在的目录」两类,R2-6)→ 逐一结构化报错;同输入幂等同输出;digest 稳定性;manifest 顶层身份字段出现 → 拒绝不取值(R2-4);
3. A2:login id ≠ expected → 退出且零 handler 注册(Claude/Codex parity fixtures 双路径同判);
4. A3/A4 收紧:Lead 语义 + registry 缺行 → 拒绝(不再 unprotected);digest 漂移 → fail-closed;**{absent, ambiguous, source_error, digest mismatch} × {off, audit_only, enforce, BYPASS} 全矩阵在 CommDB mutation 前拒绝(R2-2)**;lease `identity_digest` NULL 行拒绝放行(必须重启重获);Claude lease / Codex carrier 各验「改本行拒绝、改别行不误 fence」(R2-1);unset 全部身份 marker 不能降级为 unprotected(R2-3);
5. fallback 清扫回归:token 缺失=Bridge 拒启清单项;`ack` 无身份报错;路由无唯一 Lead 不铸 `"unknown"`;
6. spawn 卫生:共享 server global env 注入裸名旧值 → Claude Runner 窗内验证清除;`.env` 注入身份键 → body 内验证无效;Codex runner 祖先污染负测(锁 allowlist);
7. 失败合同负测(按断言分层,R3-1/R3-2):A1/A3 失败=零 fetch;Codex A2 失败=恰一次 `/users/@me` 且零其他 URL/零写;Claude A2 失败=允许 login 握手但 send/handler/persistence 全零;三者共同断言零 CommDB Lead 行;marker 验 selectorDigest 命名、0600、write+fsync+rename、无 secret、写失败仍退出——**不验 Bridge 拾取**(已移出本单);
8. 存量兼容哨兵:v2 全 16 Lead 现有 manifest/plist/lease key 在新 resolver 下输出逐字节等值(部署零漂移证明);QA slot 生成 registry 过同一校验。

**真机 QA(独立 QA 节点)**:529 隔离房重演嵌合体(祖先污染 env 起 slot Lead + runner)→ 修后 A1 拦截 + 全链零错铸;全舰重启后 16/16 Lead login 断言通过、lease/label/manifest 三方对账绿。

**全仓门**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + shell harness;两仓(主仓+plugin fork)exact-head code review。

## 9. 实施批次与 rollout/rollback(R1-6 顺序修正)

| 批 | 内容 | 依赖 |
|---|---|---|
| B0 数据 | botUserId roster 迁移工具 + 16/16 落 registry;state-dir 清账;registry 校验(裸名唯一等) | — |
| B1 resolver | lead-identity.ts + CLI + ProjectConfig 校验并入 + wrapper-v2/claude-lead.sh/codex launcher 全矩阵消费 + A1 + A3/A4 收紧(`lead_lease.identity_digest` 列 + mode/bypass 前置硬拒绝 + 双入口 authority)+ **manifest 生产者矩阵**(materializer/lead-body/QA 停写停读顶层 botTokenEnv)+ spawn 卫生 + **QA slot registry 生成升级** | B0 |
| B2 断言 | plugin fork login 断言 + Codex gateway 断言(A2) | **B0+B1**(expected id 投影必须先在场) |
| B3 清扫 | fail-loud 清单逐条(§5) | B1 |

**Rollout runbook(plugin cache 是 fleet 共享,顺序即安全)**:
1. B0 数据落 registry(离线校验绿);
2. B1 主仓 release 部署 + 全舰重启;restart lock 内先验证/物化显式 `TEAMLEAD_DEFAULT_LEAD_AGENT`,失败发生在停 Bridge 之前;随后验证 16/16 manifest/plist/lease 等值哨兵 + 投影在场(`DISCORD_EXPECTED_BOT_USER_ID` 非空);
3. B2 plugin exact head 先进 529 QA 房验证(污染夹具 + 正常登录);
4. 单 Lead canary(建议 claude-infra-bot-lead)restart + 观察窗;
5. fleet restart 全量生效;
6. **回滚顺序相反**:先退 plugin(B1 投影对旧 plugin 是多余 env,兼容)再退主仓 release;记录每阶段 exact heads 与进入/退出条件。

## 10. 与在飞设计线的接口

- **FLY-1710(已下线并入本单参考料)**:ChannelAuthority 编译与铸权 gate 是同一 compiler 的第二产物,不在本单批次;本单交付其 §6.1 点名的全部前置。
- **FLY-1715**:消费本单「身份 env 合同」;spawn 全面盘点与 census 归它;本单只修实测有缺口的 Claude 侧 seam。
- **FLY-1725**:销账键消费 canonical leadId;本单保证其稳定性。

## 11. 明确不做

- 不做 Lead 改名/迁移 project 的在线迁移协议(改名=新身份;存量 DB 裸字符串按现状,读侧守卫样板已推广,历史行不回填);
- 不给 DB 加外键/不重写存量表;
- 不动 GitHub 面(全舰 2 身份是 founder 级信任决策,记录边界,后续单独立单);
- 不做 `FLYWHEEL_LEAD_ID` 改名(§6 已评估否决);
- 不新增 feature flag / dual mode / legacy 身份路径 / 「硬编码双保险」过渡(R1-5:它就是第二身份声明);
- 不建 per-Lead quarantine/降级子系统(R1-7:Bridge 整体拒启是唯一失败粒度);
- 不在本单杀进程、改生产 ACL、轮换 token(FLY-1715/运维 follow-up);
- 不动 tmux 去身份化命名与 socket hash 派生;`FLYWHEEL_CODEX_LEAD_STATE_DIR`(Codex 记忆)不纳入 Discord 身份合同。

## 12. 风险与开放问题

| 风险 | 处置 |
|---|---|
| fail-loud 清扫暴露存量错身份流量 | 逐条独立上线 + 告警观察窗;这是设计目的 |
| Bridge 整体拒启粒度大 | fleet 写入侧同校验兜住绝大多数;拒启只发生在带外手改后,且启动日志逐条列错,修复路径直白 |
| plugin fork 全舰同时生效 | §9 runbook:QA 房→canary→fleet;回滚先 plugin 后主仓 |
| `FLYWHEEL_PROJECTS` env 整库覆盖口 | resolver 不读它;不投影进 Lead;Bridge 自身入口保留现状并记录为已知边界,收口时机随 1715 census 观察再议 |
| bespoke launcher selector 硬编码残留(project+lead) | 允许:selector 不是身份事实,只是「我要启动谁」;身份事实全部经 resolver |
