# FLY-2204 隔离 founder 日历写凭据 — 调研
Issue: FLY-2204 (blocks FLY-2137)
日期: 2026-08-31
基于: exploration.md

本调研只做一件事:把三个候选方案(A/B/C)各自**依赖的技术机械逐条实测钉死**,让 plan 里的
「达标/不达标」有可复核证据,而不是断言。所有命令均在本机 founder uid(501)实跑。

## 1. gog / gws 的凭据与 scope 机械(实测)

| 事实 | 证据(本机实跑) | 对方案的含义 |
|---|---|---|
| gog keyring 后端可切 `keychain\|file`,env `GOG_KEYRING_BACKEND` 覆盖 config | `gog auth keyring --help` 列 `auto\|keychain\|file`;二进制串 `NOTE: GOG_KEYRING_BACKEND=%s overrides config.json` | file backend 可用于 daemon uid(A/B),避免非登录用户无 login keychain 的死角 |
| gog file backend 用 `GOG_KEYRING_PASSWORD` 加密 | 二进制串 `GOG_KEYRING_PASSWORD found in environment.` | file 后端的「加密」需要一个口令;口令来源见 §4——**边界仍是 uid 文件权限,不是这层加密** |
| gog 支持 `--client`(独立 credentials + token bucket)、`GOG_CLIENT` env | `--help` 全局 flag;二进制串 `GOG_CLIENT` | 可在**同 uid** 内分桶,但同 uid 可读 ⇒ 分桶只是混淆(见 §3) |
| gog token 可跨 keyring/uid 迁移 | `gog auth tokens export <email>` / `import <path\|->` | A/B 迁移机制:founder uid 导出 → daemon uid 导入(或 daemon uid 直接 `auth add` 重授) |
| gog 可按 service 拆 scope、可降只读 | `gog auth add --services gmail,calendar,... --readonly`;二进制含 `.../auth/calendar.readonly` | 杠杆 A 可行:founder uid 重新授权成 `gmail,drive,...`(去 calendar)或 calendar 只 `--readonly` |
| personal calendar 现为整域 RW | `gog auth services` → calendar scope = `.../auth/calendar`(无 per-calendar scope) | 「只去掉日历写」必须在**重新授权**时按 service 拆,不能靠运行期参数 |
| gws 同样可按 service/只读重授 | `gws auth login --readonly \| -s drive,gmail,sheets`(省略 calendar) | 杠杆 A 必须**同时**覆盖 gws(founder uid 通往同一日历写的第二条 CLI 路径) |
| gws「加密」对同 uid 无效 | `gws auth export` = **明文吐出 decrypted credentials 到 stdout**;`.encryption_key` 与 `credentials.enc` 同目录 0600 | 坐实 exploration §2:同 uid 的「加密存储」不是边界 |
| founder primary ACL 可加第三方 writer | `gog --account personal calendar acl primary` 现为 owner + public reader,无第三方 | 杠杆 C(bot 身份)可行:授 bot 一条 writer ACL;吊销=删该行 |

## 2. daemon uid 边界(方案 A/B 的地基)的机械

- **真边界证据**:`sudo -n` 在本机是**密码门**(非免密)。⇒ 另一个 uid 的 0700 家目录 / 0600
  文件,对没有交互 sudo 密码的 founder-uid agent **不可读**。这是本机唯一的 OS 级隔离原语。
- **落地形态**:专用角色用户(如 `_flywheelcal`)+ **LaunchDaemon**(`/Library/LaunchDaemons/`,
  root 装载,`<key>UserName</key>` 指定运行 uid)。一次性 provisioning 需 admin(`sysadminctl`/
  `dscl` 建用户 + `launchctl bootstrap system`),即 Lead 说的「密码门 admin 操作」。
- **keyring 选型**:daemon 用 **gog `file` backend**(§1)。理由:非登录角色用户没有会自动解锁的
  login keychain,keychain backend 重启后无人解锁 → 违反 issue「启动恢复」硬要求;file backend
  的密文在 daemon uid 0600 下,重启即可用。
- **口令来源(unattended)**:`GOG_KEYRING_PASSWORD` 由 daemon 启动 wrapper 从 **daemon 家目录
  0600 文件**读出后 export;**绝不**放进 `/Library/LaunchDaemons/*.plist` 的 EnvironmentVariables
  (该 plist root 拥有但通常 0644 全局可读,会把口令泄回 founder uid)。边界是 daemon uid 文件权限,
  口令只是防离线拷贝的纵深。
