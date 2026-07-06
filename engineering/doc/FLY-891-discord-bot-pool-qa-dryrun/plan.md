# FLY-891 Discord bot 池独立 QA 干跑验证 — 实施计划

Version: v1.0
Issue: FLY-891
日期: 2026-07-05
Source: exploration.md, research.md
Status: codex-approved (2 rounds)

## 0. 前提 / 红线(每一步都要遵守)

- **只读/dry-run**:全程不得对生产 `~/.flywheel/discord-bot-pool/`(pool.json 或任何 `<slot>/token`)做任何写操作。所有 CLI 调用必须显式设置 `DISCORD_BOT_POOL_HOME` 指向一个新建的临时沙箱目录。
- **不打真实 Discord API**:所有 `verify` / `rename` / `invite-url` 相关的调用要么走 PR 自带的 hermetic 测试(内置 stub curl),要么用本计划里另建的独立 stub curl——不使用任何真实 token、不发起真实网络请求。
- **不触发重启**:这次验证是纯 shell 脚本 + 本地文件系统行为,不涉及 Bridge/Lead/服务重启,全程不需要。
- **验的是 PR #452 HEAD `776af34b`**:执行前必须重新核实 `gh pr view 452 --json headRefOid` 仍是这个 sha(如果实现者中途 push 了新 commit,要先跟 team-lead 确认验的是哪个 head,不能用旧证据给新 head 盖章通过——[[reference_qa_fetch_head_before_pass]])。
- **不切换 `flywheel-FLY-891` 分支的工作区**:PR #452 的文件不在这条分支上。用独立 git worktree(或等价隔离手段)在别处 checkout `origin/flywheel-FLY-882@776af34b`,不要在本仓库当前工作树里 `git checkout` 切分支或 `git merge`/`cherry-pick` 那些文件进来。

## 1. 环境准备

```bash
cd /Users/xiaorongli/Dev/flywheel-FLY-891   # 或对应 worktree
gh pr view 452 --json headRefOid,state,mergeable,statusCheckRollup   # 确认仍是 776af34b + CI 绿
git fetch origin flywheel-FLY-882
```

建一个独立、与本分支工作区无关的临时目录来跑 PR 代码(不要污染当前分支):

```bash
QA_WT="$(mktemp -d -t fly891-qa-fly882-XXXXXX)"
git worktree add --detach "$QA_WT" 776af34b52c8f09541e3a16bff7ec7c95937b430
cd "$QA_WT"
git rev-parse HEAD   # 断言 == 776af34b52c8f09541e3a16bff7ec7c95937b430
```

完成后(第 7 步)记得 `git worktree remove "$QA_WT"` 清理,不留垃圾 worktree。

