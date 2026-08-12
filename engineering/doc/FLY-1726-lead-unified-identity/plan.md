# FLY-1726 Lead 统一 Identity — 实施计划(单一权威源方案)

Issue: FLY-1726 (https://linear.app/geoforge3d/issue/FLY-1726/设计议题基础层-lead-统一-identity-身份在-n-处以不同形式表现无单一权威今日三重嵌合体活爆雷标本annie-直令立单)
日期: 2026-08-12
基于: research.md

## 0. 一句话

registry 行(`~/.flywheel/projects.json` 的 `projectName` + `leads[].agentId`)成为 Lead 身份的**唯一权威源**;一个 **resolver 单实现**把它编译成 immutable 的 `CanonicalLeadIdentity`;其余每一张「脸」(env、state dir、token、bot id、lease key、Agent Team 名、launchd/manifest 键)都改为**该对象的派生投影**;三道**启动断言**(env 一致性、login bot-id、lease bind)让任何拼装错误在产生副作用前 fail-loud;身份缺失一律报错,**不再有静默 fallback 和 sentinel 默认值**。

## 1. 目标不变量(验收即验这五条)

| # | 不变量 | 违反时的行为 |
|---|---|---|
| I1 单源 | 身份事实只在 registry 行声明一次;其余全部派生,无第二处手填 | 配置校验 fail-loud(Bridge 拒启 / fleet 写入拒绝) |
| I2 一次解析 | 一个 Lead 进程一生恰一次 resolve;launcher→pane→adapter→写边界持同一 immutable 对象 | 重复/冲突 resolve = 启动失败 |
| I3 启动断言 | env 一致性(A1)、login bot-id(A2)、lease bind(A3,已有)全过才注册任何 handler | 任一断言失败=进程退出,零 inbound/outbound/铸章副作用 |
| I4 不自证 | 期望值(botUserId)只来自 registry 登记;禁止从 token/`/users/@me` 运行时派生期望值 | resolver 对 managed Lead 缺 botUserId 直接报错 |
| I5 不外溢 | 身份/secret env 不隐式穿越 spawn 边界;每个边界要么显式设全套一致值,要么显式清除 | 夹具测试:祖先污染环境下 child 只能拿到 canonical 投影 |

## 2. 数据模型

### 2.1 CanonicalLeadIdentity(运行时只读对象)

```ts
// packages/flywheel-comm/src/lead-identity.ts(新;底座=现有 canonical-lead.ts)
export interface CanonicalLeadIdentity {
  schemaVersion: 1;
  leadId: string;          // ≡ registry leads[].agentId — 裸形态唯一合法来源
  projectName: string;
  leadKey: string;         // `${projectName}-${leadId}` — dash 复合键唯一合法派生点
  agentTeamName: string;   // ≡ leadId — Agent Team 邮箱 teamName 的显式化(path-helpers 合同不变)
  botUserId: string | null;   // registry 独立登记的 Discord snowflake;managed Lead 必非空(见 §3)
  botTokenEnv: string | null; // secret selector(env 名);token 值绝不进对象
  discordStateDir: string;    // 解析后的绝对路径(§2.3 优先级)
  backend: "claude-code" | "codex-app-server";
  role: "cos" | "dept" | "companion" | "external"; // 由现有 registry 查询规则派生(companion/external 字段 + CoS 结构等式)
}
```

与 FLY-1710 redo-design §3.1 的接口合同兼容(其要求字段是本对象子集)。对象在进程内 **frozen**;`leadId`/`botUserId` 生命周期内不可变。

### 2.2 registry schema 增量(ProjectConfig)

```ts
export interface LeadConfig {
  // …现有字段不动…
  botUserId?: string;        // 新:^[0-9]{17,20}$;全局唯一;managed Discord Lead(有 botTokenEnv)最终必填
  discordStateDir?: string;  // 新(来自 #815 schema,数据重裁):绝对路径;缺省走派生规则
}
```

校验(并入 `parseAndValidateProjects` 唯一校验权威):
- `botUserId` grammar + **全局唯一**(跨 project);
- `discordStateDir` 必须绝对路径、无控制字符;两行不得声明同一目录;
- managed Discord Lead(`botTokenEnv` 非空)缺 `botUserId` 的 fail-loud **由 resolver 执行**(§6 数据先行,不加模式 flag)。

### 2.3 派生规则(全部收进 resolver,别处删除)

| 面 | 规则 | 取代的现状 |
|---|---|---|
| leadKey / manifest 名 / launchd label / lease key | `${projectName}-${leadId}`(经 `resolveCanonicalLead`) | 各脚本手拼(保留,但断言与 resolver 输出一致) |
| socket | 现状不动:`sha256("<project>/<leadId>")` 派生,消费者重派生比对 | ✅ 已是健康形态 |
| discordStateDir | manifest `launchEnvironment.DISCORD_STATE_DIR`(provisioner 显式声明,QA 房用)> registry `discordStateDir` > 派生 `~/.claude/channels/discord-<leadId>`;**ambient env 永不参与** | `claude-lead.sh:183` 继承优先 / wrapper-v2 `:221` 双实现 / #815 bash 第三实现 |
| token | `botTokenEnv` 名→父进程解引用取值→只以泛名 `DISCORD_BOT_TOKEN` 投影进本 Lead 私有 server env;解析失败=启动失败 | `ProjectConfig.ts:328` warn+回落全局 token |
| expected bot id | registry `botUserId` 原样投影(`DISCORD_EXPECTED_BOT_USER_ID`) | roundtable-registry 自报发布(保留为观测,不再是断言依据);voice-routes token 解码(改造为消费 registry) |
| Agent Team | `deriveRunnerMailboxIdentity` / `teamName = leadId` 不变,但输入必须是 canonical `leadId` | ✅ 器官保留 |

## 3. resolver 单实现与消费矩阵

**落点**:`packages/flywheel-comm/src/lead-identity.ts` + CLI 动词 `flywheel-comm lead-identity resolve --project <p> --lead <id> [--manifest <path>] --format env|json`。

理由:teamlead→flywheel-comm 依赖方向成立(实测 package.json),不成环;flywheel-comm 是每个 shell launcher 已在调用的 CLI(lease/agent-team 先例);`canonical-lead.ts`(leadId→leadKey 唯一映射器)就在这里。**teamlead 的 `parseAndValidateProjects` 对身份字段改为 import 本模块的校验函数**——消除现存「flywheel-comm 宽松二号解析器」的双权威(canonical-lead.ts 的 lenient 解析收敛进同一实现)。

失败合同:registry 缺行/多行、grammar 违规、managed Lead 缺 botUserId、state dir 冲突 → CLI 非零退出 + 结构化错误名(`identity_row_missing` / `identity_row_ambiguous` / `identity_bot_user_id_missing` / `identity_state_dir_conflict`…);**调用方一律 fail-closed,禁止任何「解析失败就用旧办法拼」的降级**(1710 裁死 dual-mode)。

| 消费者 | 怎么消费 | 改动 |
|---|---|---|
| `flywheel-lead-wrapper-v2.sh` | 启动时 CLI resolve(输入=manifest 路径),输出 env 投影进 `SERVER_ENV`(env -i 全量替换,现状机制保留) | 删自身的 state-dir/token 拼接,改消费投影;launchEnvironment 身份键与 resolver 输出**不一致即 fail-loud**(治 G6 manifest 冻结错值永续) |
| `claude-lead.sh` | 信任 wrapper 投影 + **A1 断言**(§4);自身 `:183` 派生删除 | pane `-e` 覆写集合从「FLYWHEEL_* 子集」升级为「身份全集」(含裸名) |
| `codex-lead.sh` / Mufasa·claw bespoke launchers | 同样 CLI resolve;硬编码 env 改为断言(硬编码值≠resolver 输出=启动失败,过渡期保留硬编码作双保险) | 消除人肉一致性(companion-lead-ship-discipline 的结构化替代) |
| Codex `codex-lead-runtime.ts` | `req("FLYWHEEL_LEAD_ID")` 等改为消费投影 + 断言 | `FLYWHEEL_LEAD_BOT_USER_ID` 来源改 registry 投影 |
| Discord plugin fork | 新 env `DISCORD_EXPECTED_BOT_USER_ID`(投影);login 后断言(§4 A2) | plugin PR(独立仓,回收 #21 的 login-assertion 器官) |
| Bridge / DirectEventSink / run-dispatcher | `ctx.leadId` 已来自 registry,不变;**读侧守卫推广**:`configuredLead` 样板推到 lead_events 路由 fallback 链(§5) | 删 `cos ?? leads[0] ?? "unknown"` 型编造 |
| FLY-1710 ChannelAuthority compiler | 同一次 resolve/compile 产出(接口合同,实施在 1710 线) | — |
| FLY-1725 销账游标 | 销账键 = `(canonical leadId, cursor)` | 只消费,不实现 |

## 4. 三道启动断言(A 系)

**A1 env 一致性断言**(新,落 `claude-lead.sh` 启动序列最前 + `lead-identity-preflight.sh` 扩展):
- `LEAD_ID`(若存在)== `FLYWHEEL_LEAD_ID` == manifest `leadId` == resolver `leadId`;
- `DISCORD_STATE_DIR`(若存在)== resolver `discordStateDir`;
- `PROJECT_NAME`/`FLYWHEEL_PROJECT_NAME`(若存在)== resolver `projectName`;
- 任一不等 → 打 `lead_identity_conflict` 告警(复用 lease HOLD 告警通道)+ 退出;**绝不静默偏向任何一侧**(#815 保留器官合同)。
- 断言过后,launcher 以 resolver 输出**重设全套**(治「三种寿命」:从此 pane 内三面必同源)。

**A2 login bot-id 断言**(新,两条 adapter 路径):
- Claude plugin:login 完成、**注册任何 inbound handler 之前**,`client.user.id === DISCORD_EXPECTED_BOT_USER_ID`,不等即退出(零副作用);expected 缺失而处于 managed 模式 → 同样退出。
- Codex gateway:startup 用 token 调一次 `/users/@me`,与投影的 expected 比对,不等 fail-loud(现状是「信 env、不验 login」)。
- 断言的期望值只能来自 registry 投影(I4);roundtable-registry 的自报发布保留,仅作观测与 allowBots 物料。

**A3 lease bind**(已有,FLY-1697):不动;lease key 的拼接点改为消费 resolver `leadKey`(值不变,来源单点化)。

**A4 写边界**(已有):`validateLeadWriteAuthorization` 不动,输入语义不变。

## 5. fail-loud 清扫(杀静默 fallback 与 sentinel)

| 现状 | 处置 |
|---|---|
| `ProjectConfig.ts:328-331` botTokenEnv 解析失败→回落全局 `DISCORD_BOT_TOKEN` | 删。managed Lead token 缺失 = 该 Lead 配置错误,fail-loud(Bridge 启动报告,该 Lead 不上线,不拖垮别的 Lead) |
| `bridge/tools.ts:484,619,832`、`lead-inbox-runtime.ts:607` `?? globalBotToken` | 以 Lead 身份发言的路径删 fallback;system sender(LeadAlertNotifier/standup 等)保留自己显式的 system token,不混用 |
| flywheel-comm `ack` 默认 `"lead"`(`index.ts:383`) | 必填化:`--lead` 或 env 双缺 = 报错退出 |
| `plugin.ts:4861` `cos ?? leads[0] ?? "unknown"` | 路由不出唯一 Lead = 显式错误事件进告警,不铸 `"unknown"` 行 |
| `config.ts:136-138` `TEAMLEAD_DEFAULT_LEAD_AGENT="product-lead"` | 删默认值;消费点必须显式给 Lead |
| `flywheel-restart-guard.py:337` 兜底 `"flywheel-eng-lead"` | 改为 `--lead` 缺失 = 告警落 system 名义并标注 `lead_unknown`,不冒名 |
| `runs-route.ts:1583` `"unassigned"` | 保留(它是诚实的「未选定」语义且已有读侧守卫 `configuredLead`),但纳入 sentinel 清单文档,禁止新增同类 |

实施节奏:每条单独 blast-radius 评估 + 独立测试;这是**行为收紧**,任何一条如触发真实流量报错,说明那里本来就在错身份下运行——这正是要暴露的。

## 6. spawn 边界身份卫生(I5,与 FLY-1715 的分界)

**本单落**(两处最热的 seam):
- `TmuxAdapter.ts` / `CodexTmuxAdapter.ts` Runner 开窗 `-e` 列表补齐:显式置空/覆写裸名族(`LEAD_ID=`、`DISCORD_STATE_DIR=`、`DISCORD_BOT_TOKEN=`、`PROJECT_NAME=<canonical>`)——嵌合体的结构性复现通道就此关闭(research §4);
- `lead-body.sh` source `~/.flywheel/.env`(`set -a`)前后:身份键族 snapshot→还原(现状只防 token/carrier 两族,扩到 `LEAD_ID`/`FLYWHEEL_LEAD_ID`/`DISCORD_STATE_DIR`/`PROJECT_NAME`)。共享 `.env` 里的身份形状键从此对 Lead 无效。

**FLY-1715 落**(接口):全 spawn 面盘点、非 Lead 进程禁载 Discord plugin、adapter census、污染 server 退场。本单交付「身份 env 合同」文档节(哪些名字构成身份、边界规则、断言工具函数),1715 拿去横扫。

**语义澄清入文档**:`FLYWHEEL_LEAD_ID` 语义统一定义为「本进程所属的 Lead lane」(Lead 进程=自己,Runner=owner)。改名方案(`FLYWHEEL_OWNER_LEAD_ID`)评估后**不做**:消费面太宽(terminal-mcp/inbox-mcp/hooks),收益仅是命名清晰;两义的实际危险(Runner 载 adapter 铸章)由 1715+1710 gate 结构性消除。

## 7. 数据迁移(先数据、后代码,不加 flag)

1. **botUserId 0/16 → 16/16**(与 FLY-1710 §9.1 第 1 步共用工序,归属本单):Discord Developer Portal 独立建 16-row expected roster → `env -i` 干净环境逐 token 调 `/users/@me` 只取 snowflake → 与 roster exact-diff 一致才原子写 registry → 写后再全量 diff。任何不一致/继承 token abort。QA slot 用 `test-slots.json` 已有 `botAppId`。
2. **state-dir 杂散清账**(1710 §9.1 已列,归属本单执行序):`~/.claude/channels/*` 逐目录 = 某 registry 行 canonical dir,或取证退休(`discord`、`discord-peter`、`discord-oliver`、`discord-belle`、`discord-anna-interviewer-lead`…)。
3. **部署顺序**:registry 数据齐 → resolver+断言代码上线(managed Lead 缺 botUserId 此时=fail-loud,因数据已齐,无需过渡 flag)→ fail-loud 清扫逐条上。回滚=回退 release + registry snapshot;**不提供 legacy 身份模式**。

## 8. TDD 与验收

**RED 夹具(核心)**:
1. 污染 lineage 夹具(1710 §8.2 同形):parent env 带 eng 的 `LEAD_ID`/`DISCORD_STATE_DIR`/token,请求 product 身份 → launcher 只产出 product canonical 投影;A1 在 login 前 fail-loud;child 环境无未 allowlist 的身份键;
2. resolver 合同:缺行/多行/botUserId 缺失/重复/state-dir 冲突/`FLYWHEEL_PROJECTS` 覆盖面 → 逐一结构化报错;同输入幂等同输出;
3. A2:login id ≠ expected → 退出且零 handler 注册(Claude/Codex parity fixtures 双路径同判);
4. fallback 清扫回归:token 缺失不再借全局 token;`ack` 无身份报错;路由无唯一 Lead 不铸 `"unknown"`;
5. spawn 卫生:共享 server global env 注入裸名旧值 → Runner 窗内验证清除;`.env` 注入身份键 → body 内验证无效;
6. 存量兼容哨兵:v2 全 16 Lead 现有 manifest/plist/lease key 在新 resolver 下输出逐字节等值(部署零漂移证明)。

**真机 QA(独立 QA 节点)**:529 隔离房重演嵌合体(祖先污染 env 起 slot Lead + runner)→ 修后 A1 拦截 + 全链零错铸;全舰重启后 16/16 Lead login 断言通过、lease/label/manifest 三方对账绿。

**全仓门**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + shell harness;两仓(主仓+plugin fork)exact-head code review。

## 9. 实施批次(交给后继 implement 节点的切分)

| 批 | 内容 | 独立可 ship |
|---|---|---|
| B0 数据 | botUserId roster 迁移工具 + 16/16 落 registry;state-dir 清账 | ✅(纯数据+校验) |
| B1 resolver | lead-identity.ts + CLI + ProjectConfig 校验并入 + wrapper-v2/claude-lead.sh/codex launcher 消费 + A1 + spawn 卫生两 seam | ✅(行为等值哨兵护航) |
| B2 断言 | plugin fork login 断言 + Codex gateway 断言(A2) | ✅(依赖 B0 数据) |
| B3 清扫 | fail-loud 清单逐条(§5) | 每条独立 |

## 10. 与在飞设计线的接口(复述边界)

- **FLY-1710(已下线并入本单参考料)**:其 ChannelAuthority 编译与 ingest/outbound 铸权 gate 是**同一 compiler 的第二产物**,不在本单实施批次;本单交付其 §6.1 点名的全部前置(canonical schema/唯一解析/secret 边界/immutable 交付/login 断言/fail-loud 合同)。
- **FLY-1715**:消费本单的「身份 env 合同」;spawn 全面盘点与 census 归它;本单只修两处最热 seam。
- **FLY-1725**:销账键消费 canonical leadId;本单保证其稳定性。

## 11. 明确不做

- 不做 Lead 改名/迁移 project 的在线迁移协议(改名=新身份;存量 DB 裸字符串按现状,读侧守卫样板已推广,历史行不回填);
- 不给 DB 加外键/不重写存量表(producer 端正名即可,大改无增量安全);
- 不动 GitHub 面(全舰 2 身份是 founder 级信任决策,记录边界,后续单独立单);
- 不做 `FLYWHEEL_LEAD_ID` 改名(§6 已评估否决);
- 不新增 feature flag / dual mode / legacy 身份路径(FLY-1466 铁律 + 1710 裁定);
- 不在本单杀进程、改生产 ACL、轮换 token(FLY-1715/运维 follow-up);
- 不动 tmux 去身份化命名(`main`/`%0`)与 socket hash 派生(已是正确形态)。

## 12. 风险与开放问题

| 风险 | 处置 |
|---|---|
| fail-loud 清扫暴露存量错身份流量 | 逐条独立上线 + 告警观察窗;这是设计目的不是事故 |
| plugin fork 是 fleet 共享 cache,断言上线=全舰同时生效 | B2 跟全舰重启窗;plugin 版本回退是 fleet 级动作(1710 已记) |
| bespoke Codex launcher 断言与硬编码双保险期 | 一个版本窗后删硬编码,只留 resolver 消费 |
| `FLYWHEEL_PROJECTS` env 覆盖仍是整库逃生口 | resolver 记录 source_kind 进断言错误与 sender_ref;彻底收口留给 1715 census 观察后再议 |
