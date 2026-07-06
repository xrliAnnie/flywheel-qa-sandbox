# FLY-891 Discord bot 池独立 QA 干跑验证 — 调研

Issue: FLY-891
日期: 2026-07-05
基于: exploration.md

## 1. PR #452 现状核实

```
gh pr view 452 --json headRefOid,state,mergeable,statusCheckRollup
```

- `headRefOid` = `776af34b52c8f09541e3a16bff7ec7c95937b430` —— 与派发消息里的 HEAD 一致,不是过期 pin([[reference_qa_fetch_head_before_pass]] 教训:验之前必须核对 head sha)
- `state=OPEN`, `mergeable=MERGEABLE`
- CI:`Build & Test` → `SUCCESS`(唯一一条 check,10m4s)
- `headRefName=flywheel-FLY-882` → `baseRefName=main`

## 2. 改动文件清单

```
gh pr diff 452 --name-only
```

```
.claude/commands/setup-discord-lead.md
.github/workflows/ci.yml
doc/reference/discord-bot-pool-claim-guide.md
engineering/doc/FLY-882-discord-bot-token-pool/{exploration,plan,progress,research}.md
scripts/__tests__/discord-bot-pool.test.sh   (506 行)
scripts/discord-bot-pool.sh                  (59 行,CLI 入口)
scripts/lib/discord-bot-pool-lib.sh          (416 行,实现)
```

这些文件目前**不在** `flywheel-FLY-891` 分支上(它们活在 `flywheel-FLY-882` 分支/PR 里,尚未 merge)。用 `git show origin/flywheel-FLY-882:<path>` 可以只读查看内容而不切分支;真正跑脚本需要一个独立 worktree/checkout(见 plan.md)。

## 3. 脚本架构(读代码,非猜测)

`scripts/discord-bot-pool.sh` 是薄 CLI 入口,`source` 同目录 `lib/discord-bot-pool-lib.sh` 后按 `case "$cmd"` 分发到 `pool_*` 函数:`init / add-slot / list / verify(单个或 --all) / rename / invite-url / claim`。

`scripts/lib/discord-bot-pool-lib.sh` 关键设计(逐条对应派发消息要验的 5 件事):

### 3.1 建/验/认领脚本正确性 — 状态机与并发安全

- `pool_init`:创建 `~/.flywheel/discord-bot-pool/`(0700)+ 空 `pool.json`(0600),**幂等,绝不覆盖已存在的 pool.json**。
- `pool_add_slot`:注册一个 slot(要求 token 文件已存在于 `<pool-dir>/<slot>/token`,不代表真去建 Discord Application——Discord 没有这个 API,永远是人工 Portal 一次性动作)。
  - 外层 `pool_slot_exists` 做快速预检查(非权威)
  - `_pool_with_lock _pool_add_slot_write` 在拿到 mkdir 锁之后**重复一次**"已注册"检查——这是唯一权威点。Codex round 2 review 曾真实复现过:两个并发 `add-slot` 调用在锁存在之前都能通过外层预检查,导致 pool.json 出现重复 slot 条目(测试 T6f 覆盖)。
- `pool_claim`:同样模式——`_pool_with_lock _pool_claim_write` 内部重新读一次 `status`,只有 `unclaimed` 才允许写成 `claimed-by-<id>`。Codex review 也真实复现过两个并发 `claim` 调用都读到 `unclaimed` 导致后写者静默覆盖先写者(lost update),测试 T6e 覆盖。
- 锁本身:`_pool_with_lock` 用 `mkdir` 做便携原子锁(macOS 默认没有 `flock(1)`),10s 超时报错;`"$@" || rc=$?` 而不是裸调用,是因为 CLI 在 `set -e` 下跑,裸失败会在 `rmdir` 之前直接 abort,永久卡死锁目录。
- `pool_claim` 明确不动 `invited_at`——认领 ≠ 邀请进服务器,是刻意分离的两步(claim-guide.md 里说明)。

### 3.2 安全洞① — `verify` 回填 `bot_user_id`