- **confused-deputy 必须一并隔离**:Raya 的输入状态(`~/.flywheel/raya/data/state/*.json`)
  今天 owner=xiaorongli(uid 501,与 agent 同 uid,实测 `ls -ld` 0700 但同 uid ⇒ agent 可读写)。
  ⇒ 今天 agent 能**伪造一场会议**让 Raya 照写日历。A/B 下状态目录归 daemon uid 0700,founder-uid
  agent 写不进 ⇒ 该路径被堵。**这条是 A/B 相对 C 的关键增量**(见 §3)。

## 3. 同 uid 隔离的可达性上限(方案 C 的判定证据)——决定性

C 的约束 = **不新建系统用户,Raya 仍以 `node cli.js` 运行**。逐条实测其可用隔离原语:

| 候选同 uid 机制 | 实测 | 判定 |
|---|---|---|
| 换目录 / 换 `--client` / gog `file` backend(仍 founder uid) | 同 uid 可读密文 + 可读 `GOG_KEYRING_PASSWORD`(必在 founder uid 某 0600 文件) | **混淆非隔离**:agent 复算出同一把写钥匙。FLY-2137 教训下沉一层。 |
| macOS Keychain 可信应用 ACL(条目只授签名 app) | Raya 实测是 `node`(adhoc 签名)跑**未签名** `cli.js`;`codesign -dv cli.js` = `not signed at all`,node flags=`0x2(adhoc)` 非 hardened | **失败**:ACL 只能绑**可执行体=`node`**,而 agent 也用**同一个 `node`** 跑自己的脚本 ⇒ ACL 会一并放行。共享解释器使 per-app ACL 无从区分。 |
| hardened-runtime 防同 uid ptrace(护住进程内 token) | node 非 hardened(见上);且真正读 keychain/写日历的是 `gog`(与 agent 共享的二进制) | **不可达**:要靠它须把写路径改成**独立编译+Developer ID 签名+hardened 的原生 helper**(丢掉 gog、丢掉 node),= 新造原生工具链,工作量≥建 uid,且仍不堵 confused-deputy |
| confused-deputy(伪造 Raya 输入驱动它写) | 状态文件同 uid 可写(§2) | **C 无法堵**:即便护住凭据字节,同 uid agent 仍能伪造 meeting 让 Raya 写 founder 日历 |

**C 结论(作为否决基线,应 Lead 要求写死)**:
在「不动系统层 + Raya 仍是 node」的约束下,**没有任何机制能把 founder 日历写能力从同 uid agent
手里隔离出去**——凡 Raya 作为 `node` 能读到的,agent 作为同一个 `node` 也能读到(keychain ACL
绑的是共享解释器;文件是同 uid);即便退一步只护凭据字节,confused-deputy 路径仍开着。
唯一能让 C 达标的走法是**另造一个签名+hardened 的原生 helper 二进制持凭据**,那既非「不动系统层
的轻量方案」,工作量也≥方案 A,且**仍堵不住 confused-deputy**。故 **C 不达标**;它最多把
「Claude 会话直接 CLI」这条窄路再抬高一点(与 FLY-2137 护栏同层),不构成 issue 要求的授权边界。

## 4. 杠杆 A(scope 收窄)的独立价值与顺序

- scope 收窄**不依赖任何文件权限**,是最抗绕过的一条:founder uid 的 personal/gws token 重授成
  **不含日历写**后,即便整把 token 被偷,Google 侧也换不出一次日历写。
- 但 A **单独不够**:Raya 仍需一把能写的钥匙;这把钥匙若在 founder uid,agent 偷的是 Raya 的钥匙。
  ⇒ A 必须与 uid 边界(B)组合。这正是「A/B 缺一不可」的机械原因(exploration §3)。
- **顺序(先立后破)**:先在 daemon uid 备好写路径并实测 FLY-2130 正路绿,**再**收窄 founder uid
  的 scope;否则出现 Raya 断写窗口。回滚三条独立:重授补回 founder scope / plist 切回 LaunchAgent /
  删 bot ACL。

## 5. 杠杆 C-身份(bot)形态对比(方案 A vs B 的差别就在这)

