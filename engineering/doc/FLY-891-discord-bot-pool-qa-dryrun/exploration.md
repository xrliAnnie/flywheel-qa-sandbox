# FLY-891 Discord bot 池独立 QA 干跑验证 — 探索

Issue: FLY-891 (https://linear.app/geoforge3d/issue/FLY-891/qa-fly-882-discord-bot-池真机-dry-run-重跑-建验认领-2-安全洞验证)
日期: 2026-07-05
基于: 无

## 1. 这个 issue 实际是什么

FLY-891 本身就是一个「QA 任务」—— 独立(非实现者)验证 FLY-882(Discord bot token 池,PR #452,HEAD `776af34b`)。因为项目已对 flywheel 自身启用 three_stage pipeline(FLY-793,PR #446),这个 QA 任务本身也要走 Design → Implement → QA 三段。本文档所在的 **Design 阶段** 不执行任何验证动作,只做:

1. 读懂 FLY-882 改了什么、为什么改、风险点在哪(brainstorm + research)
2. 把「怎么验」写成一份 Implement 阶段可以直接照着执行的干跑(dry-run)计划(plan)

真正跑测试/跑 CLI dry-run 的动作留给 **Implement 阶段**(同一分支上的下一个 agent)。

## 2. 已知信息(来自派发消息)

- 验证目标:PR #452(`flywheel-FLY-882` → `main`),HEAD `776af34b`,CI 绿,Codex 5 轮 APPROVED
- 要验 5 件事:
  1. 建/验/认领脚本正确性(registry 读写、slot 状态机、认领逻辑)
  2. 安全洞①:`verify` 验活成功时把 bot id 正确回填进 `pool.json` 的 `bot_user_id`
  3. 安全洞②:Codex round 4 修的 `stat -f/-c` 跨平台分支,在 macOS(`-f`)下正确取文件权限/mtime
  4. 权限:token 文件 0600、目录 0700
  5. 独立复现 PR 自带的 `scripts/__tests__/discord-bot-pool.test.sh`(42 测,PR body 写的"33/33"是旧数字,是 Codex round 2/3 又加了 T1e-T1i/T6e/T6f 等测试后没更新文案)
- 红线:只读/dry-run,绝不真建 bot、不写生产 token、不触发任何重启;这是验**脚本逻辑**,不是验真 Discord API(bot 已在生产验活过)

## 3. 假设(显式列出,供 Lead 确认)

1. **"Design 阶段"在这里 = 为 Implement 阶段写出可执行的干跑验证计划**,不是去发明一个新功能的设计。FLY-891 没有代码要写,产出是"如何验"的方案,而不是"如何实现"的方案。
2. Implement 阶段会在**独立于生产 `~/.flywheel/discord-bot-pool/` 的沙箱目录**里跑 PR #452 的脚本(通过 `DISCORD_BOT_POOL_HOME` 环境变量覆盖),不会碰生产 pool.json(里面已有 6 个真实 slot,2 个已认领——honey-lemon / anna)。
3. Implement 阶段验证的是 **`origin/flywheel-FLY-882` @ `776af34b`** 这个具体 commit 的代码(不是本地 `flywheel-FLY-891` 分支上的文件——这些脚本目前根本不在这条分支上),通过临时 git worktree 或等价手段读取,不切换 `flywheel-FLY-891` 分支本身的工作区(设计文档要留在这条分支上)。
4. "42 测全过" + "手工独立复现安全洞①②" 是两条独立证据链——不能只跑测试脚本就算数(测试是 PR 作者自己写的,QA 要有一部分独立验证,尤其是 CI 从不跑到的 macOS `stat -f` 分支,因为 CI 只在 `ubuntu-latest` 上跑,`stat -c` 那条分支永远不会失败去触发 `-f` fallback)。
5. 不需要真实 Discord bot token 或网络访问——PR 自带的 hermetic 测试用一个 stub curl(基于 Authorization token 内容返回 200/401),完全离线可跑;安全洞①②的独立复现也可以复用同样的 stub 手法,不需要打真实 Discord API。
6. QA 结论只需要 pass/fail + 证据,不需要修代码——如果发现问题,路由回实现者(runner)修复后复验,而不是本阶段/Implement 阶段直接改 FLY-882 的代码(那是另一个 issue 的范围)。

## 4. 范围边界

**In scope**(Implement 阶段要做的):
- 独立跑一遍 `scripts/__tests__/discord-bot-pool.test.sh`(42 测)在干净沙箱里
- 独立、脱离测试脚本、手工验证安全洞①(bot_user_id 回填)和②(macOS stat 分支)
- 检查 token 文件 0600 / 池目录 0700 的强制点
- 独立跑 shellcheck 复核 PR 声称的"3 个文件 shellcheck clean"
- 产出 qa-result(pass/fail + 证据)

**Out of scope**(不做):
- 真实建 Discord Application / 真实 bot 网络调用(生产已经人工验过)
- 修改/清理生产 `~/.flywheel/discord-bot-pool/pool.json` 或任何 token
- 触发 Bridge/Lead 重启
- 审查 `.claude/commands/setup-discord-lead.md` 或 claim-guide 文档内容本身的产品/文案质量(那是 FLY-882 的实现范围,不是这次 QA 的验证目标——除非发现它与脚本实际行为不符)

## 5. 风险 / 待办

- 这台机器(Darwin 25.3.0, `stat` = BSD stat,无 `-c`)天然就是验证安全洞②的正确环境——已在 research 阶段做了一次最小化验证(见 research.md),Implement 阶段要在真实脚本路径下重新走一遍完整流程作为正式证据,不能只依赖本文档里的探索性验证。
- worktree/checkout FLY-882 分支的动作会引入这条分支之外的文件——必须确认这些临时文件不会被 commit 进 `flywheel-FLY-891` 分支(通过独立 worktree 目录隔离,不放进本仓库工作树)。
