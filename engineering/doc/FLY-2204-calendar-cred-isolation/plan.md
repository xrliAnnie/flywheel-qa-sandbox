# FLY-2204 隔离 founder 日历写凭据 — 实施计划
Issue: FLY-2204 (https://linear.app/geoforge3d/issue/FLY-2204/治理-隔离-founder-google-calendar-写凭据agent-上下文不可读)
日期: 2026-08-31
基于: exploration.md, research.md

## 0. 目标与成功条件

给 FLY-2137 的行为护栏补上它自己承认缺失的那半:**真正的授权边界 = 凭据隔离**。达成后
agent 上下文里**既没有日历写 scope、也读不到写凭据、也无法伪造输入或直调 writer**;唯一自动写入
方 = 一个**最小化 calendar-writer 服务**,只接受**一个无 agent 的 meeting-ingress 进程**的请求,
由**机器**(OAuth grant scope + POSIX uid 权限 + Google ACL)强制。

成功条件(全部要**可执行证据**,按控制面分别断言精确错误,不用「任意 403」):
1. **founder uid** 上不存在任何能写 founder 日历的凭据,**且历史可写 grant 已注销**:founder uid
   的 gog/gws grant 重授为**不含 calendar 写 scope**;**旧的可写 grant server-side revoke**,并做
   **凭据 inventory**(所有 gog keyring/gws credentials.enc/`auth tokens export`/备份);负探针用
   **旧 grant** 也必须失效(§7,精确错误见 §3.3);
2. **持写凭据的 uid(W)不运行任何 LLM/agent 或用户码**;**调用 writer 的权限**也与 agent 分开——
   writer 只 allowlist 一个**不 spawn agent 的 meeting-ingress uid(I)**;运行 Codex/voice 的
   uid(A)**既无 Calendar 凭据、也无 writer 调用权**(codex R2 Blocker 1;A/I 均无 **Calendar** 凭据,
   但 I 持排会用 Discord listener token、A 持非日历凭据,§1.3);
3. 写凭据 agent 读不到(§7 从 founder uid agent **与 Raya 自身 Codex 子进程两侧**都 Permission
   denied);且 **Codex 子进程直调 writer 被拒**(peer uid ≠ I,且 founder 日历零 mutation);
4. agent 无法伪造 writer 输入:文件面(W/I 的 state 0700)+ ingress 面(Discord 触发身份 + QA
   allowlist 全列 + 逐个负探针,§5);
5. QA 写入只落**独立测试日历**;QA 账号对**显式 founder calendar ID** 无 ACL(owner 侧 ACL
   inventory 证明 + QA 侧得 **404 notFound / 明确 authz 拒绝**,§3.3);激活 FLY-2137 P6 QA 豁免;
6. 迁移/轮换、**冷启动恢复**、**有序回滚**、负向越权探针都有证据;FLY-2130 create/cancel 正路无
   回归,事件落在**显式 founder calendar**(读回 organizer/owner 佐证);
7. FLY-2137 sweep 用其**独立 OAuth client 的 calendar.readonly 凭据**仍只读扫描成功(§3.2);
8. **威胁模型边界成文**(§5):治理机器 OAuth/CLI 凭据 + Raya 自动 ingress;显式排除已登录浏览器
   GUI / founder Discord 人类会话;「唯一自动写入方」声明**限定**在此范围;
9. 回链 FLY-2137,使其「唯一自动写入方」获机器强制。

**本单是设计+决策节点**:三方案(A/B/C)成本/边界/founder 操作各异,A/B 都要求**动 founder 机器
系统层**(建角色用户)——只有 founder 能拍。本节点交付三案并陈 + 技术判定,**不预设默认**(Lead
裁定 026);Lead 将与 FLY-2137 规矩合成「日历安全决策包」给 founder 拍;拍板后才进 implement。

## 1. 三角色 uid 拓扑 —— codex R1 Blocker1 + R2 Blocker1 的结构性核心

> 教训链:①持 token 的 uid 决定 TCB(R1);②但**光把 token 与 agent 分 uid 还不够**——writer 的
> **调用权**也必须与 agent 分开。`LOCAL_PEERCRED` 只认 uid;若「可信 Raya」与它 spawn 的 Codex
> **同 uid**,writer 分不清二者,Codex 子进程可构造合法请求直接调用 writer(R2)。

故拆**三个角色 uid**,各自最小、职责单一:

```
uid A —— agent 域(可留 founder gui uid 或另设):Raya brain/voice + Codex(probeCodex /
         buildThreadStartParams)。 **无 Calendar 凭据**(仍持非日历凭据如语音相关)、无 writer
         调用权、无 W/I 的 socket/inbox/签名钥匙。
   │  (A 与 meeting 无直接写路径;voice 保留其 gui-domain supervisor,见下)
   ▼  仅通过 Discord/既有渠道把「founder 排会意图」交给 I —— 但 I 自己独立监听 founder,
      不信任 A 的转述(A 不是 writer 的授权来源)

uid I —— meeting-ingress 域(LaunchDaemon,无 agent):最小化 exact-command 解析器 + MeetingController
         (排会/改期/取消,确定性,**不 spawn Codex/LLM/用户码**)。独立持有「排会用」Discord
         listener token(**非 Calendar 凭据**),按 triggerUserIds 门控(§5)。**无 Calendar 凭据**。
         是 writer **唯一** allowlist 的调用方。
   │  单向、经 PEERCRED(peer uid==I)认证的写请求(meetingId 幂等 + nonce 防重放)
   ▼
uid W —— writer 域(LaunchDaemon):最小 calendar-writer + 写 token(gog file keyring 0600)。
         **不 spawn agent、不执行用户码**。private-prop lookup-before-write 幂等 + crash recovery;
         只回「成功/降级」状态,绝不回 token/日历私有内容。
   ▼  founder Google Calendar(**显式 calendar ID**)—— bot(A 方案)/ founder 独立 grant(B 方案)
```

### 1.1 传输合同(codex R3 Blocker1:0700 socket 会先于 PEERCRED 拒掉 uid I)
pathname unix socket 的 `connect(2)` 受**父目录可遍历 + socket 节点可写**的文件系统权限约束——
若父目录/socket 是 **W-only 0700**,uid I **根本连不上**(合法 I→W 路径在 PEERCRED 之前就挂),
uid A 也只是拿到**文件系统错误**、不是「writer 授权拒绝」。故显式定死一套自洽合同:
- 建专用组 **`_rayacal`**,成员 = {uid I, uid W}(仅此二者);
- socket 父目录 `root:_rayacal 0750`(组可遍历)、socket 节点 `W:_rayacal 0660`(组可连);
- **uid A 不在该组** → connect 在**文件系统层**被拒(transport denial,这才是真边界);
- **PEERCRED(euid==I)作纵深**:即便某进程能连,writer 再校验 peer euid==I,拒非 I;
- **诚实标注边界**:7.3b 从 uid A 断言的是 **transport-layer 拒绝**(不是「writer 授权拒绝」,
  因内核 pathname 检查才是实际边界);**另加一个 writer 单元/集成测试**:直接喂 writer 一个
  **非 I peer**,断言它在**任何 Calendar adapter 调用之前**按 PEERCRED 拒绝。

### 1.2 I↔A voice / 生命周期边界合同(codex R3 Blocker2:非「抽个 parser」那么简单)
源码实证:`createMeetingRuntime`(brain/meeting.ts ~640–739/791–813)**拥有并改写 canonical
meeting state、写/清 voice request、直接 `supervisor.start()/stop()`**;
`createLaunchctlVoiceSupervisor(uid)`(voice-mode.ts ~399–405)**硬编码 `gui/${uid}`**,现由 brain
传自身 uid;voice(voice/meeting-context.ts ~20–45)靠**同一 stateDir 同时读** `readVoiceModeRequest`
+ `readCurrentMeeting` 组装上下文。故 I 拥有 MeetingController + I state 0700 后,**A 侧 voice 读不到
meeting/voice 上下文**,且 I-域 daemon **不能复用 gui-域 supervisor**;而给 A 写 I canonical state
= 重开 confused-deputy。**必须先给出下列 normative 合同(implement 前)**:
- **canonical 状态所有者 = uid I**(meeting.json / voice request 由 I 拥有写);
- **I→A 只读投影**:I 把「当前会议只读上下文」投影到 A 可读、**A 不可写**的位置(如 `I:_rayavoice
  0640`,组只读)供 voice 组装话术;投影**不含**任何可驱动写的能力;
- **I→A 能力受限的 voice start/stop 信号**:voice supervisor 留 **A 侧 gui 域**(合同不动),由 I
  发一个**单向、只能「起/停 voice」**的信号给 A;该信号**无法** create/reschedule/cancel 日历事件;
- **A→I 反馈(若有)**:反馈会更新某个 I 拥有的 status/voice 字段(故不能写成「不触发任何 FSM 写」
  的字面绝对);需要的安全属性更窄(codex R4 Medium):A 反馈**不能 schedule/reschedule/cancel 会议、
  不能调用 W、不能改动 Calendar 投影输入**;**只允许一组枚举的 readiness/status 字段转移**,并**测试
  证明它到不了 writer**;
- **两向都认证** + crash/restart/idempotency + 跨边界 schedule/due/ready/cancel 测试。
  (可行形态 = 「I 拥有的只读投影 + A 侧 gui supervisor」,但须**设计**,不能靠推断。)

### 1.3 凭据-principal 不变式(codex R3 Blocker3:A 可读的凭据不得映射到 I 的 allowlist 身份)
`MeetingController`(meeting.ts ~905–917)只在 author id **同时**在 `triggerUserIds` **且**
`qaBotUserIds` 时接受 bot、接受列出的非 bot author、只拒它自己配置的 bot id。**问题**:A 里跑 Codex,
凡存在 A 的凭据都 agent 可用;若 A 能以任一 extra-trigger 或 QA-allowlist 的 **bot 身份**发消息,
agent 就能走**完全合法**的 Discord 路径驱动 I,W 会正确看到 uid I 并写 = confused-deputy。故:
- **§1 的「A 无 token」精确表述为「A 无 Calendar token」**;A 仍需 `RAYA_BOT_TOKEN` 等**非日历**凭据;
- **不变式**:**A 可读的任何发送类凭据,都不得能以 I-allowlist 的 principal 身份发消息**;
- 落地:**I 的 listener token 只放 I**;**I 自己的 bot id 保持自拒**;**QA actor 凭据放在 A 之外**
  或**生产禁用该 allowlist**;
- 探针(§7.5):用**每一把 A 可读的发送凭据**跑合法 exact-command → 断言 **I 无排会状态转移 + 日历
  零 mutation**。§5 给出完整 principal/credential authority 矩阵。

- **可执行体/plist/wrapper 一律 root 拥有、I/W uid 不可写**(不 chown code 树);仅各自
  `state/log/token` 目录归对应 uid。**voice 留原 gui uid**(不持 token、无 writer 权),其
  `createLaunchctlVoiceSupervisor(uid)` 的 `gui/${uid}` 合同**不动**(R1 Blocker2 / §1.2)。
- **需 Raya repo 改动**(§1.2 的 I/W 拆分 + 只读投影 + 单向 voice 信号;A 侧去掉直接写路径)——
  **明确交付,不列「implement 期发现」**。按 §8 伴生 PR。
- **egress(R2 High6,降级为纵深)**:writer 除 Calendar API 还需 OAuth token endpoint + DNS/证书;
  「仅 Calendar 网络」**不作为机器已强制的边界**,记为 defense-in-depth/未来项;A/B 达标**不**依赖
  未设计的网络沙箱。

## 2. 三个方案并陈(核心决策面)

三案共享 §3 的「非凭据」改动,**只在「writer 的写凭据放哪、是谁」上分叉**。§1 三角色拓扑对 A/B
**都适用**。

### 方案 A —— 角色用户 + 独立 bot 身份(推荐:真隔离 + 最小权限 + revoke 域独立)

- **写凭据**:独立 **bot Google 账号** token(**独立 Google 账号 = 独立 OAuth grant 域**),存
  uid W 的 gog `file` keyring(0600);bot 仅在**显式 founder calendar ID** + QA 日历有 writer ACL。
- **防住谁**:①founder uid 所有 agent(无写 scope + 读不到 W 的 0600 + 无密码 sudo);②W 不跑 agent、
  writer 只信 I、A 的 Codex 无调用权(R2 Blocker1);③W 被攻破,bot 也**只能碰被 ACL 授权的日历**;
  ④confused-deputy(0700 + PEERCRED + ingress 探针)。
- **防不住谁**:持交互 sudo 密码的本地攻击者;直接攻破 W uid 者(能力被 ACL 限死);§5 显式排除
  的浏览器 GUI/人类 Discord 会话。
- **revoke 域(R2 Blocker3)**:bot 是**不同 Google 账号**,其 grant 与 founder personal 的 grant
  **天然独立**——注销 founder 旧写 grant **不会**误杀 bot token。这是 A 相对 B 的关键运维优势。
- **founder 一次性操作**:①一次密码门 admin(建 uid I/W + 装两个 LaunchDaemon,脚本化);②账号
  生态:注册/授权 bot Google 账号(约 3 步:建号→本机 `gog auth add`→在 founder 日历「共享给 bot
  邮箱」授 writer ACL);③QA 独立身份授 ACL 到测试日历(约 2 步)。
- **达标**:✅ 完整达标(以 §1 三角色拓扑落地为前提),least-privilege 最优。

### 方案 B —— 角色用户 + founder 本人独立 token(降级:达标但权限/ revoke 域弱)

- **写凭据**:uid W 持 **founder 本人 personal 账号第二把 token**,calendar 整域 RW。**无需新账号**,
  但(R2 Blocker3)**必须用一个独立的 OAuth client(独立 client_secret / GCP project)**,否则它与
  founder uid 主 grant 同域,§6 Retire 注销旧写 grant 会**连带杀掉 W 的 token**。
- **防住谁**:与 A 相同的 ①无写 scope+读不到、②W 不跑 agent+caller 隔离、④confused-deputy。
- **弱在哪(决策包须标明)**:W 被攻破泄露 **founder 本人 calendar 整域 RW**;吊销这把 token 可能
  牵动 founder 该账号其他会话;不是「独立服务身份」;且需自建独立 OAuth client 才能隔开 revoke 域
  (比 A 多一步且更易出错)。
- **founder 一次性操作**:同 A 的密码门 admin;**省掉 bot 账号**,但需**建/指定独立 OAuth client**
  + `gog auth add personal --client <独立>`(浏览器授权一次)。QA 独立身份仍建议。
- **达标**:✅ 达标(前提:独立 OAuth client + §1 拓扑),least-privilege / revoke 域弱于 A。

### 方案 C —— 不动系统层的最强可达方案(**判定:不达标,作否决基线**)

- **约束**:不新建系统用户,Raya 仍以 `node cli.js` 在 founder uid 运行。
- **能做到**:scope 收窄(移除 agent 自己 token 的写 scope)+ 把 writer 钥匙换目录/换 client「藏」。
- **为什么不达标(research.md §3 实测)**:①凡 writer 作为 `node` 能读到的,agent 用同一 `node`
  也能读到;macOS keychain per-app ACL 绑**共享解释器 `node`**(实测 `cli.js` 未签名、node adhoc
  非 hardened);走通须**另造签名+hardened 原生 helper**(工作量 ≥ A,非「不动系统层」);②C 下
  writer 与 Codex 必然同 uid,R2 Blocker1 的 caller 问题**无解**;③confused-deputy 同 uid 可伪造。
- **防住谁**:仅「Claude 会话直接键入 CLI」这条窄路(与 FLY-2137 护栏同层)。
- **防不住谁**:写脚本再执行 / Codex·Gemini 直连 shell / 读凭据文件 / 直调 writer / 伪造输入。
- **达标**:❌ **不达标**,作否决基线。**若 founder 因不动系统层强约束只能选 C,则 issue 核心要求
  在本机不可达,应重新定范围**(接受「仅护栏+审计」/ writer 迁独立机器 / 造签名原生 helper 另立单)。

### 判定小结(A/B 达标以 §1 三角色拓扑 + 对应 OAuth 域为前提)

| | A 角色用户+bot | B 角色用户+founder token | C 不动系统层 |
|---|---|---|---|
| agent 无写 scope + **旧 grant 已 revoke** | ✅ | ✅(需独立 OAuth client) | ⚠️ 仅 scope,writer 钥匙仍暴露 |
| agent 读不到 writer 凭据 | ✅ uid 边界 | ✅ uid 边界 | ❌ 同 uid 可读 |
| W 不跑 agent + **writer caller 与 agent 分离** | ✅ 三角色 | ✅ 三角色 | ❌ 同 uid 必跑 Codex |
| confused-deputy 被堵 | ✅ 0700+PEERCRED+ingress 探针 | ✅ | ❌ |
| revoke 域独立 | ✅ 不同账号 | ⚠️ 需独立 OAuth client | — |
| 最小权限 | ✅ ACL 限死 | ⚠️ founder 整域 RW | — |
| founder 建角色用户(密码门) | 是 | 是 | 否 |
| founder 建 bot 账号 | 是 | 否(但需独立 OAuth client) | 否 |
| **达标** | ✅ | ✅ | ❌(否决基线) |

**推荐:A**;若 founder 不愿建 bot 账号则 **B**(接受独立 OAuth client + 权限弱);**C 仅作否决基线**。

## 3. 三案共享的改动(与 writer 凭据放哪无关的那部分)

### 3.1 逐消费者凭据矩阵 + 旧 grant 注销(codex R1 Blocker4 + R2 Blocker3)
`--readonly` 是**一次授权的全局 flag,不是 per-service**(本机实证)⇒ **同一个 grant 里无法「gmail
full + calendar readonly」**;要混权限**必须拆成不同 OAuth grant**(不同账号或不同 OAuth client)。
故按下表逐消费者接线,并**为每条记全 revoke 域**:

| 消费者 | 需要的 calendar 权限 | Google 账号 / OAuth client / grant 域 | 落地 |
|---|---|---|---|
| founder uid 日常 agent / 生活(**gog**) | **无 calendar**(读写都去掉) | founder personal / gogcli 主 client / 主 grant | 主 grant 重授 `--services`**不含 calendar** |
| founder uid **gws**(独立一行,codex R4)| **无 calendar 写**(若无读侧消费者则整个去掉 calendar) | founder personal / **gws 自己的 OAuth client(`~/.config/gws/client_secret.json`)/ GCP project `protean-depot-487503-j1`** / 独立 grant | **同 account+project ⇒ 旧写 grant 与现行减 scope grant 是同一 grant,不能分别 revoke(codex R5)**:按 §6 Retire「先 revoke 旧(证 invalid_grant)→ 再同 project 重授只含非写 scope」,或把现行放到**分开的 GCP project**;7.2 的「现行有效、无写」证据取自**重授后**的那把,与 7.3a 的**已 revoke 旧把**是**先后两态**,不是同刻并存两把;记其账号/client/project/revoke 域/scopes/凭据位置/reauth/retire 动作 |
| FLY-2137 sweep(只读扫显式 founder 日历) | **calendar.readonly** | founder personal / **独立 OAuth client(独立 client_secret/project)** / **独立 grant** | 新建独立 OAuth client 授 `calendar --readonly`;sweep 加 `--client <独立>` 接线(现状只传 `--account`) |
| writer(A) | calendar write on 显式 id | **bot 账号** / 独立 grant | uid W,§2-A |
| writer(B) | calendar 整域 RW | founder personal / **独立 OAuth client** / 独立 grant | uid W,§2-B |

**为什么 sweep 要独立 OAuth client 而非只换 `--client` 名**:同一(账号, OAuth client)只有**一个
grant、一套 scopes**;若 sweep 的 readonly 与主 token 同 client,二者共享 grant,§6 Retire 注销主
写 grant 会连带杀 sweep;且无法让主 token 无 calendar 而同 client 的 sweep token 有 readonly。
⇒ sweep 必须**独立 OAuth client**(独立 revoke 域)。`--client` 名本身**不是隔离证据**(R2 Blocker3)。

**旧 grant 注销(不止重授)**:server-side revoke 旧可写 grant(账号「第三方访问」/`oauth2 revoke`,
**注意生效有延迟**);做**非泄密 inventory**(所有 gog keyring 条目 / gws credentials.enc /
`auth tokens export` 产物 / 备份),逐一确认可写性并处置;**先算每次 revoke 的 blast radius**
(同 grant 域的其他 scope/服务会被连带撤销)。

### 3.2 显式 founder calendar ID(codex R1 Blocker3)
`primary` = **当前认证账号自己的** primary;bot 认证后 `primary` 指 bot 日历。故 provisioning 先
**pin `<founder-primary-calendar-id>`**(founder 邮箱作为 calendarId,或从 `calendarList` 取显式 id);
A 授 bot 对**该显式 id** 的 writer ACL;writer 的 `RAYA_MEETING_CALENDAR_ID` = 该显式 id;
**针对真实 founder 日历的 ACL/正路探针**用 `FOUNDER_CALENDAR_ID`,**scope 负探针**用
`CANARY_CALENDAR_ID`(§3.3,不复用同一 id);验收读回事件 `organizer`/`creator`/日历归属证明落在
founder 日历。

### 3.3 精确错误合同 + canary/founder ID 分离(codex R2 High4 + R3 High4)
**两个日历 id 概念严格分开,不复用同一个「显式 id」**:
- **`CANARY_CALENDAR_ID`** = 一个**一次性、可丢弃**的 founder-owned 日历,**专供 scope 负探针**
  (§7.1/7.2)。这样即便 scope 收窄回归、insert 意外成功,也只落在 canary 上(pre/post inventory +
  清理),**绝不**污染真日历——这正是 canary 规则要防的失败态;
- **`FOUNDER_CALENDAR_ID`** = 真实 founder 日历,**只用于**正路 I→W create/cancel + 读回(§7.7)
  与 ACL/writer 配置(§3.2)。

按控制面分别断言精确错误(不用「任意 403」):
- **scope 移除**(founder 主 grant 无 calendar):对 **CANARY** 用**真实写 grammar**
  (gog `calendar create "$CANARY" --summary --from --to`;gws `events insert --params
  '{"calendarId":"$CANARY"}' --json <body>`,先本地/`--dry-run` 过 grammar)→ **有效 token + 403
  insufficient scope**(codex R4 核实:gog `events` 是只读 list、写是 `create`;gws 无 `--calendar`
  flag);
- **旧 grant 已 revoke**:refresh 失败 **`invalid_grant`**,或缓存 access token 调 API 得 **401
  invalid_credentials**(允许 revocation 收敛延迟窗口,须复测至稳定);revoke endpoint 本身成功=**200**;
- **QA 无 ACL**:**owner 侧 ACL inventory** 证明 QA principal 不在 `FOUNDER_CALENDAR_ID` 的 ACL;
  QA 侧对该 id 得 **404 notFound / 明确 authz 拒绝**(Calendar 对无权访问的日历合法返回 404,不是 403);
- **所有写探针**先保证请求**通过本地 grammar**(否则可能在发 HTTP 前就失败,证明力为零)。

### 3.4 confused-deputy 隔离(A/B 由三角色拓扑获得;C 做不到)
文件面:W/I 的 state/inbox 0700 → founder uid agent 写不进;协议面:PEERCRED 只认 uid I(§1);
ingress 面:§5 列全 Discord 触发身份 + QA allowlist + 逐个负探针。

### 3.5 QA 独立身份 + 激活 P6 豁免
建独立 QA Google 身份,仅在 QA 测试日历有 writer ACL;founder 日历**不给** QA ACL。QA 测试日历 id
写 `~/.flywheel/qa-calendar-id`(0600,过 FLY-2137 校验 `^[A-Za-z0-9._-]+@group\.calendar\.google\.com$`,
拒 primary/邮箱)→ 激活 P6 豁免。本单**不改** FLY-2137 P6 代码,只补输入文件 + QA 身份。

### 3.6 回链 FLY-2137
在 FLY-2137 授权名单文档 / issue 挂链本单结果 + 选定机制。**本单关闭前必须完成回链**。

## 4. Provisioning 与 secret handling(codex R1 High6)
1. **root 拥有、service uid 不可写的固定 wrapper**(如 `/usr/local/libexec/raya-cal-writer-wrapper`,
   root:wheel 0755):**先切 uid(W),再在该进程内**从 daemon-only 0600 口令文件读
   `GOG_KEYRING_PASSWORD`,**显式设** `HOME=/Users/_flywheelcal`、`GOG_KEYRING_BACKEND=file`、gog
   config root,再 exec writer。**绝不**把口令展开到 founder shell / argv / plist EnvironmentVariables。
2. 两个 system LaunchDaemon(`/Library/LaunchDaemons/`,root 拥有)——uid W(writer)、uid I
   (meeting-ingress);`UserName` 各指其 uid;`ProgramArguments` 指对应 wrapper;env 只含无秘密路径。
   照 FLY-2137 `install-*.sh` 先例:`plutil -lint` + 渲染校验 + 稳定路径 + `bootout` 回滚;
   `launchctl print system/<label>` 验 ProgramArguments/uid。
3. 凭据 provisioning 在 wrapper 语义下跑,A=`gog auth add <bot>`,B=`gog auth add <founder-personal>
   --client <独立 OAuth client>`;A 再授 writer ACL 到 §3.2 显式 id。
4. **冷启动恢复探针**:重启后(无 login keychain 交互)writer 能 `auth`/`list`/create/cancel。

## 5. 威胁模型边界(codex R1 Blocker5 + R3 Blocker3,必须成文)
治理:**机器 OAuth/CLI 凭据 + Raya 自动 ingress**。
- **principal / credential authority 矩阵**(每个 `triggerUserIds` + QA 身份逐行):
  `Discord author id | bot/human | 能以此身份发消息的凭据/会话 | 该凭据 owner uid/存放处 |
  生产是否启用 | uid A 是否可用`。
- **核心不变式(R3 Blocker3)**:**uid A(跑 Codex)可读的任何发送类凭据,都不得能以 I-allowlist
  的 principal 身份发消息**——否则 agent 走合法 Discord 路径自驱 I,W 正确看到 uid I 并写。落地:
  - **I 的 listener bot token 只放 uid I**(0700),不进 A;
  - **I 自己的 bot id 保持自拒**(现有逻辑);
  - **QA actor 凭据放在 A 之外**,或**生产禁用 QA allowlist**;
  - founder 本人排会走**她自己的人类 Discord**(不在本机凭据里)—— 正测她仍能排会。
- **探针(§7.5)**:用**每一把 A 可读的发送凭据**跑合法 exact-command → 断言 **I 无排会状态转移 +
  日历零 mutation**;对每个 ingress 从 founder uid 尝试驱动排会 → 被拒。
- **显式排除项(决策包须让 founder 知情拍板)**:已登录**浏览器 GUI 会话**(如 agent 用
  claude-in-chrome 打开 calendar.google.com 直接建事件)与 **founder 本人 Discord 人类会话**——
  属浏览器/人类会话面,**不在本单 OAuth/CLI 凭据对抗范围内**。**修正** exploration 里「founder
  Google UI 从不经本机凭据」的不准确表述:浏览器 session 本身是本机可用的授权能力,本单不声称防住它。
  ⇒「唯一自动写入方」达标声明**限定在**「机器 OAuth/CLI + Raya 自动 ingress」这一面。

## 6. 部署/回滚状态机(codex R2 Blocker2)—— Provision→Cutover→Retire→Final gate
```
Provision(旧 writer 仍是 rollback path;此阶段系统处于可回滚 provisional 态)
  建 uid I/W + wrapper + 两 LaunchDaemon;备写凭据(A bot / B 独立 client);pin 显式 founder id;
  建 sweep 独立 OAuth client 的 readonly 凭据;
  验证:冷启动恢复(§4.4)+ 正路 create/cancel 落显式 founder id + 凭据读拒(两侧)+
        caller-auth 拒(Codex 直调 writer 被拒,§7.3b)。 [此时 founder 旧写路径未动]
Cutover
  把 Raya 排会路由切到 uid I→W 新 writer;验证单实例(旧路径已停)+ 正路。
Retire —— **per-revoke-domain 状态机(codex R5 Blocker)**。关键事实:同一(Google 账号, GCP
  project)只有**一个 grant**;server-side revoke 移除**整个 project** 的授权、使该 project 下**所有
  client** 的 token 失效,**不是**逐 token 边界。故「先重授现行减 scope grant、再 revoke 旧」在同域
  下自相矛盾(revoke 会连新 token 一起杀 → 7.1/7.2 拿不到「有效 token+403」而是 revoked 行为)。
  对**每一对(gog / gws)predecessor↔current** 二选一:
  - **同 project/域(默认)**:I→W 仍是生产写路径期间,**先 revoke 旧 project grant → 等收敛 → 用
    保存的旧 refresh token 证 `invalid_grant`(不记 token 字节)→ 再在同 project 下发一把只含非写
    scope 的新授权 →** 最后跑 7.1/7.2 要「有效 token+403 insufficient」。**如实记录**中间存在一小段
    本机 CLI 无任何日历 grant 的窗口(founder 本人 UI 不受影响);
  - **分 project/域**:把减 scope 的 current grant 放到**真正不同的 GCP project**,矩阵记全新旧
    project/client id,revoke 旧 project 后证新 grant 仍有效。
  **不得**在矩阵行解析到同一(账号, project)时把「旧 token」「现 token」描述成可分别 revoke。
Final commit gate = §7.1–7.9 全通过,**按序同时断言两侧**:旧 grant 指纹 **invalid**(7.3a
  invalid_grant/401)+ current grant 指纹 **valid 但写不足**(7.1/7.2 有效 token+403 insufficient)
  + sweep 独立 readonly client 成功;失败 → 按下面有序 rollback。
```
**有序回滚(非独立,codex R2 Blocker2 / R1 High7 / R3 High5)**——**W/I 保持运行时先备好并验证
回滚写路径,最后才停 W/I**,避免「停了能写的、却发现旧凭据重授失败」的无 writer 停摆:
1. **W/I 仍在跑**期间:重新授权回滚写凭据(Retire 已 server-side revoke,恢复它**需要一次新授权、
   可能失败**)→ 用 **CANARY** 验证它可写 → 恢复旧 state/config 属主 → 备好 founder gui LaunchAgent
   (**先不启用并发生产写**);
2. drain/停 uid I→W 路径;
3. 起旧路径并验证它是**唯一** writer(单实例);
4. **之后才**删 bot ACL / 清 W/I uid 侧。
   记录:此回滚**有意退回 FLY-2204 前的安全姿态**,本 issue 处于 unshipped。

## 7. 验收证据(负向越权探针 + 正路回归)—— 断言精确 reason,不触达真 primary 内容
**通用纪律**(§3.3):scope 负探针打 **`CANARY_CALENDAR_ID`**(可丢弃 founder-owned),正路才打
**`FOUNDER_CALENDAR_ID`**;先过本地 grammar,断言**精确错误**;durable 证据**绝不记录 token 字节**;
正路用 founder 授权测试会议并**立即 cancel**。
- 7.1 founder uid 主 grant(**gog v0.10.0 真实写 grammar,codex R4 核实**:写是 `calendar create`,
  `events` 是只读 list)`gog --account <主> calendar create "$CANARY_CALENDAR_ID" --summary <t>
  --from <RFC3339> --to <RFC3339>` → **有效 token + 403 insufficient scope**(先本地 grammar 校验,
  再 live;pre/post inventory + 清理 canary);
- 7.2 founder uid gws(**真实 grammar**:无 `--calendar` flag,calendarId 进 `--params` JSON)
  `gws calendar events insert --params '{"calendarId":"'"$CANARY_CALENDAR_ID"'"}' --json '<合法 event body>'`
  → 先 `--dry-run` 本地 grammar 校验,再 live → **有效 token + 403 insufficient scope**;
- 7.3a founder uid **旧/备用 grant**(§3.1 inventory 逐个)→ refresh **`invalid_grant`** 或缓存
  access **401**(允许 revocation 收敛窗口,复测至稳定);
- 7.3b **caller-auth 探针,两层(R2 Blocker1 + R3 Blocker1 修正)**:①从**真实 Raya Codex tool
  context(uid A,不在 `_rayacal` 组)**发合法 writer 请求 → **transport-layer 拒绝**(fs 组权限,
  connect 失败)+ 显式 founder 日历零 mutation —— 诚实标注:这里内核 pathname 检查是实际边界;
  ②**独立 writer 单元/集成测试**:直接喂 writer 一个**非 I peer**,断言它在**任何 Calendar adapter
  调用之前**按 PEERCRED(euid≠I)拒绝;
- 7.4 **凭据读探针,两侧**:①founder uid agent `test -r <W token 文件>` + `sudo -n -u <W> gog …`
  → 不可读 / Permission denied;②Raya Codex 子进程读 W token → 失败;**均不记录 token 字节**;
- 7.5 **输入伪造探针**:founder uid 写 `<W>/<I> state|inbox/*` → 写不进;**用每一把 uid A 可读的
  发送凭据**(§5 矩阵)跑合法 exact-command → **I 无排会状态转移 + 日历零 mutation**;并正测 founder
  真实人类 Discord 身份仍能排会;
- 7.6 **QA**:owner 侧 ACL inventory 证明 QA 不在显式 founder id 的 ACL;QA 账号写显式 founder id →
  **404 notFound / 明确 authz 拒绝**;QA 账号写 QA 测试日历 → 成功(真建后清理),读回 organizer;
- 7.7 **FLY-2130 正路回归**:uid I 触发排会 → uid W 在**显式 founder id** 建事件(带 `raya_meeting_id`),
  **读回 organizer/owner 证明落 founder 日历**;走取消验证清理。**实测证实**,不接受结构免测(FLY-2182);
- 7.8 **冷启动**:重启后 W 免交互恢复并能 create/cancel;
- 7.9 sweep 用**独立 OAuth client 的 readonly 凭据**只读扫描成功(§3.1)。
- C 若被选:7.3b/7.4/7.5 无法通过 = 直接证明 C 不达标。

## 8. Ship 段:PR 登记铁律(FLY-2031/FLY-2203 教训)
flywheel 主仓改动:setup/wrapper 脚本 + 两 plist 模板 + qa-calendar-id 落地 + sweep 独立 `--client`
接线 + 回链文档。§1 三角色拆分**需改 Raya repo**(伴生 PR)。三条逐字适用:①先在 flywheel 主仓开
docs/进度锚 PR(分支=本单 flywheel 分支);②`complete --pr` **必用 flywheel 锚 PR 号,绝不登记外部
仓 PR 号**;③Raya PR 在锚 PR body 列伴生,merge 需 founder 单独授权。

## 9. 明确不做
- 不做跨机器凭据托管 / 远程 broker(过重;记未来选项)。
- 不造签名原生 helper(C 的重路径,§2-C)。
- 不做 per-uid 网络 egress 沙箱(§1 已降级为纵深,非达标依赖)。
- 不动 FLY-2137 已上线 P6 护栏 / sweep 逻辑(只补 qa-calendar-id 输入 + 给 sweep 加 `--client` 参数)。
- 不改 founder 本人 Google UI 路径;不声称防住浏览器 GUI/人类 Discord 会话(§5 显式排除)。
- 不对抗持交互 sudo 密码的本地攻击者。
- **本设计节点不执行 provisioning / 不迁移 / 不重授 / 不 revoke / 不 restart**——待 founder 拍板后 implement。

## 10. 风险
| 风险 | 处置 |
|---|---|
| 整个 Raya 搬到持 token uid → 内部 Codex 读走 token | §1 三角色:W 不跑 agent;两侧读探针 7.4 |
| writer caller 与 agent 同 uid → Codex 直调 writer | §1 writer 只信 uid I;7.3b 从真实 Codex context 验拒绝 |
| voice gui-domain supervisor 与 system daemon 冲突 | voice 留原 gui uid(不持 token),supervisor 不动;仅 W/I 是 system daemon |
| `primary` 指认证账号自己的日历 | pin 显式 founder id,ACL/探针/adapter/验收全用它(§3.2) |
| 只重授不注销旧 grant | server-side revoke + inventory + 旧 grant 负探针 7.3a(§3.1) |
| `--client` 名 ≠ revoke 域 → 注销连带杀新 token/sweep | sweep 用独立 OAuth client;B 的 writer 也用独立 client;先算 blast radius(§3.1) |
| 精确错误写错(403 vs 401/invalid_grant/404) | §3.3 按控制面分别断言;7.x 对应 |
| scope 去 calendar 打断 sweep | sweep 独立 OAuth client 的 readonly(§3.1) |
| 部署提交点时序不可达 | §6 Provision→Cutover→Retire→Final gate,commit point 移到 Retire 后 |
| daemon file keyring 口令泄回 founder uid | wrapper 切 uid 后读 0600 口令;绝不进 shell/argv/plist(§4) |
| 非登录角色用户无 login keychain 致启动恢复挂 | gog `file` backend + 冷启动探针 7.8 |
| ingress(Discord/QA allowlist)绕过 state 隔离 | §5 列全 ingress + 逐个负探针 7.5;收敛 send 凭据 |
| 回滚误序致断写 | §6 有序回滚:先恢复 founder 写路径 / 先切回旧路径再删 ACL |
| 浏览器 GUI/人类会话面被误判为已覆盖 | §5 显式排除并成文,达标声明限定范围 |
| FLY-2130 正路回归漏测 | 7.7 daemon 真机 create/cancel + 读回 organizer,不接受结构免测 |
| W-only 0700 socket 先于 PEERCRED 拒掉 uid I | §1.1 专用 `_rayacal` 组 + 组可遍历/可连;PEERCRED 作纵深;7.3b 诚实标注 transport 边界 + 独立 PEERCRED 测试 |
| I 拥有 meeting state 后 voice(A)读不到上下文 | §1.2 I→A 只读投影 + 单向 voice start/stop 信号(不能写日历);voice 留 gui 域 |
| A 可读凭据映射到 I-allowlist principal → 自驱 | §5 principal/credential 矩阵 + 不变式;I listener token 只在 I;QA 凭据出 A / 生产禁 allowlist;7.5 逐凭据探针 |
| 负探针误打真 founder 日历 | §3.3/§7 CANARY_CALENDAR_ID(scope 探针)与 FOUNDER_CALENDAR_ID(正路)严格分离 |

## 11. Design review 处理记录
**最终:R6 codex(xhigh→high)= APPROVED**(6 轮)。「No blocking design, feasibility, sequencing,
evidence, or threat-model issue remains within the stated scope. Implementation may proceed after the
founder selects Option A or B and authorizes the required system-layer changes.」

| 轮 | verdict | 处理 |
|---|---|---|
| R6(codex, high) | **APPROVED** | 两条 R5 finding 关闭;拓扑/凭据注销/回滚/负向证据合同内部自洽。实现须守证据纪律:只记非泄密指纹与 project/client 元数据、绝不记 token 字节;覆盖/删除旧凭据前先完成旧 token 收敛校验;approval 绑定到 final gate 全部 §7 探针通过。 |
| R1(codex, xhigh) | CHANGES REQUESTED(5 Blocker + 2 High) | 全部接受:最小 writer 拓扑、voice 留 gui domain、显式 founder id、逐消费者矩阵 + 旧 token 注销、威胁模型成文、wrapper secret handling、部署/回滚状态机。 |
| R2(codex, high) | CHANGES REQUESTED(3 Blocker + 3 High) | 全部接受:①**三角色 uid 拓扑**——把 writer 的**调用权**也与 agent 分开(uid W writer / uid I 无 agent meeting-ingress = writer 唯一 allowlist / uid A 跑 Codex 无 token 无 writer 权);7.3b 从真实 Codex context 验直调 writer 被拒(§1);②部署状态机重排 **Provision→Cutover→Retire→Final gate**,commit point 移到 Retire 之后,消除「S1 却要求 scope 已收窄」的时序不可达(§6);③**`--client` ≠ OAuth revoke 域**:sweep 与 B 的 writer 必须用**独立 OAuth client**(独立 revoke 域),否则注销旧 grant 连带杀新 token;矩阵加 client_id/project/账号/revoke 域列并先算 blast radius(§3.1);④**精确错误合同**:scope=403 insufficient / revoke=invalid_grant 或 401 / QA 无 ACL=404 notFound;写探针先过 grammar、用 canary、不拿合法 insert 打真 primary(§3.3/§7);⑤同步修正 exploration 的目标态/迁移/回滚/UI 表述,统一命名 minimal calendar-writer,消除两套互斥架构(见 exploration 修订);⑥egress「仅 Calendar 网络」降为 defense-in-depth,不作达标依赖(§1)。 |
| R5(codex, high) | CHANGES REQUESTED(1 Blocker + 1 Low)——codex 明示「改完即 ready for approval」 | 全部接受:①**Retire 顺序修正**(§6/§3.1 gws 行)——同(账号, GCP project)只有**一个 grant**,revoke 移除整个 project 授权、使该 project 下所有 client token 失效(非逐 token 边界);故「先重授减 scope、再 revoke 旧」在同域自相矛盾(连新 token 一起杀,7.1/7.2 拿不到有效 token+403)。改为 per-revoke-domain 状态机:同 project = **先 revoke 旧(证 invalid_grant)→ 等收敛 → 同 project 重授只含非写 scope**(如实记中间 CLI 无日历 grant 的窗口),或把现行减 scope grant 放**分开的 GCP project**;final gate 按序同时断言「旧指纹 invalid + 现指纹 valid 但写不足」;②(Low)§3.2 去掉「所有正/负探针指向显式 id」的残句,改为 ACL/正路→FOUNDER_CALENDAR_ID、scope 负探针→CANARY_CALENDAR_ID。 |
| R4(codex, high) | CHANGES REQUESTED(1 Blocker + 1 Medium)——codex 明示「改完即可 APPROVE」 | 全部接受:①**探针用真实 CLI 写 grammar**(§3.3/§7,本机核实)——gog v0.10.0 写是 `calendar create <id> --summary --from --to`(`events` 是只读 list,原 `events insert` 探到的是读路径、证明力为零);gws 写是 `events insert --params '{"calendarId":…}' --json <body>`(无 `--calendar` flag,原写法 CLI 解析即失败);均先本地/`--dry-run` 过 grammar 再 live;research §7 同步改;②**gws 单列一行**入 §3.1 矩阵(自己的 client_secret/GCP project/revoke 域/scopes/位置/reauth/retire),且 7.2 需一把**现行有效、无写**的 gws grant 才能把 403 insufficient 与 7.3a 的旧 grant 区分;③术语精确「A/I 无 **Calendar** 凭据」(I 持 Discord listener token、A 持非日历凭据);④§1.2 A→I 反馈收窄为「不能 schedule/reschedule/cancel/调 W/改投影输入,只允许枚举 readiness 字段转移且测证到不了 writer」(避免不可能的字面绝对)。 |
| R3(codex, high) | CHANGES REQUESTED(3 Blocker + 2 High + 1 Medium) | 全部接受:①**传输合同自洽**(§1.1)——W-only 0700 socket 会先于 PEERCRED 拒掉合法 uid I;改用专用 `_rayacal` 组(成员 I/W)+ 组可遍历父目录 + 组可连 socket,PEERCRED 作纵深;7.3b 诚实标注 uid A 得到的是 **transport-layer 拒绝**(内核 pathname 检查是实际边界)+ 独立 writer 测试证 PEERCRED 在任何 adapter 调用前拒非 I peer;②**I↔A voice/状态边界合同**(§1.2)——源码证实 meeting runtime 拥有 canonical state + 直接 start/stop voice + voice 靠同 stateDir 读上下文;给出 I 拥有 state、**I→A 只读投影** + **单向 voice start/stop 信号(不能写日历)** + 两向认证 + 跨边界测试的 normative 合同,voice 留 gui 域;③**凭据-principal 不变式**(§5)——A 跑 Codex 故 A 可读的任何发送凭据 agent 可用;加 principal/credential authority 矩阵 + 不变式「A 可读凭据不得以 I-allowlist 身份发消息」,I listener token 只在 I、QA 凭据出 A 或生产禁 allowlist,7.5 逐凭据探针;「A 无 token」精确为「A 无 Calendar token」;④**canary/founder id 分离**(§3.3/§7)——scope 负探针打一次性 `CANARY_CALENDAR_ID`,正路才打 `FOUNDER_CALENDAR_ID`,不复用同一 id;⑤**回滚重排**(§6)——W/I 保持运行时先重授并用 canary 验证回滚写路径、再 drain/停 W/I、最后删 ACL,避免无 writer 停摆;⑥exploration §5.4 补「B 需独立 OAuth client_secret + 独立 GCP project/revoke 域」。 |