| | 方案 A:独立 bot Google 身份 | 方案 B:founder 本人独立 token |
|---|---|---|
| daemon uid 持有的钥匙 | bot 账号 token,仅在 founder primary + QA 日历有 writer ACL | founder personal 的第二把 token,calendar 整域 RW |
| 泄露(daemon uid 被攻破)后果 | 只能改被 ACL 授权的那几个日历,碰不到 founder gmail/drive/其他日历 | founder 全部日历 RW |
| 吊销 | 删 primary 的一条 ACL,**不牵动** founder 本人任何会话 | 撤 founder 该 token,可能牵动/需重授 founder 其他会话 |
| 「按服务身份隔离」(issue 原文) | ✅ 真正按独立身份 | ⚠️ 仍是 founder 本人身份,只是换了存放 uid |
| founder 一次性操作 | 需**注册/授权一个 bot Google 账号** + 在 primary 上授它 writer ACL(几步,账号生态层) | **无需新账号**,daemon uid 内 `gog auth add personal`(密码门 provisioning 内完成) |
| 达标性 | 达标(最小权限最优) | 达标(least-privilege 弱,见上) |

## 6. QA 写入路径(三方案通用)

- **选**:独立 QA Google 身份,仅在「QA 测试日历」上有 writer ACL,在 founder primary **无 ACL**。
  QA 写靠 ACL 约束到测试日历,结构上碰不到 primary(既无 scope 也无 ACL)。
- QA 日历 id 落 `~/.flywheel/qa-calendar-id`(实测当前**缺失** ⇒ FLY-2137 的 P6 QA 豁免现为 inert),
  本单落地即**激活**该豁免。
- 否:QA 复用 founder 写凭据靠「命令指向测试日历」——写 primary 的能力仍在 QA 手里,一个参数写错
  就打到 primary,正是 FLY-2137 P6 要防的;ACL 边界比参数纪律硬。

## 7. 负向越权探针(issue 硬要求「可执行证据」的可行性)

均可在本机以 founder uid(agent 视角)执行、留 durable 证据(**探针的真实 CLI grammar 见 plan.md
§7,codex R4 核实**:gog 写是 `calendar create <id> --summary --from --to`,`events` 是只读 list;
gws 写是 `events insert --params '{"calendarId":…}' --json <body>`,无 `--calendar` flag。以下为
探针意图,命令以 plan.md §7 为准,且打 **CANARY** 不打真日历):
1. gog `calendar create "$CANARY" …`(直接、绕 hook,先本地过 grammar)→ 期望**有效 token + 403
   insufficient scope**(证明杠杆 A:founder uid 无写 scope);
2. gws `events insert --params '{"calendarId":"$CANARY"}' --json <body>`(先 `--dry-run`)同上(第二
   路径也无 scope);需一把现行有效、无写的 gws grant 以区分于 7.3a 的旧 grant;
3. 读 daemon uid(W)的 token 文件 / `sudo -n -u <W> gog ...`(无密码)→ 期望 **Permission denied**
   (证明杠杆 B:uid 边界);
4. 伪造 uid I/W 的 state/inbox → 期望**写不进**(证明 confused-deputy 文件面被堵);
5. QA 账号写 **FOUNDER_CALENDAR_ID**(显式,非 primary)→ 期望 **404 notFound / 明确 authz 拒绝**
   (Calendar 对无权访问日历合法返回 404,不是 403);owner 侧 ACL inventory 佐证 QA 不在 ACL;
6. Raya 正路(FLY-2130 create/cancel)从 daemon 触发 → **成功**(证明无回归)。
   探针 5 的「写 primary」演练须指向**确认无 ACL 的账号**,不触达真 primary 内容(照 FLY-2137
   负测试不触达真 primary 的纪律)。

## 8. 迁移 / 轮换 / 启动恢复 / 回滚 的机械可行性

- 迁移:`gog auth tokens export/import` 跨 uid(§1);或 daemon uid 内直接 `auth add` 重授。
- 轮换:daemon uid 内重跑 `gog auth add`(bot 或 personal)刷新;founder uid token 独立轮换。
- 启动恢复:LaunchDaemon `KeepAlive` + gog `file` backend(重启即可用,无需交互解锁)——keychain
  backend 在非登录角色用户上做不到,故 §2 选 file。
- 回滚:三条独立且都不破坏性——founder scope 重授补回 / plist 切回每用户 LaunchAgent / 删 bot ACL。
