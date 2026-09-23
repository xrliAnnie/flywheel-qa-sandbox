# FLY-2762 Codex 号池按目录枚举 — 探索
Issue: FLY-2762 (https://linear.app/geoforge3d/issue/FLY-2762/codex-号池五号-flywheel-codex-profile-把号池写死为-schoolpersonalbusiness)
日期: 2026-09-22
基于: 无

## 1. 问题一句话

Codex 号池在代码里被写死成 `school / personal / business` 三个名字。磁盘上已经有六个登录好的号，
但 `codex-profile use/save`、自动切号、切号审计和通知都只认三个；founder 问「五个号的情况」时，
CLI 答不出来，只能靠 Lead 手拷 auth.json + `CODEX_HOME=` 直接探。

## 2. 实测现状(2026-09-22 23:xxZ,只读)

### 2.1 磁盘上的号池

`~/.codex/profiles/` 下有六个目录，每个都有 `auth.json`(id_token 里的 email / plan 如下，只读 JWT payload，未发网络请求):

| 目录 | email | plan(id_token) | 是否在注册表 |
|---|---|---|---|
| business | xrliannie.b@gmail.com | pro | 是 |
| personal | xrliannie@gmail.com | pro | 是(primary) |
| school | xiaorongli2011@u.northwestern.edu | pro | 是 |
| personal1 | xrliannie.1@gmail.com | prolite | 否 |
| personal2 | xrliannie.2@gmail.com | prolite | 否 |
| shopping | xrliannie.shopping@gmail.com | prolite | 否 |

另有 `.active`、`.codex-quota-account-locks/` 与若干 `*-auth.json.bak*` 散文件(不是目录，不是号)。

### 2.2 阴性对照(当前部署版 CLI，临时 home/ledger,零写入)

```
$ flywheel-codex-profile ... use shopping
Error: Unknown Codex profile 'shopping'; expected school, personal, or business   (exit 2)
$ flywheel-codex-profile ... save personal1
Error: Unknown Codex profile 'personal1'; expected school, personal, or business  (exit 2)
$ flywheel-codex-profile ... list
school: ready (manual_backup)
personal: ready (primary)
business: ready (manual_backup)
Untracked: personal1, personal2, shopping
```

### 2.3 额度页(FLY-2688,2026-09-22 09:12 PT 合入)已经是六个号

`~/.flywheel/codex-quota/codex-accounts.json`(Bridge 按需探针写的快照)已有六行，
`generatedAt=2026-09-22T23:26:20Z`,activeAccount=personal2。原因：FLY-2688 的
`listCodexProfileSlots()` **已经按目录枚举**,不看注册表。所以 issue 里「账号页只列 Codex 三号」
这一条**在 main 上已被 FLY-2688 顺带修掉一半**:行数对了，缺的是「token 状态」这一列的三态区分。
(issue 写于 9/20,早于 FLY-2688 合入。)

### 2.4 自动切号是开着的

生产 flag `codex_quota_auto_switch` 在 2026-09-20 21:53Z 按 founder 裁决被清除覆盖，
当前有效值 `true`。这意味着 `candidate-selector` 的三号候选池**正在生产里生效**。
把号池扩到 N 个，**会直接改变自动切号能挑的号**——这正是本单要的(多出来的号能被用上),
但必须写进边界和回滚说明：一键回滚杠杆就是这个 flag。

## 3. 「写死三号」在代码里的形状

不是一处字面量，而是三层：

1. **注册表校验层**(`codex-account-core.mjs`):`PROFILE_NAMES` 常量;`validateRegistry`
   要求恰好三个 profile、名字必须属于这三个、primary 必须是 `personal`。注册表文件里一旦加第四个号，
   所有加载它的进程(CLI、runner 出生、Bridge 额度运行时)**直接抛错**。
2. **身份映射层**:`identifyCodexAuth(raw, registry)` 用「email → 注册表名字」决定 profile 名。
   不在注册表里的 email 得到 `account-<slug>`(FLY-2750)。所以就算放开名字校验，
   `profiles/shopping/auth.json` 的身份也会被认成 `account-xrliannie-shopping`,
   与目录名 `shopping` 不符 → `verifiedAuth` 报 identity mismatch。
3. **下游名字白名单层**(teamlead):切号安装、外部根重绑、切号审计、outbox、切号通知、
   候选选择器、reset-credit 选择器各自再抄一份三号列表。canonical home 若装的是 personal2,
   `reconcileExternalRoot` 会以 `invalid_quota_external_identity` 拒绝。

完整清单见 research.md §1。

## 4. 方案选项

### A. 注册表加行(扩成六条)

把 `codex-account-registry.json` 扩成六条，`validateRegistry` 改为「N 条」。
- 优点：改动最小，身份映射层不用动。
- 缺点：**新号仍要改仓库里的 JSON 并发版**,违背「新号 = 建目录 + 登录，无需改代码」;
  注册表与磁盘是两份真相，会再次漂移(今天的 bug 本身就是这种漂移)。
- **否决。**

### B. 目录即真相，注册表只剩策略(推荐)

- 号池 = `profiles/` 下名字合法的**目录**。目录名就是 profile 名。
- 每个号的身份(email / accountId / plan)= 读该目录 `auth.json` 的 id_token。
- 注册表文件退化为只装**策略**:`{ "version": 2, "primary": "personal" }`。不再列任何号。
- 「有效号池」由一个函数现算：`loadCodexAccountPool({ profilesRoot, registryPath })`
  返回与今天 `registry` 同形状的对象(`{ primary, profiles:[{name,email,role}] }`),
  外加 `problems[]`(重邮箱、保留名、无凭据、坏凭据)。现有调用方只需换加载函数。
- 优点：一份真相；新号零代码;「未登录」状态天然可见(目录在、凭据不在)。
- 缺点：所有加载注册表的调用方都要换成现算(约 6 个入口);Bridge 里缓存注册表的地方要改成每次现算。

### C. 完全删掉注册表文件

- primary 策略没地方放，只能写成常量 → 又是一处写死。**否决**,保留 v2 策略文件。

## 5. token 状态三态

founder 09-19 指出看不出「吊销 / 未登录 / 打满」的区别。现有探针结果里已有素材：

| founder 看到的状态 | 来源判据 |
|---|---|
| 正常 | 探针 `account/rateLimits/read` 成功，且没有窗口 100% |
| 打满 | 探针成功，某窗口 `usedPercent==100`(已有 exhausted 计算) |
| 吊销/失效 | 探针返回 `invalid_grant / refresh_token_reused / _expired / _invalidated / token_revoked` |
| 未登录 | 目录存在但没有 `auth.json`,或 auth.json 不是有效凭据(今天这种目录**直接不显示**) |
| 未读 | 正被在跑的 Codex 占用、超时、库存未知(不是账号状态，是这次没读) |

「吊销」与「过期」是否再细分：错误码能分(`token_revoked|refresh_token_invalidated|refresh_token_reused`
= 吊销;`refresh_token_expired` = 过期;单独的 `invalid_grant` = 失效(原因不明))。
founder 的处置对这几种都是「重新登录」,所以页面上合并为一个「凭据失效·需重新登录」主状态，
括号里注明细分原因。

## 6. CLI `list` 的 token 状态从哪来

issue 要求「须真探而非读 last_refresh」。真探 = 用该号的 refresh token 起一个隔离的 `codex app-server`
读额度。这件事**已经有且只应该有一个实现**:Bridge 的 FLY-2688 观察器。它自带三件 CLI 做不好的事：
在用检测(不能和活着的 Codex 抢同一个 refresh token)、账号租约、refresh token 轮换后写回目录。

所以 CLI 不自己探。`list` 读 Bridge 最近一次真探写下的 `codex-accounts.json`,每行标注探测时刻和年龄;
`list --refresh` 让 Bridge 现探一轮(走 loopback,复用额度页 `?refresh=1` 的同一个单飞函数),拿不到 Bridge
时明确报「未刷新」而不是静默给旧数。

## 7. 开放问题(已按默认推进，写入 plan 的假设)

1. 自动切号候选池扩到 N 是否需要单独开关？默认：不加新开关，沿用 `codex_quota_auto_switch` 作总闸;
   plan 里写明部署后自动切号可能选中 personal1/personal2/shopping。
2. 是否保留三号的 email「钉扎」?默认：不保留(否则三个号有别人没有的保护，违背「不做特殊分支」)。
   改用「save 只能写回同一个 email 的目录」这条对所有号一致的规则防误存。
