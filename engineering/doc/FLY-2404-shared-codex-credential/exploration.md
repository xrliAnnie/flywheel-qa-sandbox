# FLY-2404 全机一份 Codex 凭据 — 探索

Issue: FLY-2404 (https://linear.app/geoforge3d/issue/FLY-2404/codex凭据-全机只用一份-codex-凭据runnerleadraya-的每个-codex-home-不再各存一份-authjson)
日期: 2026-09-06
基于: 无

## 0. 一句话

让每个 Codex home 保留自己的家(sessions / config / skills / 记忆库),但 `auth.json` 不再是副本,而是一条指向主机 `~/.codex/auth.json` 的 symlink;Codex 0.153.2 自己的刷新协议(先回读磁盘再决定要不要刷新、刷新失败只记在旧快照上)已经保证多进程共享一份 auth.json 是安全的,本节点用 6 进程真实并发 + 严格假权威实验证实了这一点。

## 1. founder 原话与本单要回答的问题

> 「能够做到让他们有自己的 Codex Home,但是底端完全用同一套凭据吗?就不用我们一个电脑上用多个凭据,只用一个凭据就行了,不要每个 Home 都有自己的凭据。」 —— 2026-09-06 17:00 PT,[FLY-2394] thread

拆成四个必须回答的问题:

| # | 问题 | 本文结论 |
|---|------|---------|
| Q1 | N 个 `CODEX_HOME` 的 `auth.json` 指向同一真身,N 个进程并发跑 + 强制刷新,会不会互相打死? | **不会**。源码 §3 + 实验 §4。 |
| Q2 | 真身放哪、用什么机制指过去? | 真身 = 主机 `~/.codex/auth.json`(founder `codex login` 落地处);机制 = 每个 home 一条 symlink。§5 |
| Q3 | 现有 879 个旧 home、Raya、各 Lead home 怎么切? | 新 spawn 直接链接;keyed home 与 Lead/Raya 在班车重启窗口切;旧 execution home 不迁移,给一次性清理脚本。§6 |
| Q4 | 单点故障怎么探测、founder 怎么「只登一次」全机恢复? | `codex-global-health` 增加凭据探针;founder 在主机 `codex login` 一次,所有 symlink 立即看到新真身。§7 |

## 2. 现状审计(2026-09-07 00:1x UTC,只读;所有 token 只以 sha256 前 8 位出现)

### 2.1 谁持有哪条 refresh token 链

Codex 的 refresh token 是**轮换式**的:每刷新一次服务端发一条新的,旧的立刻作废。所以「同一条链」= 同一份可刷新的凭据实体;两份副本持同一条链,先刷新的一方让另一方死。

| 持有者 | 账号(account_id 前 8 位) | 链(refresh token sha8) | last_refresh | access token 到期 | 备注 |
|--------|------|------|------|------|------|
| 主机 `~/.codex/auth.json` | 4c0a10e8 business | **228eace0** | 2026-09-02T03:27Z | 2026-09-12T03:27Z | 普通文件,0600;`.active`=business |
| `~/.codex/profiles/business/auth.json`(pool) | 4c0a10e8 | **228eace0** | 同上 | 同上 | 与主机同链 |
| 旧 execution home ×111 | 4c0a10e8 | **228eace0** | 同上 | 同上 | 均为副本 |
| **活体** keyed home `~/.flywheel/codex-homes/agents/flywheel/implement` | 4c0a10e8 | **228eace0** | 同上 | 同上 | 8 个活 codex 进程(FLY-2358 持久家),17:09 刚重新 provision |
| Raya `~/.flywheel/raya/codex-home` | 4c0a10e8 business | 6d021f71 | 2026-09-06T23:59Z | 2026-09-16T23:59Z | **独立登录**,与主机不同链 |
| Mufasa `~/.codex-mufasa` | f5d51f90 school | aa21bda8 | 2026-09-06T22:08Z | 2026-09-16T22:08Z | 独立链 |
| infra-bot `~/.codex-infra-bot` | 1c06bcad personal | 351564f5 | 2026-09-01T03:11Z | 2026-09-11T03:11Z | 独立链 |
| `~/.codex-raya` | — | — | — | — | **不存在**;仓库里 Raya Lead 的 launcher 推导出这个路径,但生产 Raya 用的是 `~/.flywheel/raya/codex-home`(见 §6.3) |
| 旧 execution home 其余 767 个 | school ×多条链 / personal ×2 条链 | 各异 | 7-07 … 8-24 | 大多已过期 | 全部普通文件,无一 symlink(与 Lead 抽样一致) |

### 2.2 定时炸弹

Codex 的主动刷新规则(`should_refresh_proactively`,见 §3.2):access token 到期前 5 分钟就刷新。business 链 228eace0 的 access token 2026-09-12T03:27Z 到期,而 last_refresh 是 9/2 —— 它的 access token 有效期 10 天。**2026-09-12T03:22Z 前后**,每一个仍在用这条链的进程(主机上 founder 的 codex、keyed home 的 8 个进程、任何新 spawn 的 runner)只要发一个请求就会抢着刷新;只有一个赢。若主机 `~/.codex` 输了,之后所有新 spawn 的 runner 都从主机复制到一份死凭据 —— 这就是 9/6 Raya + 10 个 runner 副本同死的翻版。

⇒ 本单实现必须在 2026-09-12 之前把 keyed home 与新 spawn 切到 symlink;否则至少要在班车窗口让主机真身先刷新一次(见 plan 的「切换前置」)。

### 2.3 仓库里 auth.json 的每一个写点 / 读点

FLY-2358 的判据:改家的键前先列「家里每个文件谁写、按什么粒度写」。auth.json 的完整消费者清单在 research.md §2,这里只列会**直接决定方案**的四条:

1. `packages/claude-runner/src/codex-home.ts` `provisionCodexHomeAt()` 1508 行:`writeManagedFile(<home>/auth.json, sourceAuth.raw)` —— **唯一的副本制造点**。legacy 路径是 `writeFileSync`(跟随 symlink,若 dest 已是链接会**写穿到主机真身**并 chmod 真身);keyed 路径是 tmp+rename(会**把链接换回普通文件**)。两条都要改。
2. 同文件 `readCodexSourceAuth()` 644-657 行:`lstat` + `O_NOFOLLOW`,**拒绝主机源 auth.json 是 symlink**。这条要保留:真身必须是普通文件,是全机唯一不许是链接的那份。
3. `packages/claude-runner/bin/flywheel-codex-profile.mjs`:`status` / `use` / `save` 都经 `readSafeFile` / `assertReplaceableFile`,遇到 symlink 直接失败。这是 operator 工具链的硬阻塞,但它们操作的是 `--home ${CODEX_HOME:-$HOME/.codex}`,即**主机真身**,真身是普通文件 ⇒ 不受影响;只有把它指向 runner home 时才会失败,而这正是我们要禁止的操作。
4. `packages/teamlead/scripts/codex-lead-tui-home.sh` 189-243 + 1149-1163 行:app-server stderr 里一出现 `refresh_token_reused` 就判「凭据已死」→ `auth_dead_hold` + `daemon_die`。共享真身后这个字符串可能是**良性竞争输家**的一次性日志(§4 wave C 正是 5 次),分类器不能再一见就杀。

## 3. Codex 0.153.2 源码事实(浅克隆 `openai/codex` tag `rust-v0.153.2`,commit 657a993c;本地 `~/Dev/codex` checkout 是 2026-02-14 的,不能作依据)

### 3.1 auth.json 的读写路径:`codex-rs/login/src/auth/storage.rs`

- `get_auth_file` = `$CODEX_HOME/auth.json`(154-156 行),没有任何配置或环境变量能把它指到别处(`CODEX_AUTH*` 一族环境变量只覆盖 client_id / 刷新 URL / 撤销 URL / authapi base,没有「auth 文件路径」)。
- `FileAuthStorage::load`(196-204):`File::open` + `read_to_string` + `serde_json::from_str`。**跟随 symlink**。
- `FileAuthStorage::save`(206-224):`OpenOptions::truncate(true).write(true).create(true).mode(0o600)` → `write_all` → `flush`。**原地 truncate 写,不是 tmp+rename,没有 flock**。后果:(a) 跟随 symlink,写进目标 inode,链接不会被替换 —— 这是 symlink 方案成立的前提;(b) 存在微秒级的「撕裂读」窗口(另一进程恰好在 truncate 与 write 之间 open),见 §3.4。
- `delete_file_if_exists`(158-165):`remove_file(<home>/auth.json)`。对 symlink 只删链接本身,**不碰真身**。所以某个 runner home 里的 `codex logout` 不会登出全机。
- keyring 模式(`auth_credentials_store_mode = "keyring"`)的 key 是 `sha256(canonicalize(CODEX_HOME))` 前 16 位(`compute_store_key` 238-250),**按 home 分 key**,不能用来共享。排除。

### 3.2 刷新协议:`codex-rs/login/src/auth/manager.rs`

```text
auth()                                   // 每个请求前都会调(core/src/client.rs:1064 等 8 处)
 └─ should_refresh_proactively(cached)   // 2924-2946: JWT exp ≤ now+5min ⇒ true;
 │                                       //   JWT 无 exp 时才看 last_refresh > 8 天
 └─ refresh_token()                      // 2768-2801
     ├─ refresh_lock.acquire()           // 进程内互斥(tokio Semaphore)
     ├─ reload_if_account_id_matches()   // 2431-2464: 先回读磁盘;account_id 不同 ⇒ Skipped;
     │                                   //   磁盘上的 token 与缓存不同 ⇒ ReloadedChanged ⇒ 直接用磁盘的,不刷新
     └─ refresh_token_from_authority_impl()   // 磁盘无变化才真的调权威
         ├─ refresh_failure_for_auth(attempted)   // 2331: 若这份快照已记过永久失败,直接返回该错误
         ├─ request_chatgpt_token_refresh()       // 1583-1633: POST {client_id, grant_type, refresh_token}
         │     401 / refresh_token_reused|expired|invalidated ⇒ Permanent;其余 ⇒ Transient
         ├─ persist_tokens() → storage.save()     // 1556-1581: load ⇒ 改 tokens + last_refresh ⇒ save
         └─ record_permanent_refresh_failure_if_unchanged(attempted, err)  // 2503-2518
                                                  //   只有「当前缓存仍等于失败时那份快照」才记账
set_cached_auth(new)                     // 2536-2555: 回读后若 token 变了 ⇒ 清空 permanent_refresh_failure
```

由此得到三条对本单决定性的性质(均有测试:`auth_tests.rs:1176 refresh_failure_is_scoped_to_the_matching_auth_snapshot`;`unauthorized_recovery_*` 一族):

1. **先看磁盘,再决定刷不刷**。多个进程共享一份文件时,只有「磁盘上还是旧 token」的那个进程会去调权威;别人一旦落盘,后来者回读到新 token 就不刷新。
2. **刷新失败按快照记账**。输家拿到 `refresh_token_reused` 后,失败只绑定在它手里那份旧快照上;下一次 `auth()` 回读磁盘拿到赢家的新 token,`set_cached_auth` 顺手清掉失败记录 —— **自愈,不需要任何我们的代码**。
3. **401 恢复也是先回读**(`UnauthorizedRecovery` 1960-2005:Reload → RefreshToken → Done)。所以哪怕输家已经用旧 access token 发了请求被 401,恢复第一步也是回读磁盘。

### 3.3 为什么「副本」会死而「共享」不会

副本模式下,输家回读的是**自己那份副本**,磁盘上仍是旧 token ⇒ `ReloadedNoChange` ⇒ 再拿旧 refresh token 去刷 ⇒ `refresh_token_reused` ⇒ 永久失败,且回读永远看不到新 token。这就是 9/6 事故的机制。共享真身把「磁盘」变成同一个,上面三条性质才生效。

### 3.4 残余风险(诚实边界)

| 风险 | 机制 | 量级 | 处置 |
|------|------|------|------|
| 同时通过 guarded reload 的多个进程都去调权威 | 权威 RTT(~0.3-1s)内起跑的进程都看到旧磁盘 | 实验 wave C 6 个进程全撞上,5 个 REUSED 但全部自愈,零 401 | 接受;plan 里把 `refresh_token_reused` 单次出现列为「良性」,分类器改为二次确认 |
| 撕裂读 | `save` 是 truncate 后 write,另一进程在这几微秒内 open 会读到空/半截 JSON ⇒ `load_auth` `.ok().flatten()` ⇒ 缓存变 None ⇒ 那一次 `auth()` 无凭据 | 窗口微秒级 × 每 10 天一次刷新;无法从我们这侧消除(写的是 Codex) | 接受并写明;401 恢复路径会再回读一次,通常自愈。plan 的探针不把单次瞬时失败判死 |
| 真身本身过期 / 被撤销 | 一份凭据 = 全机同死 | 这是 founder 明确接受的代价(「只用一个凭据」) | Q4:探针 + 一次登录全机恢复 |
| 配额集中 | Mufasa(school)、infra-bot(personal)并入 business 后所有 Codex 用量打到一个 Plus 账号 | 现在三个账号各自的 usage limit 已经常撞(memory:9/4 五号全灭) | 写明,由 Lead/founder 决定是否接受;设计上可用 `FLYWHEEL_CODEX_TRUTH` 指向别的真身,但默认只有一份 |

## 4. 并发实验(2026-09-07 00:24-00:28 UTC,codex-cli 0.153.2,N=6)

环境:6 个 scratch home `h1..h6`,各自 `auth.json` → symlink 到同一 `truth/auth.json`;config 只含 model / sandbox / approval 四行。真身来源 = `~/.codex/profiles/school/auth.json` 的拷贝(链 bc77da87 无任何活体持有者:19 个持有该链的旧 home 里唯一活着的 `codex app-server`(c231bee7)不在 CommDB sessions 里,是 9/2 已退役的孤儿)。school 账号当时处于 usage limit(到 9/7 21:57),但 usage-limit 是**鉴权通过后**的 429,用它判「鉴权是否成功」反而干净:出现 `usage limit` = access token 被服务端接受。

证据文件在 `exp-evidence/`:`run-wave.sh`(波次驱动)、`fake-authority.py`(严格假权威)、`wave-summaries.md`(每波每进程统计)、`waveC-authority-ledger.jsonl`(假权威逐请求账本)。所有文件已 grep 确认不含 JWT 形状的字符串。

| 波次 | 设置 | 真身变化 | 6 个进程 | 结论 |
|------|------|---------|---------|------|
| A | 原样,无刷新条件 | sha 不变;inode 677712804、mode 0600 不变 | 全部 `/models` 200 → usage limit;`unauthorized=false` | symlink 读路径成立 |
| B | 只回拨 `last_refresh` 到 8/20 | **无变化** | 同 A | 证实 §3.2:JWT 有 exp 时只按 exp 判断,`last_refresh` 规则不生效 |
| B2 | 把 access token 的 `exp` 改成 60s 前 | **真实轮换一次**:last_refresh → 2026-09-07T00:25:35.500Z,链 bc77da87 → 92e5f59d;inode / mode 不变;6 条 symlink 完好 | 全部 200 → usage limit,零 401 | 6 进程同时触发主动刷新,真身只被写成一个一致状态,没人被打死 |
| C | 假权威 `CODEX_REFRESH_TOKEN_URL_OVERRIDE`(对已轮换的 refresh token **严格**返回 401 `refresh_token_reused`,模拟 RTT 0.4s);真身去掉 exp + 回拨 last_refresh | 账本:t=860.713 **ROTATED**(92e5f59d);t=861.215-861.216 **REUSED ×5**(都拿旧链来刷) | 全部 200 → usage limit;`unauthorized=false`;没有第二轮权威调用 | **最坏情况**:6 个进程同一瞬间都通过了 guarded reload,5 个输家被严判 reused,但它们下一次 `auth()` 回读到赢家落盘的新 token 后直接跳过刷新 —— §3.2 性质 2 实证 |
| D | 同 C 设置再跑一次(稳态) | 不变 | 全部正常 | 刷新后稳态零权威调用 |

B2 那次真实轮换发生在 tracing 订阅器装好之前(文件 00:25:35.500Z,首条 stderr 日志 00:25:35.663Z),所以 stderr 里看不到 `Refreshing token` 行;权威调用次数的精确计数靠 wave C 的假权威账本。

事后处置:把轮换后的真身原地写回 `~/.codex/profiles/school/auth.json`(0600,同 account_id 校验),pool 快照保持可用;scratch 里所有含真实 token 的文件已删除;未碰 business / 主机 / Raya / 任何 Lead 的活体凭据。

## 5. 方案选项

| 方案 | 做法 | 优点 | 致命缺点 | 判定 |
|------|------|------|---------|------|
| **A. 每 home 一条 symlink → 主机真身** | provision 时 `symlink(~/.codex/auth.json, <home>/auth.json)`;Lead/Raya 在班车窗口把自己的 auth.json 换成同样的链接 | 零副本可失效;Codex 原生刷新协议直接生效(§3、§4);founder `codex login` 一次全机生效;`rmSync` / `codex logout` 只删链接 | 真身必须永远是普通文件(已有守卫);read-deny 沙箱若对解析后路径生效会挡住(§6.4) | **采用** |
| B. hardlink | `link()` 到同一 inode | 对 Codex 完全透明 | 任何 tmp+rename 写(我们自己的 `atomicWriteFile`、`flywheel-codex-profile use`)都会让 inode 分叉,而且分叉**静默**、`ls` 看不出;不能跨卷 | 否决 |
| C. Codex keyring 模式 | `auth_credentials_store_mode="keyring"` | 无文件 | key 按 CODEX_HOME 哈希,天然按家隔离(§3.1) | 否决 |
| D. 单一刷新代理 | 自建本地 OAuth 代理,所有 home 的 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 指向它 | 权威调用严格一次 | 各 home 仍是副本,access token 到期后代理要把新 token 推回每个副本 = 重造同步器;多一个常驻进程;实验证明没必要 | 保留为 Codex 将来改坏刷新协议时的退路 |
| E. 定时同步器 | cron 把真身复制到每个 home | 不改 provisioning | 复制窗口内仍是副本,先刷新的一方仍会打死别人;同步器自身可挂 | 否决 |

## 6. 切换设计要点(细节进 plan)

### 6.1 新 spawn 的 runner home
`provisionCodexHomeAt` 不再写 `sourceAuth.raw`,改为:校验真身(保留 `readCodexSourceAuth` 的 lstat + O_NOFOLLOW + identity 校验)→ 若 `<home>/auth.json` 已存在则 `lstat`:普通文件 ⇒ `unlink`,链接指向别处 ⇒ `unlink` → `symlinkSync(truth, <home>/auth.json)`。`.active` 照旧写(记录 spawn 时真身的 profile)。两条 provision 路径(legacy `writeFileSync` / keyed `atomicWriteFile`)都走这一个新函数,`atomicWriteFile` 不再用于 auth.json。

### 6.2 keyed home(FLY-2358)与旧 execution home
keyed home `agents/<project>/<role>` 现在活着,8 个进程持副本。切换 = 班车重启窗口(FLY-2358 的 lease 归零、Bridge 重启)时下一次 provision 自然把副本换成链接;不在活体上热切(活体进程内存里缓存的还是副本 token,无害,但 §2.2 的炸弹要求窗口在 9/12 前)。旧 execution home 不迁移;给 `scripts/codex-home-credential-sweep.mjs`:只对「不在 CommDB sessions / 无活 codex 进程 / 名字是 execution id」的 home 删除 auth.json 副本(不删家),dry-run 默认。

### 6.3 Raya 与 Codex Lead
- 生产 Raya 的家是 `~/.flywheel/raya/codex-home`,由 raya 仓库/launcher 在仓外 provision(本仓零写点;`codex-lead-home-rule.test.sh:64` 还禁止 launcher 指向它)。本仓提供一个幂等脚本 `scripts/codex-home-link-truth.sh <home>`(lstat → 备份副本到 `auth.json.pre-fly2404`→ 换链接;活体检查:该 home 有活 codex 进程就拒绝),Raya launcher 在班车启动前调用它 —— 这是跨仓依赖,plan 里列为 handoff。
- Mufasa `~/.codex-mufasa`、infra-bot `~/.codex-infra-bot`:各自的 `run-codex-lead-*.sh` 在启动前调同一个脚本。它们当前分别是 school / personal,切过去就是并入 business(§3.4 配额集中)。
- `codex-lead-tui-home.sh` 748 行的 `[ -f auth.json ]` 对有效链接通过、悬空链接失败,行为正确,只补一句错误提示。

### 6.4 read-deny 沙箱
qa-fly310 的 Seatbelt 规则 `/Users/xiaorongli/.codex**` 按解析后路径匹配;若某个 Lead 启用了 `FLYWHEEL_CODEX_LEAD_READ_DENY=1`,它自己的 `auth.json` 链接会指进被 deny 的目录。现状:只有非生产的 `flywheel-codex-lead-wrapper-mufasa-tui.sh` 设了该变量,生产 full-access 明确不设。plan 里把「READ_DENY 与 symlink 真身互斥」写成启动前断言。

## 7. 单点故障:探测与恢复

- 探测:`codex-global-health` 增加 `credential` 维度:读真身(lstat 普通文件、0600、JSON 可解析、JWT exp 距今 > 30 分钟、`last_refresh` 不早于 exp−10d),再对 `~/.flywheel/codex-homes/agents/*/*`、`~/.codex-*`、Raya home 逐个 `lstat`:必须是链接且 `readlink` == 真身。任一失败 ⇒ `codex_global_unhealthy` meta-alert,body 里写「founder 在主机 `codex login` 一次即可全机恢复」。**不**在探针里跑 `codex exec`(会消耗配额、且 usage limit 会被误判为凭据死)。
- 恢复:founder 在主机 `codex login`。Codex 的 `save` 原地写同一 inode ⇒ 所有链接立即看到新 token;活体进程下一次 `auth()` 回读磁盘拿到新 token(§3.2 性质 1),不需要重启任何进程。
- 验收:Raya 与 Lead 切到共享后,`codex-global-health` 全绿一个班车周期。

## 8. 给 Lead 的问题(已通过 `flywheel-comm ask` 发出,question 380ac111,非阻塞)

1. 一份凭据 = 主机 `~/.codex` 当前登录的 business;Mufasa / infra-bot 并入后配额集中,是否接受?未答复则按此写 plan。
2. 9/12 定时炸弹的临时处置(班车窗口让主机真身先刷新一次)是否由 Lead 安排,还是等本单实现落地?

## 9. 决策

采用方案 A。Q1 已由源码 + 实验回答为「安全」,不需要停下报 Lead 改走替代路径。
