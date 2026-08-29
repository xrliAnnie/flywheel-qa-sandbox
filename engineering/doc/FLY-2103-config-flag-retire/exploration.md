# FLY-2103 config.yaml flag 退役(Batch C) — 探索
Issue: FLY-2103 (https://linear.app/geoforge3d/issue/FLY-2103/flagcconfigyaml-退役-9-个-project-config-flag-处置checkpointsenabled)
日期: 2026-08-28
基于: 无(上游 FLY-2100 / FLY-2101 / FLY-2102 已 merge,其 plan 为背景)

## 1. 问题

config.yaml 里还剩 **9 个 project_config flag**,是 flag 治理三批清理的最后一批(C 单):

- A 单 FLY-2100(已 merge #971):`flag_values` 加 `(flag_name, scope)` 复合 PK,5 个 project flag 入
  `PROJECT_STORE_MANAGED_FLAGS` 白名单,**但只有显示面读 DB,运行时仍读 config.yaml**
  (`runtimeDivergence: "config_pending_cutover"` 黄标就是这个分歧窗口)。
- B1 FLY-2101(已 merge #974)/ B2 FLY-2102(已 merge #970):env flag 侧固化/冻结完毕。
- **本单(C)**:2 个固化删、7 个迁 DB 成为**运行时真源**、6 个项目 config.yaml 删 flag key、
  ConfigLoader 对残留 key fail-loud 报错、删 A 单留下的 config 回落路。

## 2. 现状盘点(2026-08-28 实查 6 个项目 config.yaml)

| flag | configKey | 处置 | 现值(实查) |
|---|---|---|---|
| checkpoint_enabled | `checkpoints.*.enabled` | **固化删** | 6 项目所有已声明 checkpoint 全 `true`,从没 false 过 |
| xiaohongshu_auto_create | `xiaohongshu_learning.collections[].auto_create` | **固化删**(写死 true) | 无任何项目设过(collections 全空) |
| doc_flow | `doc_flow.enabled` | 迁 DB | flywheel / joycon-typeless / personal-assistant / tidal-echo = true;geoforge3d / growth 无块 |
| pipeline_dag | `pipeline.dag` | 迁 DB | 仅 flywheel = true;其余无块 |
| pipeline_work_kind | `pipeline.work_kind` | 迁 DB | 仅 flywheel = true |
| proofshot | `skills.proofshot.enabled` | 迁 DB | 无项目设过 |
| xiaohongshu_learning | `xiaohongshu_learning.enabled` | 迁 DB | 无项目设过 |
| ponytail | `ponytail.enabled` | 迁 DB(`*`=false) | 无项目设过;FLY-615 项目层 dormant |
| skill_framework_split_participation | `skill_framework.split` | 迁 DB(过渡,FLY-1834 结账后连 skill_framework_mode 一起删) | 无项目设过 |

6 个项目 = geoforge3d / joycon-typeless / personal-assistant / growth / flywheel / tidal-echo
(`~/.flywheel/projects.json` 实查)。

## 3. 关键发现(影响设计的事实)

### F1. pipeline_dag 的 registry default 和运行时语义已经分裂
`loadWorkKindConfigStrict`(pipeline-config-source.ts:37)对「无 config 文件 / 无 pipeline 块」返回
**dag: true**(FLY-1981 fleet 迁移:缺省即 DAG-on,只有显式 `dag: false` 才关);而 registry spec 写的是
`polarity: opt_in, default: false`。今天管理台对 5 个无块项目显示 `false (default)`,运行时却按 DAG-on
跑 —— **显示层一直在说谎**。迁 DB 后「无行 → registry default」成为唯一回落,default 必须翻转为
`true`(polarity `default_on`),否则 5 个项目的 DAG enrollment 会静默关掉 = 重大行为变化。

### F2. ponytail 的 `{enabled:false}` 与 `undefined` 在 resolver 里字节等价
`resolvePonytail`(ponytail.ts:116)`projectOn = projectConfig?.enabled === true`;labels-unreadable
分支(:124)与 project 层命中分支(:150)都只看 `=== true`。所以给运行时接一个恒为 `*`=false 的
store 读是**行为中立**的 —— per-issue label 路(FLY-615 v1)完全不受影响。

### F3. 授权门 project 分支拒绝 dormant / readonly
`validateFlagAuthoringPolicy` 的 project-store 分支要求
`!dormant && toggleable !== 'readonly'`(store-policy.ts:232-249)。要把 ponytail(dormant + readonly)
和 skill_framework_split_participation(readonly)放进 `PROJECT_STORE_MANAGED_FLAGS`,要么改门
(加豁免 = 长机制,founder 红线「只删不加」),要么改 spec 使其如实通过。

### F4. 读点分三种时机,迁移后要统一为 call-time store 读
- 构造期读(Bridge boot 一次):doc_flow / checkpoints / proofshot(skillsConfig)→ run-infra.ts:997-1027
  一次 ConfigLoader.load,传入 Blueprint / DirectEventSink 构造函数。
- 每次 dispatch 新鲜读:pipeline.dag / work_kind(loadWorkKindConfigStrict,runs-route.ts:2116 +
  workkind-cutover.ts:784)、skill_framework.split(makeSkillFrameworkParticipationReader)。
- 无生产读点:ponytail(dormant)、xiaohongshu_learning(scheduler 是 gated-pilot 脚本,plist 未装)。

DB store 的意义就是 CLI 写秒级生效(FLY-1778 先例:`storeSkillFrameworkModeControl` closure),
所以迁移后统一为 **call-time closure 读**,不能退化成 boot 快照。

### F5. ffConfigCache 不能删
plugin.ts 的 `ffConfigCache`(ProjectConfigCache)还服务 management console 的 runner 默认模型、
cron 模型、SSOT providers、existing writers 等非 flag 消费者。「删 config 回落路」只删 flag 解析
对它的消费(resolve.ts 的 projectConfigs ctx / resolveConfigValue),缓存本体保留。

### F6. 两处 shape 语义变化(live 数据无此形,但要写明)
- checkpoint:今天 `enabled` 缺省 = **disabled**(Blueprint:2294 `if (!cpConfig.enabled) continue`)。
  固化后「声明即启用」,声明了但没写 enabled 的 checkpoint 从 skip 变为启用。实查 6 项目全部显式
  `enabled: true`,零行为变化;shape 语义变化按 issue 定案有意为之。
- xiaohongshu_learning:「enabled=true 必须有非空 collections」的 load-time 校验(ConfigLoader:593)
  随 enabled key 一起死。改为 scheduler 运行时:store-on 而 collections 空 → 显式日志跳过。

### F7. 部署时序有一个真实的窗口问题
ConfigLoader 拒残留 key 一旦部署,而某项目 config.yaml 还带 key → 该项目 setup 失败(fail-loud,
但是坏的那种)。反过来,config key 先删而新代码未部署 → 老代码 call-time 读(仅 flywheel 的
work_kind)在窗口内掉回 false。顺序必须是:**merge 代码 → 跑迁移种子 → merge 6 个 config PR →
00:00/12:00 班车统一部署**(FLY-1959 部署解耦正好兜住:main checkout 在部署时才 pull,代码与
flywheel 自己的 config.yaml 原子落地)。详见 plan「部署时序」。

### F8. 迁移脚本不能直写 SQLite
StateStore 是 sql.js(整文件载入内存再持久化),第二进程并发写 = clobber。FLY-2100 定了
**唯一写入执行面 = CLI → `/api/fleet/flag/stage|apply`**。迁移脚本读侧可只读打开 DB(或 raw yaml),
写侧必须走 Bridge API(等价 `feature-flags set --project`)。另:老 Bridge 的白名单编译死在代码里
(5 个),ponytail / split 的行要等新代码部署后才写得进去 → 脚本幂等、跑两遍(部署前 + 部署后)。

## 4. 选项与裁决

### D1. ponytail 怎么「迁 DB」:保 dormant vs 激活 store 读
- **P1 保 dormant**:行进 DB 但运行时不接线。代价:授权门要为 dormant/readonly 开豁免(长机制,
  违反「只删不加」);且「一行没人读」不算迁移。
- **P2 激活 call-time store 读(定稿)**:run-infra 删「deliberately do NOT load」块,给 Blueprint 传
  store reader closure;`*`=false 行使所有项目恒 OFF(F2 证明字节等价);spec 删 `dormant`、
  `toggleable` readonly→conversational;门一字不改。FLY-615 例外保留 = `*`=false + per-issue label 路
  不动;未来 v2 rollout 变成一条 CLI 命令而非改代码。
- 净效果:删掉 dormant 特例 + run-infra 注释块 + ConfigLoader ponytail 校验,零新增机制。
- ⚠️ 此裁决把「per-project rollout 的杠杆」从『改代码』降为『CLI 写一行』——设计评审/founder 页
  明示,可否决回 P1。

### D2. skill_framework_split_participation:readonly → conversational
readonly 的语义本来是「没有写路径(只能手改 config.yaml)」。config key 删掉后,scoped CLI 写
(`feature-flags set skill_framework_split_participation --project X --to off`)成为唯一杠杆,如实标
conversational。fail-closed 合同保留:store 读抛错 → 项目钉回 A 臂 + warn(与今天 config 读抛错
同形)。

### D3. pipeline_dag registry default:false → true(polarity default_on)
对齐 F1 的运行时真相。显示层从此诚实(resolver 对照会显示 5 个项目 false→true 的**显示**差,
行为零变化,QA 报告如实标注)。备选「迁移写 6 行 `*`=true」被否:用数据行掩盖名册谎言,行是
状态、default 是合同,合同该改就改合同。

### D4. 固化删的两个 flag:照 FLY-2101 模式,不留 tombstone
registry spec 直删、`LEGACY_UNMANAGED_BASELINE` 9→7(FLY-2101 先例:退役即从 ledger 删名)。
7 个迁移 flag 留在 baseline(FLY-2100 先例:成员同时在 baseline 与 project 集时 baseline 条目惰性,
它是「不可增长的历史 maximum ledger」,不因迁移而删名)。

### D5. 迁移后 registry spec 的形态:source/configKey 保留
授权门 project 分支要求 `source === 'project_config' && configKey 存在`。configKey 从「运行时读的
路径」降格为「名册身份 + ConfigLoader 拒绝信息的锚点」。readSites 全部改为 delegated
flag-store-runtime 命名 wrapper(与 global store flag 同形),不再有 `pattern: "config"` 站点。
验收 rg 的「读点层零命中」以此达成;registry/truth 名册内的 configKey 字符串是数据不是读点。

## 5. 与验收的对应

| 验收 | 对应设计 |
|---|---|
| 迁移前后行为零变化(resolver 对照 6 项目) | F1/F2 两个字节等价证明 + Step 7 隔离真 Bridge 前后快照 |
| rg 读点层零命中 | D5(readSites 全 delegated)+ 各读点逐个切换 |
| ConfigLoader 残留 key 报错测试 | Step 4 每 key 一条 RED 测试 |
