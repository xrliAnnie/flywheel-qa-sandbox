# FLY-2204 隔离 founder 日历写凭据 — 探索
Issue: FLY-2204 (https://linear.app/geoforge3d/issue/FLY-2204/治理-隔离-founder-google-calendar-写凭据agent-上下文不可读)
日期: 2026-08-31
基于: 无(上游 FLY-2137 plan.md/research.md 为参照)

## 0. 一句话

把 founder Google Calendar 的**写能力**从「机器上任何同用户进程都能拿到的全局凭据」收敛成
「只有 Raya daemon 的独立服务身份持有、且该凭据文件对 agent 上下文不可读」——从而给 FLY-2137
的行为护栏补上它自己承认缺失的那半:**真正的授权边界(凭据隔离),而不是会话 hook 上的护栏**。

## 1. 问题的准确形状(FLY-2137 留给本单的洞)

FLY-2137 plan §4.4「诚实边界」已经点名:P6 是 **Claude Code 直接 CLI 行为护栏**,不覆盖
①agent 把命令写进脚本再执行、②Codex/Gemini 直连 shell、③直接读机器凭据调 Google API。
三条绕过的共同根因是同一个:

> **founder 日历的写凭据在这台机器上是「同用户全局可读」的。**

审计实测(见 §2)确认:任何拿到 founder uid(`xiaorongli`)shell 的 agent,今天就能:
- 直接 `gog --account personal calendar events insert ...`(不经 Claude Bash hook,例如写进
  `.sh` 再跑、或 Codex/Gemini 会话直接执行);
- 或读出 Keychain 里 `svce=gogcli` 的 refresh token / 读 `~/.config/gws/credentials.enc`
  连同紧挨着它的 `.encryption_key`,自行解密后直连 Calendar API。

护栏拦的是「Claude 会话内、直接键入 CLI」这一条最窄的路;上面三条它结构上就够不着。
**本单要关的就是这三条共同的根:把写凭据本身隔离掉。**

## 2. 机器面审计(本单的事实地基)

| 面 | 现状 | 对边界的含义 |
|---|---|---|
| `gog` v0.10.0 (`/usr/local/bin/gog`) | `keyring_backend=keychain`;token 存 `login.keychain-db`(`svce=gogcli`),无 per-item ACL 限制 | login keychain 在登录期是**解锁**的,同 uid 任何进程 `security find-generic-password` 直接读出 → **非边界** |
| gog 能力 | 支持 `file` keyring backend、`--client`(独立 credentials+token bucket)、`--readonly`(降只读 scope) | 提供「按身份/按 scope 分桶」的原料,但分桶仍在**同 uid**下 → 单靠分桶不构成边界 |
| personal 账号 scope | `calendar` = `https://www.googleapis.com/auth/calendar`(**整域读写**,Google 无 per-calendar scope) | 一个 full-scope 的 personal token 同时给了 gmail/drive **和** calendar 写;要「只去掉日历写」必须**重新授权时按 service 拆 scope**(见 §4 杠杆 A) |
| `gws` (`~/.config/gws/`) | `credentials.enc` 与 `.encryption_key` **同目录、同 0600、同 uid**;calendar scope 同为整域 RW;当前 `token_valid=false` 但持 refresh_token | 「加密」对**跨机器/静态窃取**有意义,对**同 uid agent** 没有(密钥就在旁边)→ 非边界;且 gws 是 founder uid 上通往同一 personal 日历写的**第二条 CLI 路径**,治理必须覆盖它 |
| Raya daemon | `com.xrli.raya.brain.plist` + `com.xrli.raya.voice.plist` = **每用户 LaunchAgent**,均跑在 founder uid;brain `execFile(gog) --account=personal` 写 `primary`;两 daemon 共享 `~/.flywheel/raya/raya.env`(内含 Discord bot token + OpenAI key,同样 founder uid 可读) | Raya 今天用的就是**那把全局 keychain 凭据**——它并没有「自己的」写身份;要让它成为唯一写入方,得先给它一把 agent 拿不到的独立钥匙 |
| founder primary ACL | `owner=xrliannie@gmail.com` + `default`(public reader);**无任何第三方 writer** | 可用 ACL 作授权基:给 Raya 一个**独立 bot 身份**并授 writer ACL,就能让「谁能写 primary」= ACL 成员表(§4 杠杆 C) |
| `~/.flywheel/qa-calendar-id` | **缺失** | FLY-2137 的 P6「QA 测试日历豁免」当前 **inert**(没有 QA 日历 id,豁免分支永不成立);本单要落地 QA 独立日历,顺带激活它 |
| `sudo -n` | 被拒 = **密码门,非免密** | 结论关键:**另一个 uid 的 0600 文件,对没有 sudo 密码的 agent 不可读** → POSIX uid 分离在这台机器上是**真边界**,不是障眼法 |
| 主仓写消费者 | flywheel 主仓仅 `scripts/calendar-write-sweep.mjs`(**只读**)+ FLY-2137 sweep 链;**Raya repo 是唯一日历写消费者** | 迁移的 blast radius 收得住:只有 Raya 一处需要改「用哪把钥匙」 |

## 3. 本单必须诚实承认的硬约束(设计的地心引力)

> **在这台单用户 Mac 上,「同 uid」根本不是一条边界。**

同一个 POSIX uid 的两个进程,可以互读对方的 0600 文件、可以读对方在**已解锁的 login
keychain** 里的条目。任何「把凭据换个目录 / 换个 `--client` 名 / 用 file backend 加密 /
gws 那种密钥挨着密文」的做法,对**同 uid 的 agent** 都只是**混淆(obscurity),不是隔离**
——这恰恰就是 FLY-2137 在护栏那一层踩过的同一课,只不过下沉了一层。

因此本单**能用的真边界只有两类**,其余都是自欺:

- **A. OAuth scope 边界**:founder uid 上那把「到处都在用」的 personal token,重新授权成
  **不含日历写 scope**(日历只留 `calendar.readonly` 或干脆不含)。这样即便 agent 把 token
  整个偷走,它**在 Google 那侧也换不出一次日历写**。这条**不依赖任何文件权限**,是最省机械、
  最抗绕过的一条。
- **B. POSIX uid 边界**:能写日历的那把凭据,放在一个**专用 daemon uid** 的家目录/keyring 里
  (0700/0600)。founder uid 的 agent(无 sudo 密码)**读不到**它。**演进后**(plan.md §1):以该
  uid 运行的**不是整个 Raya,而是一个最小 calendar-writer**——因为整个 Raya 会 spawn Codex,与
  token 同 uid 就前功尽弃;且 writer 的**调用权**也要与 agent 分开(见 plan.md 三角色拓扑)。

**两条必须同时上,缺一不可**,理由是它们各挡一半、互补:
- 只上 A:agent 没有写 scope 了,但 **Raya 仍需一把能写的钥匙**;若这把钥匙留在 founder uid,
  agent 偷的是 **Raya 的钥匙**(它有写 scope),A 白做。⇒ 必须把 Raya 的写钥匙挪到别的 uid = B。
- 只上 B:Raya 的写钥匙 agent 读不到了,但 founder uid 上**原来那把 full-scope personal
  token 还在**(gmail/drive 等日常要用),agent 用它照样写日历。⇒ 必须把 founder uid 的日历写
  scope 摘掉 = A。

可选的第三条杠杆让 B 里那把钥匙本身**最小权限**:

- **C. 独立服务身份(bot identity)**:Raya 不复用「founder 本人的 calendar RW token」,而是
  用一个**独立 Google 身份**(专用 bot 账号),被授予 founder primary 的 **writer ACL**。
  于是 Raya 的钥匙即便泄露,它能碰的也只有「被 ACL 授权的那几个日历」,碰不到 founder 的
  gmail/drive/其他日历;吊销 = 从 ACL 删一行,不牵动 founder 本人任何会话。这正是 issue 说的
  「凭据/令牌**按服务身份**隔离」。C 是对 B 的加强,不替代 B(bot 的 token 仍要 uid 隔离)。

## 4. 三条杠杆合起来的目标态

> ⚠️ **权威架构以 plan.md 为准。** 本节经 codex R1/R2 评审已演进为**三角色 uid 拓扑**:持 token 的
> uid **不再运行整个 Raya**(否则它 spawn 的 Codex 与 token 同 uid,直接读走凭据);拆成
> ①最小 **calendar-writer**(持 token,不跑 agent)、②无 agent 的 **meeting-ingress**(writer 唯一
> allowlist 的调用方)、③跑 Codex/voice 的 **agent 域**(无 token、无 writer 调用权)。下框为演进后目标态:

```
uid A —— agent 域(可留 founder gui uid):Raya brain/voice + Codex
  无 token、无 writer 调用权
  founder uid 主 gog/gws grant: 去掉 calendar 写(见 §杠杆 A);sweep 用独立 OAuth client 的 readonly
  ⇒ 此 uid 不存在任何「能写 founder 日历」的凭据可偷

uid I —— meeting-ingress(LaunchDaemon,无 agent):exact-command 解析 + MeetingController
  独立按 founder Discord 身份门控;无 token;是 writer 唯一 allowlist 的调用方(PEERCRED)

uid W —— calendar-writer(LaunchDaemon):持唯一写凭据(gog file keyring 0600,跨 uid 不可读)  ← 杠杆 B
  A 方案: 该凭据是独立 bot 身份, 仅在【显式 founder calendar id】+ QA 日历有 writer ACL       ← 杠杆 C
  B 方案: founder 本人独立 token(须独立 OAuth client 隔开 revoke 域)
  不跑 agent;private-prop lookup-before-write 幂等

QA(founder uid, 独立 QA Google 身份):仅在 QA 测试日历有 writer ACL,对显式 founder id 无 ACL
  ⇒ 写测试日历成功;写 founder id 被 Google 拒(404 notFound / authz 拒绝,不是 403)

founder 本人 UI(Google web/app):founder 自己用不受影响
  (⚠️ 已登录浏览器会话本身是本机可用的授权能力,agent 可驱动它;本单 OAuth/CLI 凭据治理**不声称**
   防住浏览器 GUI/人类会话面,达标声明限定在该范围内——见 plan.md §5)
```

达成后:**agent 上下文里既没有日历写 scope、也读不到 writer 凭据、也无权直调 writer**;
唯一的自动写入方 = 最小 calendar-writer,由**机器**(OAuth grant scope + uid 权限 + writer caller
allowlist + ACL 成员表)强制,而不再只是 FLY-2137 的会话护栏在「劝阻」。回链 FLY-2137 后,它的
「唯一自动写入方」才算获得机器强制。

## 5. 关键设计选择 & 被否 / 待定方案

### 5.1 B 的落地形态:daemon uid 用哪种 keyring?
- **选:gog `file` backend**(daemon 家目录内加密文件,0600)。
  理由:**非登录的 daemon 用户没有会自动解锁的 login keychain**——若给 daemon 用 keychain
  backend,重启后无人解锁 → 启动恢复(issue 硬要求)会挂。file backend 的密文放在 daemon uid
  0600 下,**边界是 uid 文件权限,不是那层加密**,与启动恢复兼容。
- 否:给 daemon 建并解锁独立 login keychain——解锁需交互或把 keychain 密码再存一处(又是同 uid
  可读问题下移),复杂且脆。

### 5.2 隔离机制的备选:macOS Keychain 可信应用 ACL(否,记录理由)
把写 token 的 keychain 条目 ACL 绑定到**代码签名过的 Raya 二进制**,别的 app 读要弹窗
(无人值守 daemon = 等于拒绝)。听起来 macOS 原生、免第二个 uid。**否**,因为:
真正读 keychain 的是 **`gog`**,而 `gog` 是 agent 也在调的**同一个二进制**——ACL 绑到「gog」
无法区分「Raya 的 gog」和「agent 的 gog」。要走通得让 Raya **丢掉 gog、自己签名并内嵌 OAuth
直连 API**(把 keychain 条目 ACL 绑到 Raya 自签二进制)——那是对 FLY-2130 calendar adapter
的一次重写 + 维护稳定签名身份的负担。作为**更 macOS 原生但更重**的替代记录在案,不作 v1 首选。

### 5.3 C 的落地形态:bot 用「独立 Google 账号」还是「GCP service account」?
- **倾向:独立消费者 Google 账号**(如 `raya-bot@...`),被 founder 手动授 primary writer ACL。
  对 consumer(gmail.com)日历最直接,无需 Workspace 域/域内委派。
- 否(至少 v1):GCP service account + domain-wide delegation——founder 是消费者账号,非
  Workspace,DWD 路径不适用/过重。
- **待 Lead/founder 定**:是否愿意为此**新建一个 bot Google 账号**。若不愿,退化到 §5.4。

### 5.4 若不建 bot 身份的退化路径(B 不含 C)
daemon uid(W)持有的是**founder 本人 personal 账号**的一把**独立 token**,scope 含 calendar 写。
仍满足「agent 读不到写凭据 + agent uid 无写 scope」,但**least-privilege 弱**:这把钥匙是 founder
本人 RW token,泄露后果更大,且吊销会牵动 founder 该账号的会话。
**⚠️ 关键(codex R2/R3):必须用独立的 OAuth `client_secret` + 独立 GCP project/revoke 域**——
仅本地 `--client`/store 分离**不是隔离证据**,且若与 founder 主 grant 同 project,Retire 注销旧写
grant 会**连带杀掉 W 的 token**(见 plan.md §3.1)。C(bot)是更干净的目标,退化路径是可接受的 v1。

### 5.5 QA 写入路径
- **选:独立 QA Google 身份 + 仅测试日历 writer ACL**。QA 写靠 **ACL 授权**约束到测试日历,
  结构上碰不到 founder primary(primary 不给 QA 账号 ACL)。QA 日历 id 落 `~/.flywheel/qa-calendar-id`
  → 同时**激活 FLY-2137 当前 inert 的 P6 QA 豁免**。
- 否:让 QA 复用 founder 写凭据只靠「命令里指向测试日历」——那把写 primary 的能力还在 QA 手里,
  一个参数写错就打到 primary,正是 FLY-2137 P6 想防的。ACL 边界比参数纪律硬。

### 5.6 迁移顺序(先立后破;权威版见 plan.md §6 状态机)
演进后为 **Provision→Cutover→Retire→Final gate**(codex R2 修正,回滚**非独立、须按序**):
1. Provision:备 uid I/W + 写凭据(A bot / B 独立 OAuth client)+ 显式 founder id + sweep 独立
   readonly client;验证冷启动 + 正路 + 凭据读拒(两侧)+ caller-auth 拒(Codex 直调 writer 被拒);
   **此阶段旧写路径未动 = 可回滚**;
2. Cutover:Raya 排会路由切到 uid I→W;验单实例 + 正路;
3. Retire:founder uid 主 grant 去 calendar + **server-side revoke 旧可写 grant**(先算 blast radius);
4. Final gate:全部负/正探针通过(含旧 grant 精确失效 + sweep readonly 成功);
5. 回链 FLY-2137。
   **有序回滚**:回滚 Retire 前先恢复 founder 写路径;先切回旧 writer 再删 bot ACL(否则断写)。

## 6. 明确不做(边界诚实)
- 不做**跨机器**凭据托管 / 远程 broker(把 secret 挪到云上仍需本地一把 uid 隔离的钥匙,循环;
  且远超本单)。
- 不重写 Raya calendar adapter 去掉 gog(§5.2 的重路径)。
- 不动 FLY-2137 已上线的 P6 护栏 / sweep / kind——本单是它下面的**凭据层**,与之互补;
  完成后回链使其「唯一自动写入方」获机器强制。
- 不改 founder 本人 Google UI 使用路径(founder 自己用不受影响;但**不声称**防住 agent 驱动的
  已登录浏览器 GUI/人类 Discord 会话——见 plan.md §5,达标声明限定在机器 OAuth/CLI + Raya 自动 ingress)。
- 不宣称**对抗有 sudo 密码的本地攻击者**的边界——本单边界前提是「agent 无交互 sudo 密码」
  (§2 实测 `sudo -n` 密码门)。若该前提变化,需另立。

## 7. 待 Lead 决策(非阻塞,已并行推进 research)
1. **是否新建独立 bot Google 账号**(杠杆 C)?否则走 §5.4 退化路径(仍达标,least-privilege 弱)。
2. **是否接受在 founder 机器上创建专用 daemon 角色用户 + 改 LaunchDaemon**(杠杆 B 的一次性
   provisioning,需一次密码门 admin 操作)?这是达成「agent 读不到写凭据」的**唯一真边界**;
   若拒绝,本单结构上无法交付 issue 的核心要求,需回到 founder 重新定范围。
