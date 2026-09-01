# FLY-2204 日历写凭据隔离 — 操作手册
Issue: FLY-2204 (https://linear.app/geoforge3d/issue/FLY-2204/治理-隔离-founder-google-calendar-写凭据agent-上下文不可读)
日期: 2026-08-31
基于: implementation.md

## 0. 使用条件

这份 runbook 只能由 founder 在**明确的本人终端**执行；不得把 token、client secret、keyring password
或 Discord token 粘进 Claude/Codex/Gemini 会话。当前实现节点没有执行以下任何 live 命令。

开始前必须有：

1. A/B 书面裁决：A = 独立 bot Google 账号；B = founder Google 账号 + 独立 OAuth client/project；
2. 显式 `FOUNDER_CALENDAR_ID`，禁止 `primary`；
3. 可丢弃的 founder-owned `CANARY_CALENDAR_ID`，仅用于 scope 负探针；
4. 独立 QA Google identity + `@group.calendar.google.com` 测试日历；
5. 独立 sweep readonly OAuth client/project；
6. I 专用 Discord bot identity/token；该 bot 自身永远被 controller 拒绝，生产 QA allowlist 为空；
7. 已批准的 Flywheel 主仓和 Raya 伴生 PR commit SHA。

任何一项缺失就停在 Provision，不进入 Cutover。

## 1. 非秘密登记表

先在证据记录中填这些非秘密字段，不记录 credential bytes：

| consumer | Google account | OAuth client 名/client id 后 8 位 | GCP project | revoke 域 | Calendar scope | credential owner uid | 状态 |
|---|---|---|---|---|---|---|---|
| founder gog current | | | | | 无写 | A | planned |
| founder gws current | | | | | 无写 | A | planned |
| FLY-2137 sweep | | | | 独立 | readonly | A/sweep service | planned |
| W writer | A=bot / B=founder | | | 独立 | write | W | planned |
| QA | QA identity | | | 独立 | QA calendar only | QA 域 | planned |

若旧 grant 与 current reduced grant 落在同一 `(account, GCP project/revoke domain)`，不得把它们当成
可分别 revoke 的两把 token。该域必须先 revoke 旧授权，等待 `invalid_grant`，再在同 project 重授
reduced scope；或把 reduced current grant 放进真正不同的 project。

## 2. Provision：先建机制，不切生产写路径

### 2.1 选择未占用的 uid/gid

用 `dscl` 只读检查并记录 A 的现有 uid、两个未占用 service uid 和两个未占用 gid。示例名固定为：

- W user: `_rayacalw`
- I user: `_rayacali`
- writer transport group: `_rayacal`，成员严格为 I/W
- voice bridge group: `_rayavoice`，成员严格为 A/I

不得把 A 加入 `_rayacal`，不得把 W 加入 `_rayavoice`。

### 2.2 构建并冻结 root-owned Raya release

在伴生 PR SHA 上执行：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

把**完整构建树及其相对 node_modules 链**复制到一个新的、按 SHA 命名的稳定目录，例如
`/usr/local/lib/raya/releases/<RAYA_SHA>`；不要覆盖现有 release。随后递归设为 `root:wheel`，移除
group/world write。确认以下入口是 root-owned regular file，且依赖解析不逃出 release tree：

- `apps/brain/dist/calendar-writer-cli.js`
- `apps/brain/dist/meeting-ingress-cli.js`
- `packages/contracts/dist/index.js`

live verifier 会对选定 node 与前两个 daemon entrypoint 再做 fail-closed 检查：必须是非 symlink 的
executable/regular、`root:wheel`，且 mode 不含 group/world write；不满足时不得 activate。

### 2.3 先 render 到临时 root

先创建一个空临时 root，并在其中放同形的 Raya 入口、node 和 gog fixture；然后运行 installer 的
`render --root <fixture>`。renderer 只应在该 root 内生成：

- `/usr/local/libexec/raya-calendar-{peer-proxy,writer-wrapper}`；
- `/usr/local/libexec/raya-meeting-ingress-wrapper`；
- 两个 `/Library/LaunchDaemons/com.raya.*.plist`；
- `/etc/raya-calendar-isolation/{identity-plan.tsv,*.template}`。

对该 root 运行：

```sh
scripts/calendar-isolation/verify-calendar-isolation.sh fixture --root <fixture-root>
```

只有返回 `ready:true` 才继续。fixture 用完可删除；不得把 fixture plist bootstrap 到 system domain。
`identity-plan.tsv` 记录本次渲染选定的 node、calendar-writer 和 meeting-ingress 路径；fixture verifier
必须机械枚举两个 wrapper 的全部静态 shell 赋值（quoted/unquoted 都计入），并与 plan 中由本次 render
入参推导的 `wrapper-assignment` 行做精确集合和值比较，不能只核 terminal `exec` 形状。实际赋值缺失、
重复、漂移或出现 plan 无法推导的未知名称都必须 fail-closed；不得靠维护一份“已知风险字段”清单。
两个 wrapper 的 `id -u` self-check 还必须分别匹配 plan 的 `wrapper-uid-guard` 与 W/I 身份 uid。

`render` 省略 `--root` 必须立即失败。root 守卫按 device+inode 判定，不按字符串判定：与 `/` 同对象的
`//`、`/.` 等别名，或使真实写目标 `/etc`、`/usr/local`、`/Library/LaunchDaemons` 中任一个映射到
live 对象的 root（含 `/private` 与 `/System/Volumes/Data` firmlink 面），都视为 live root。直接指向
上述受保护绝对目标的 symlink 即使在当前 host 上悬空也同样 fail-closed。所有这些路径必须由 root 在
macOS 上传 `--ack FLY-2204-A-I-W`；不得把任何 live 别名当作 fixture。

### 2.4 安装身份与未激活服务

在已复核所有 uid/gid/path 后，以 root 运行 `install-calendar-services.sh apply`，并传入：

- A/I/W user + uid；
- `_rayacal`/`_rayavoice` + gid；
- 固定 node、gog、Raya release absolute path；
- literal `--ack FLY-2204-A-I-W`。

`apply` 只安装，不 bootstrap。它必须留下：

- W home/state/secrets/log = W owned 0700；
- I home/state/log = I owned 0700；
- persistent runtime ancestors = `/var/db/raya-calendar-isolation{,/run}`，均为 `root:wheel 0755`；
- socket parent = `/var/db/raya-calendar-isolation/run/calendar`，`_rayacalw:_rayacal 0750`（W 可
  bind/unlink，I 只有 traverse、不可替换 endpoint；A 对祖先链不可写）；
- I→A command/projection = `I:_rayavoice 0750`；
- A→I feedback = `A:_rayavoice 0750`；
- wrapper/proxy/plist/Raya release = root owned，service 不可写。

### 2.5 写入 W/I 私有配置

在 founder 本人终端复制并编辑模板：

- `/etc/raya-calendar-isolation/writer.env`：只含非秘密 gog path、account、client、显式 founder
  calendar ID；必须 `root:_rayacal 0640`；
- `/Users/_rayacalw/secrets/gog-keyring-password`：只含 password，W owned 0600；
- `/Users/_rayacali/ingress.env`：含 I 专用 Discord token 与 Discord/channel ids，I owned 0600。

`writer.env` 禁止出现 `GOG_KEYRING_PASSWORD`。password/token 禁止进入 argv、plist、shell history、
证据文件或 PR。W wrapper 由 launchd 先以 W 身份启动，再在 W 进程内从 0600 文件读取并 export
password；keyring backend 固定 `file`。
password 文件允许不带尾换行；wrapper 必须读到 EOF 前的全部字节，并继续以非空检查拒绝空文件。

把 I-owned `lead-registry.json` 和 meeting state 初始化到 I state。A brain/voice env 只增加：

- brain：`RAYA_MEETING_PROJECTION_DIR=<I→A dir>` 与 `RAYA_VOICE_COMMAND_DIR=<I→A dir>`；
- voice：`RAYA_MEETING_PROJECTION_DIR=<I→A dir>` 与 `RAYA_MEETING_FEEDBACK_DIR=<A→I dir>`。

从 A env 删除旧 `RAYA_GOG_BIN`、`RAYA_MEETING_CALENDAR_ACCOUNT/CLIENT/ID` 与任何 Calendar token。

### 2.6 Provision W grant（A/B 唯一分叉）

- A：W 的 file keyring 授权独立 bot Google account；owner 给该 bot 对显式 founder calendar 的
  writer ACL；bot 不获得其他 calendar ACL。
- B：W 的 file keyring 授权 founder account，但必须使用独立 OAuth client/project/revoke 域；
  不得复用 A 域的现有 gog/gws client。

运行 `gog auth add <account> --client <independent-client>` 时，password 从 W 文件在 W 进程内读取；
不要在 founder shell 里 export 或打印。完成后只记录 account/client/project/scope 的非秘密矩阵。

### 2.7 QA 与 sweep

用以下脚本写 QA calendar id（示例 output 应为 founder 的真实 `~/.flywheel/qa-calendar-id` absolute
path）：

```sh
scripts/calendar-isolation/configure-qa-calendar-id.sh \
  --calendar-id <QA_GROUP_CALENDAR_ID> \
  --output <ABSOLUTE_QA_CALENDAR_ID_FILE>
```

QA identity 只能写该 QA calendar，owner ACL inventory 必须证明它不在 founder calendar ACL。
为 sweep 建独立 readonly client，并给 sweep runtime 配置 `CALENDAR_SWEEP_CLIENT`；缺失即 fail-close。

## 3. Provision gate：不切流量前

必须全部通过：

1. fixture verifier；
2. W/I wrapper 以各自 uid 做 config/preflight，且不输出 secrets；
3. I bot identity 与 guild 正确，trigger 只有 founder，QA bot allowlist 为空；
4. W writer 对 canary 做一次明确授权的 create/cancel；
5. I→W authorized integration；非 I peer 在 Calendar adapter 调用前拒绝；
6. A 不在 `_rayacal`，A 无法读 W password/I env，A 无法写 I→A command；
7. sweep readonly client 能列显式 founder calendar；
8. QA calendar id 与 founder/canary id 三者逐字不同。

任一失败：保持旧 writer 为唯一生产路径，不进入 Cutover。

## 4. Cutover

1. 暂停旧 Raya meeting write gateway，确认没有在途 create/cancel；
2. 运行 installer `activate`，参数与 apply 完全一致，并传 `--ack FLY-2204-A-I-W`；
3. activate 先 bootstrap W、再 I；任一失败会 bootout 两者；
4. `launchctl print system/com.raya.calendar-writer` 和 `...meeting-ingress` 均应指固定 wrapper/user；
5. 保持旧路径停用，但暂不 revoke 旧 grant；此时仍是可回滚 provisional 状态；
6. 用 founder **真实人类 Discord identity** 做 FLY-2130 create → readback organizer/owner → cancel；
7. 用 A 可读的每一把发送型凭据发同形 exact-command，断言 I 无状态迁移且 founder calendar 零 mutation。

## 5. Retire 旧 grant 与 scope 收窄

按第 1 节逐 revoke 域处理。对同 project 域：先 server-side revoke 旧授权，等待收敛并用
`gog-revoked` 取得 `old_grant_revoked`；随后才在同 project 重授 reduced scope。对不同 project 域可
独立处理，但仍需分别记录 fingerprint 与 project。

旧 grant 证据：

```sh
node scripts/calendar-isolation/calendar-oauth-probe.mjs gog-revoked \
  --executable <ABSOLUTE_GOG> --account <OLD_ACCOUNT> --client <OLD_CLIENT> \
  --calendar-id <CANARY_CALENDAR_ID> --from <RFC3339> --to <RFC3339> \
  --ack FLY-2204-REVOKED-GRANT
```

current gog reduced-scope 证据：

```sh
node scripts/calendar-isolation/calendar-oauth-probe.mjs gog-scope \
  --executable <ABSOLUTE_GOG> --account <CURRENT_ACCOUNT> --client <CURRENT_CLIENT> \
  --calendar-id <CANARY_CALENDAR_ID> --from <RFC3339> --to <RFC3339> \
  --ack FLY-2204-LIVE-CANARY
```

current gws reduced-scope 证据同形，probe 名改为 `gws-scope`，executable 指固定 gws。脚本先
`--dry-run` 验 grammar，再做 live canary call；只接受 `insufficient_scope`。若返回
`unexpected_write_success`，立即停止 Retire、盘点并清理 canary event；禁止把该命令指向 founder
primary/calendar。

## 6. Final gate

### 6.1 live A/I/W 负向探针

以 root 运行：

```sh
scripts/calendar-isolation/verify-calendar-isolation.sh live \
  --root / --ack FLY-2204-LIVE-NEGATIVE
```

它必须同时证明：A/I/W uid/group 正确；W password/I token 跨域不可读；A 不能写 I→A commands；
I 不能写 A→I feedback；A connect writer socket 得 EACCES/EPERM；两个 system daemon 已加载。输出不
包含 credential bytes。

### 6.2 正路与恢复

1. FLY-2130 create/cancel 再跑一次，事件落显式 founder id，private meeting id 可读回；
2. 先做 `kickstart -k`/bootout+bootstrap W/I，再在 founder/root 维护窗执行一次真实 reboot；证明
   persistent runtime/voice directories 仍存在、两个 daemon 自动恢复，且无 login keychain 交互仍可
   create/cancel；
3. 模拟 I 重启/同 request replay，确认 request id 幂等、无重复 event；
4. 模拟 A voice restart，确认 command receipt 不 replay；
5. QA 写 QA calendar 成功并清理；QA 写 founder id 得 404 notFound/明确 authz 拒绝；
6. sweep 以独立 readonly client 成功扫描；
7. 同时保留：旧 grant invalid、current gog/gws valid 但 write scope insufficient。

只有 6.1/6.2 全绿，才可把 FLY-2137 的「唯一自动写入方」从行为护栏升级为机器强制结论。

## 7. 有序回滚

回滚不能先停 W/I：

1. W/I 仍运行时，重新授权回滚写 grant（旧 grant 已 revoke，必须新授权）；
2. 只对 canary 验证回滚 grant 可 create/cancel；
3. 恢复旧 state/config owner，准备旧 gui writer，但保持未启动；
4. drain I，installer `rollback --ack FLY-2204-A-I-W` 按 I→W bootout；
5. 启动旧 writer，确认单实例且可 create/cancel；
6. 最后才移除 bot ACL/清理 W/I 凭据；系统安全姿态明确退回 FLY-2204 前状态；
7. 保留 service identities 与证据，先调查，禁止边失败边删除。

## 8. 证据文件最小字段

每个 live probe 只记录：时间、commit SHA、主体 uid、非秘密 account/client/project 标识、calendar
kind（founder/canary/QA，不记录事件正文）、expected classification、actual classification、event id、cleanup
receipt、owner/mode、launchd label。任何 token/password/client secret 出现在 evidence/terminal transcript 即
视为 gate 失败并立即轮换。
