# FLY-891 Discord bot 池独立 QA 干跑验证 — QA 结果

Issue: FLY-891
日期: 2026-07-05
基于: plan.md

## qa-result: **PASS**

独立(非实现者)真机 dry-run 验证 FLY-882 / PR #452(Discord bot token 池)。
验的是 PR #452 HEAD `776af34b52c8f09541e3a16bff7ec7c95937b430`(执行前重新核实 `gh pr view 452 --json headRefOid` 仍是此 sha,CI `Build & Test` = SUCCESS)。全程只读/dry-run,未真建 bot、未写生产 token、未触发任何重启。

在独立 detached git worktree(`/var/folders/.../fly891-qa-fly882-*`,checkout 776af34b)里跑 PR 代码,不碰 `flywheel-FLY-891` 工作区;所有 CLI 调用经 `DISCORD_BOT_POOL_HOME` 指向临时沙箱,不碰生产 `~/.flywheel/discord-bot-pool/`。

## 前置 / 后置基线(生产 pool.json 零改动的客观证据)

| | stat `%m %z %Lp` | sha256 |
|---|---|---|
| Before(步骤 1) | `1783237970 2018 600` | `7916b03b…dd3ff5f` |
| After(步骤 7) | `1783237970 2018 600` | `7916b03b…dd3ff5f` |

**逐字相同** —— mtime / size / mode / 内容哈希全部未变,直接证明生产 `pool.json` 本身未被改动。生产各 slot 的 **token 文件**未被触碰,则由过程纪律佐证(而非由这个 pool.json 哈希直接证明):所有 CLI 调用一律经 `DISCORD_BOT_POOL_HOME` 指向临时沙箱,全程从未以生产池目录为 `DISCORD_BOT_POOL_HOME`,对生产 token 文件既无读也无写路径。

## 逐步结果

### 步骤 A — 独立复现自带测试套件(42 测)· PASS
```
bash scripts/__tests__/discord-bot-pool.test.sh
→ Results: 42 passed, 0 failed   (退出码 0)
```
全部 T0-T8 断言绿,含关键项:T3a2(bot_user_id 回填)、T3f/T3g(token 经 `-K -` stdin 送认证、绝不进 curl argv)、T4c/T4d/T4e(注册后 token 权限漂移/篡改/非法字符被拒读)、T6e/T6f(并发 claim / add-slot 竞态各只一个赢家,pool.json 一致)、T1e-T1i(路径穿越 slot 名 / 过短 token / 非 token 字母表校验)。
断言数核实:测试文件 `pass` 调用 = 42(PR body 文案里的 "33/33" 是 Codex round 2/3 追加测试后未同步的旧数字,42 才是当前 HEAD 真实数)。

### 步骤 B — 安全洞①(bot_user_id 回填)脱离测试脚本手工复现 · PASS
全新沙箱 + 独立最小 stub curl(要求真收到 `-K -` 且 stdin 含 `Authorization: Bot` 头才返 200,否则 401 —— 避免"验证脚本验证同一份 fixture"的循环论证):
```
slot 目录权限:               700          (期望 700)
回填前 bot_user_id:          []（空字符串）(期望空)
verify qa-sec1-slot:         OK (qa-sec1-bot)  rc=0
回填后 bot_user_id:          QA-SEC1-424242    (期望 == stub 返回的 id)
```
`verify` 返回 200 且回填成功,证明真实脚本确实经 `-K` stdin 送认证(否则 stub 返 401、verify 失败)。回填只在 `bot_user_id` 当前为空时发生。

### 步骤 C — 安全洞②(macOS `stat -f/-c` 跨平台分支)· PASS
CI 只在 ubuntu-latest 跑,GNU `stat -c` 永远成功,`|| stat -f` fallback 分支在 CI 从未执行到 —— 这是本次真机 macOS(BSD stat)独立验证的核心理由。

**C1 函数级**(source lib 调 `_pool_file_mode`,机械化重定向验证):
```
uname: Darwin ... RELEASE_ARM64_T6050    (macOS / BSD stat)
stat -c stdout 字节数:  0                 (期望 0 —— 干净失败,无 stdout 污染)
stat -c exit code:      1                 (非 0)
stat -c stderr:         stat: illegal option -- c ...  (非空,仅写 stderr)
_pool_file_mode 结果:   600               (恰好三位,证明落到 -f fallback)
```
反证:GNU stat 在 Linux 上 `stat -f '%Lp'` 会把文件系统信息喷到 stdout(这正是 commit `e7dcf216` 修的顺序 bug 的成因);BSD stat 的 `-c` 失败是"干净"的,`||` 能正确接上 `-f`。

**C2 CLI 触发路径级**(`add-slot` 用故意错误权限 644 触发自愈 + `_pool_file_mode` 复核):
```
token before add-slot:  644
add-slot:               registered  rc=0
token after add-slot:   600         (被自动 chmod 600 + _pool_file_mode 复核通过)
```
rc=0 说明真实 CLI 路径里 `_pool_file_mode` 正确走到 macOS `-f` fallback 分支(否则会打印 "could not enforce 600" 并非零退出)。

### 步骤 D — 权限断言(init 池目录 700 / pool.json 600)· PASS
```
pool dir mode:    700   (期望 700)
pool.json mode:   600   (期望 600)
```
(slot 目录 700 已在步骤 B 验;token 文件 600 已在步骤 C2 验。)

### 步骤 E — shellcheck 独立复核 · PASS
```
shellcheck scripts/discord-bot-pool.sh scripts/lib/discord-bot-pool-lib.sh scripts/__tests__/discord-bot-pool.test.sh
→ 无输出,退出码 0(clean)   [ShellCheck 0.11.0]
```

### 步骤 7 — 清理 · PASS
QA detached worktree 已 `git worktree remove --force`,`git worktree list` 确认消失,无遗留临时 worktree / sandbox。(列表中 `flywheel-FLY-882 @ 776af34b` 是实现者自己的独立 worktree,非本次 QA 创建。)

## 结论

FLY-882 / PR #452 的建/验/认领脚本逻辑、两个安全洞修复(bot_user_id 回填、macOS `stat -f/-c` 跨平台分支)、权限强制点(0600 token / 0700 目录)在真机 macOS 上全部独立复现通过,42 测独立复跑全绿,shellcheck clean,生产 pool.json 零改动。

**建议:进入 FLY-882 的 Tier-3 ship 批次候选。**

## 边界(本次未做,符合派发红线)
- 未真建 Discord Application / 未发起真实 Discord API 网络调用(生产 6 slot 已人工验活,不在"验脚本逻辑"范围)
- 未修改任何 FLY-882 代码(即便发现可简化处也只记录不动手)
- 未修改/清理生产 pool.json 或任何 token;未触发 Bridge/Lead 重启