**生产 pool.json 前置基线(Codex round 1 finding #3)**:在碰任何 CLI 命令之前,先给生产
`~/.flywheel/discord-bot-pool/pool.json` 拍一个只读的 metadata 快照,作为第 7 步"确认生产
状态没被动过"的客观对照——不能只在最后凭印象说"应该没变":

```bash
stat -f '%m %z %Lp' ~/.flywheel/discord-bot-pool/pool.json   # mtime epoch / size / mode
shasum -a 256 ~/.flywheel/discord-bot-pool/pool.json          # 内容哈希(只读,不碰任何 token 文件)
```
把这行输出原样记下来,第 7 步清理时要重新跑一遍同样的命令并逐字比对。

## 2. 步骤 A — 独立复现自带测试套件(42 测)

```bash
bash scripts/__tests__/discord-bot-pool.test.sh
```

**期望**:退出码 0,末尾输出 `Results: 42 passed, 0 failed`。

如果数字不是 42/0 或退出码非 0 → 记录完整输出,列为 FAIL 项之一,不要自行调试/修代码(那是实现者的工作,QA 只报告)。

## 3. 步骤 B — 独立、脱离测试脚本手工验证安全洞①(bot_user_id 回填)

目的:不满足于"测试文件里断言过",要在一个全新沙箱里,脱离测试框架,直接调用真实 CLI 走一遍这条路径,亲眼确认 `pool.json` 前后差异。

```bash
SANDBOX_B="$(mktemp -d -t fly891-secB-XXXXXX)"
export DISCORD_BOT_POOL_HOME="$SANDBOX_B/pool"

# 独立最小 stub curl(不复用测试文件里的那份,避免"验证脚本验证同一份 fixture"的循环论证)。
# Codex round 1 finding #2:必须真的要求 -K - + 从 stdin 读 Authorization 头,否则这个 stub
# 对任何调用都返回 200,根本没有验证 _pool_curl_authed 真的把 token 送过去了。
STUBBIN="$SANDBOX_B/stubbin"; mkdir -p "$STUBBIN"
cat > "$STUBBIN/curl" <<'EOF'
#!/bin/bash
# 忠实 stub:只有真的收到 `-K -` 并且 stdin 里有 `header = "Authorization: Bot ..."` 才算认证
# 请求,否则直接判 401——这才是在验证 _pool_curl_authed 的 -K stdin 认证路径真的被触发了,
# 而不是随便什么调用都放行。
out=""; saw_stdin_cfg=0; args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    -o) i=$((i+1)); out="${args[$i]}" ;;
    -K) i=$((i+1)); [ "${args[$i]}" = "-" ] && saw_stdin_cfg=1 ;;
  esac
  i=$((i+1))
done
token=""
if [ "$saw_stdin_cfg" = "1" ]; then
  while IFS= read -r line; do
    case "$line" in
      'header = "Authorization: Bot '*)
        token="${line#header = \"Authorization: Bot }"; token="${token%\"}" ;;
    esac
  done
fi
if [ -n "$token" ]; then
  [ -n "$out" ] && printf '{"id":"QA-SEC1-424242","username":"qa-sec1-bot"}' > "$out"
  printf '200'
else
  [ -n "$out" ] && printf '{"message":"401: no -K stdin Authorization header seen"}' > "$out"
  printf '401'
fi
EOF
chmod +x "$STUBBIN/curl"
export PATH="$STUBBIN:$PATH"

bash scripts/discord-bot-pool.sh init
mkdir -p "$DISCORD_BOT_POOL_HOME/qa-sec1-slot"
echo "QASEC1TOKEN.$(head -c 50 </dev/zero | tr '\0' 'a')" > "$DISCORD_BOT_POOL_HOME/qa-sec1-slot/token"
chmod 600 "$DISCORD_BOT_POOL_HOME/qa-sec1-slot/token"
bash scripts/discord-bot-pool.sh add-slot qa-sec1-slot qa-sec1-app ""

echo "--- slot 目录权限 (Codex round 1 finding #1 — 期望 700) ---"
stat -f '%Lp' "$DISCORD_BOT_POOL_HOME/qa-sec1-slot"

echo "--- 回填前 bot_user_id (期望是空字符串) ---"
jq -r '.slots[] | select(.slot=="qa-sec1-slot") | .bot_user_id' "$DISCORD_BOT_POOL_HOME/pool.json"

bash scripts/discord-bot-pool.sh verify qa-sec1-slot

echo "--- 回填后 bot_user_id (期望 == QA-SEC1-424242) ---"
jq -r '.slots[] | select(.slot=="qa-sec1-slot") | .bot_user_id' "$DISCORD_BOT_POOL_HOME/pool.json"
```

**期望**:`verify` 命令输出包含 `OK (qa-sec1-bot)`;slot 目录权限为 `700`;回填前 `bot_user_id` 为空字符串,回填后变成 `QA-SEC1-424242`。如果 `verify` 返回 401/FAIL,说明 stub 没收到 `-K -` 认证请求——这本身就是需要上报的发现(意味着真实脚本没有按预期路径发送认证),不是 stub 写错了就能糊弄过去的。

清理:`rm -rf "$SANDBOX_B"`;`unset DISCORD_BOT_POOL_HOME`。

## 4. 步骤 C — 独立验证安全洞②(macOS `stat -f/-c` 分支)

两层验证(函数级 + 真实 CLI 触发路径级),都要做:

### C1. 函数级(直接 source lib,调用 `_pool_file_mode`)

Codex round 1 finding #4:这一步要机械化地证明"`stat -c` 在 stdout 上没有任何输出",而不是
看终端合并输出凭感觉判断;而且脚本本身是 bash 语法(`local`/`[[`/数组),交互 shell 在这台
机器默认是 zsh,必须显式用 `bash -c` 或写成临时脚本用 `bash` 执行,不能依赖当前 shell 恰好是
bash。

```bash
SANDBOX_C="$(mktemp -d -t fly891-secC-XXXXXX)"
touch "$SANDBOX_C/permtest"; chmod 600 "$SANDBOX_C/permtest"

bash <<BASHEOF
set -u
source scripts/lib/discord-bot-pool-lib.sh
echo "uname: \$(uname -a)"

stat -c '%a' "$SANDBOX_C/permtest" >"$SANDBOX_C/statc.out" 2>"$SANDBOX_C/statc.err"
statc_rc=\$?
echo "stat -c stdout 字节数(期望 0): \$(wc -c < "$SANDBOX_C/statc.out" | tr -d ' ')"
echo "stat -c exit code(期望非 0): \$statc_rc"
echo "stat -c stderr 内容(仅供参考,应非空):"; cat "$SANDBOX_C/statc.err"

echo "_pool_file_mode 组合结果(期望恰好 600,证明确实落到了 -f fallback):"
_pool_file_mode "$SANDBOX_C/permtest"; echo ""
BASHEOF

rm -rf "$SANDBOX_C"
```

**期望**:`stat -c` 单独调用退出码非 0、**stdout 字节数为 0**(重定向到独立文件机械验证,不靠肉眼看终端合并输出)、stderr 非空(不能有一大段文件系统信息泄漏到 stdout——这正是 GNU stat 在 Linux 上会犯的错,反证 BSD stat 在 macOS 上是"干净失败");`_pool_file_mode` 组合表达式最终吐出恰好 `600`(不多不少,不能是 `600\n700` 之类的多行输出)。

### C2. CLI 触发路径级(通过真实 `add-slot` 命令间接触发 `_pool_file_mode` 的自检逻辑)

```bash
SANDBOX_C2="$(mktemp -d -t fly891-secC2-XXXXXX)"
export DISCORD_BOT_POOL_HOME="$SANDBOX_C2/pool"
mkdir -p "$DISCORD_BOT_POOL_HOME/qa-sec2-slot"
echo "QASEC2TOKEN.$(head -c 50 </dev/zero | tr '\0' 'a')" > "$DISCORD_BOT_POOL_HOME/qa-sec2-slot/token"
chmod 644 "$DISCORD_BOT_POOL_HOME/qa-sec2-slot/token"   # 故意用错误权限,验证 add-slot 的自愈 + 复核路径
bash scripts/discord-bot-pool.sh add-slot qa-sec2-slot qa-sec2-app ""
stat -f '%Lp' "$DISCORD_BOT_POOL_HOME/qa-sec2-slot/token"   # 期望 600（add-slot 内部会 chmod 600 后用 _pool_file_mode 复核)
unset DISCORD_BOT_POOL_HOME
rm -rf "$SANDBOX_C2"
```

**期望**:命令成功(rc=0),token 文件被 `add-slot` 自动 `chmod 600`,且脚本内部 `_pool_file_mode` 复核通过(否则 `add-slot` 会打印 "could not enforce 600" 并以非零退出——如果这里失败,说明 `_pool_file_mode` 在真实调用路径里没有走到预期的 macOS fallback 分支,是需要上报的真发现,不是环境问题)。

## 5. 步骤 D — 权限断言(0600 / 0700)独立复核

```bash
SANDBOX_D="$(mktemp -d -t fly891-secD-XXXXXX)"
export DISCORD_BOT_POOL_HOME="$SANDBOX_D/pool"
bash scripts/discord-bot-pool.sh init
stat -f '%Lp' "$DISCORD_BOT_POOL_HOME"              # 期望 700
stat -f '%Lp' "$DISCORD_BOT_POOL_HOME/pool.json"    # 期望 600
unset DISCORD_BOT_POOL_HOME
rm -rf "$SANDBOX_D"
```

(步骤 B 已验 slot 目录 700;步骤 C2 已验 token 文件 600。这里只需单独确认 `init` 本身建的池目录/pool.json 权限。)

## 6. 步骤 E — shellcheck 独立复核

```bash
shellcheck scripts/discord-bot-pool.sh scripts/lib/discord-bot-pool-lib.sh scripts/__tests__/discord-bot-pool.test.sh
```

**期望**:无输出(clean),退出码 0。

## 7. 清理

```bash
cd /Users/xiaorongli/Dev/flywheel-FLY-891
git worktree remove "$QA_WT" --force   # 若步骤中有未清理的临时文件残留才需要 --force
git worktree list   # 确认 QA_WT 已消失,没有遗留 worktree
```

**生产 pool.json 前后基线比对(Codex round 1 finding #3 — 客观证据,不是凭印象)**:重新跑一遍第 1
步记录过的同一条命令,逐字比对输出与开头的基线完全一致:

```bash
stat -f '%m %z %Lp' ~/.flywheel/discord-bot-pool/pool.json
shasum -a 256 ~/.flywheel/discord-bot-pool/pool.json
```

确认:
- 上面这行 `stat`/`shasum` 输出与第 1 步记录的前置基线**逐字相同**(mtime/size/mode/哈希都不能变)——这是"生产状态没被动过"的客观证据,而不是"全程只碰了 sandbox,应该没事"的印象判断
- 没有遗留的 `$SANDBOX_*` / `$QA_WT` 临时目录

## 8. 产出

按派发消息要求的格式给 team-lead(Tadashi):

- **qa-result: pass / fail**
- 每一步(A-E)的实际输出摘要作为证据(尤其是步骤 A 的 "42 passed, 0 failed" 那一行、步骤 B 的 slot 目录 700 + 回填前后对比、步骤 C1 的 `stat -c` stdout=0 字节 + `_pool_file_mode` 落到 600 的输出、步骤 7 的生产 pool.json 前后 stat/shasum 比对)
- 如果任何一步 FAIL:列出具体命令 + 实际输出 + 期望输出的差异,不要自行修复代码,路由回实现 runner
- 如果全部 PASS:报告 team-lead,进入 FLY-882 的 Tier-3 ship 批次候选

## 9. 本计划不做的事(明确排除)

- 不修改 FLY-882 的任何代码(即便发现拼写错误或可以简化的地方,只记录、不动手——那是另一个 issue 的范围)
- 不评审 `doc/reference/discord-bot-pool-claim-guide.md` 或 `.claude/commands/setup-discord-lead.md` 的文案质量(除非文案与脚本实际行为矛盾)
- 不重新验证"6 个生产 slot 都真实存在且 verify 通过"——PR body 已声明这是人工完成的真实结果,不在这次"验脚本逻辑"的范围内