`pool_verify`:只读 `GET /users/@me`(livecheck,从不写 Discord),200 时:
```bash
botid=$(jq -r '.id // empty' "$body" 2>/dev/null)
if [ -n "$botid" ] && pool_require_jq && [ -f "$(pool_json_path)" ] && pool_slot_exists "$slot"; then
  _pool_with_lock _pool_backfill_bot_user_id "$slot" "$botid"
fi
```
`_pool_backfill_bot_user_id` 用 jq 的 `(select(...)) |= (.bot_user_id = $bid)`,**只在 `bot_user_id` 当前为空字符串时才回填**(不会覆盖已有值)。测试 T3a2 断言:`verify` 跑完后 `jq '.slots[]|select(.slot=="flywheel-pool-01").bot_user_id'` == 打桩返回的 `"999"`。

生产 `~/.flywheel/discord-bot-pool/pool.json`(只读查看,未改动)显示 6 个 slot 的 `bot_user_id` 均已回填(值等于各自 `app_id`,这对 Discord bot 是预期的——bot 应用的 `app_id` 与其 `bot user id` 本就是同一个数字),印证这条路径在真实环境里跑过一次。但这是"事后状态",**不能替代独立复现**——QA 要在全新 fixture 上手工走一遍这条路径,而不是只看生产已经是回填后的样子。

### 3.3 安全洞② — `stat -f/-c` 跨平台分支

```bash
_pool_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}
```

注释明确写了根因:GNU `stat` 的 `-c` 是"format"(标准 -c 用法),但 GNU `stat` 的 `-f` 含义是"文件系统状态"(与 BSD/macOS 的 `-f`="format" 完全不同语义)——如果 `-c` 放在 fallback 位置、`-f` 放在第一位,在 Linux(GNU stat)上 `stat -f '%Lp'` **不会干净失败**,而是把一大段文件系统信息输出到 stdout,导致 CI(ubuntu-latest)下每一次权限比较全部错误(commit `e7dcf216` 修的正是这个顺序:`-c` 必须放在前面试)。

**CI 从不覆盖 macOS 分支**:`.github/workflows/ci.yml` 里这个 job `runs-on: ubuntu-latest`,GNU `stat -c` 在 Linux 上永远成功,`|| stat -f ...` 这半句在 CI 里**从未被真正执行到**。这正是这次独立 QA 要在**真机 macOS** 上单独验证的理由——CI 绿不代表这条 fallback 分支被验证过。

本机(Darwin 25.3.0, `/usr/bin/stat` = BSD stat)实测:
```
$ stat -c '%a' <file>
stat: illegal option -- c        # exit 1, 只写 stderr,干净失败
$ stat -f '%Lp' <file>
600                                # exit 0
$ stat -c '%a' <file> 2>/dev/null || stat -f '%Lp' <file> 2>/dev/null
600                                # 组合表达式正确落到 -f 分支
```
确认 BSD `stat -c` 失败是"干净"的(非零退出码 + 仅 stderr,没有污染 stdout),所以 `||` fallback 能正确接上 `-f '%Lp'` 并拿到期望的三位权限数字。这是探索性验证(用 scratchpad 里的临时文件,未碰生产文件),Implement 阶段要在真实 `discord-bot-pool.sh` 调用路径(`add-slot`/`verify` 等真实触发 `_pool_file_mode` 的命令)下重新走一遍作为正式证据,而不是仅凭这段独立小实验。

### 3.4 权限(0600 / 0700)

- `pool_init`:`chmod 700` 池目录,`chmod 600` 新建的 `pool.json`。
- `pool_add_slot`:`chmod 700` slot 目录,`chmod 600` token 文件,写完后立刻用 `_pool_file_mode` 复核确实是 600,不是就报错("could not enforce 600")。
- `_pool_load_token`(每次 verify/rename 读 token 前都过一遍,不只是注册时):要求 token 文件 `mode == "600"` 且长度 `>= 50` 字符且字符集只含 `[A-Za-z0-9._-]`,任何一条不满足就拒绝读取,不会把可疑内容送去 Discord。

### 3.5 现有测试覆盖(scripts/__tests__/discord-bot-pool.test.sh)

统计:文件里 `pass "T../F.."` 断言点共 **42 处**(`pass` 调用有缩进,所以要用 `grep -cE '^[[:space:]]*pass "'` = 42;注意 `grep -c '^pass "'` 会返回 0,因为行首不是 `pass` 而是空白缩进——Implement 阶段实测已核实此点;去重后 41 个测试 ID,因为 `T4c` 出现了一次 setup + 一次真断言两处,均以 `T4c` 开头)。PR body 文案写的"33/33 pass"是 Codex round 2/3 追加 T1e-T1i(5 条 slot-name/短 token/字符集校验)、T6e/T6f(并发 race)等测试**之后没同步更新的旧数字**——不是矛盾,只是文案滞后于代码,42 才是当前 HEAD 的真实断言数。

测试用 hermetic 手法:
- fixture `DISCORD_BOT_POOL_HOME`(`mktemp -d`,不碰真实 `~/.flywheel`)
- PATH 上放一个 stub `curl`:根据 Authorization token 内容返回 200(`VALIDTOKEN*`)或 401(其它),并把每次调用记录到 log,供测试断言 token 从不出现在脚本自身输出或 `ps`可见的 argv 里(`_pool_curl_authed` 用 `-K -`(stdin config)传 Authorization header,而不是 `-H` argv flag)
- 复用 `scripts/lib/fleet-sanitize.sh` 的 `scan_for_secrets` 做二次防线扫描 list 输出

测试矩阵覆盖(T0-T8)与派发消息要验的 5 件事基本一一对应(见 exploration.md 范围表)——但派发消息明确要求"独立复现"而不是只信任 PR 自带测试,所以 Implement 阶段除了跑这个文件本身,还要对①②做脱离测试脚本的手工验证。

## 4. 环境确认

```
$ which jq bash stat shellcheck
/usr/bin/jq                # jq-1.7.1-apple
/opt/homebrew/bin/bash      # GNU bash 5.3.9 (aarch64-apple-darwin24.6.0)
/usr/bin/stat               # BSD stat
/opt/homebrew/bin/shellcheck  # 0.11.0
```
本机具备跑测试套件 + shellcheck 复核的全部依赖,无需额外安装。

## 5. 生产状态(只读确认,未修改)

```
$ ls -la ~/.flywheel/discord-bot-pool/
drwx------ flywheel-pool-01 .. 06  (6 个 slot 目录,各 0700)
-rw------- pool.json (0600)
drwx------ staging
```
`jq '.slots[]|{slot,app_id,status,bot_user_id,invited_at}' pool.json` 显示 6 个 slot,`flywheel-pool-01`=`claimed-by-honey-lemon`,`flywheel-pool-02`=`claimed-by-anna`,其余 4 个 `unclaimed`,全部 `bot_user_id` 已回填、`invited_at` 均为 `null`(与 PR 描述的"claim 不等于 invite"一致)。**本次 QA 全程未修改此文件或任何 token**——上面这条命令是只读 `jq`/`ls`/`stat`,不涉及任何写操作。

## 6. 结论(供 plan.md 使用)

- HEAD 核实一致,CI 绿,可以继续走 QA。
- 42 测试断言是当前 HEAD 的真实数字,Implement 阶段应期望 "42 passed, 0 failed"(不是 PR body 文案里的 33)。
- 安全洞②必须在真机 macOS 上独立验证(CI 覆盖不到),本文档已做过一次最小化验证,Implement 阶段要在真实 CLI 路径下正式复现。
- 安全洞①的独立复现可以复用测试套件同款 stub-curl 手法,但要脱离测试脚本本身手工调用 CLI 一遍,不能只信任测试文件里的断言。
- 生产 pool.json 的当前状态可以作为"这条路径曾经真实工作过"的旁证,但不能替代这次独立复现。
