# FLY-3029 N-to-N Claude 体探针 — 调研

Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: exploration.md

## 0. 证据等级
- **[实测]** 本会话在本 worktree 里跑命令看到的事实
- **[读码]** 读 flywheel-comm dist / hook 源码得出
- **[先例]** 沙箱仓 git 历史 / merged PR

## 1. TL;DR
一行追加 + 一次 PR + 正常 approve→ship 交卷,零新机制。实施节点需要注意的只有三件事:**换行守卫、幂等守卫、不自行 merge**。设计节点(本节点)交付的完成证据是 `engineering/doc/FLY-3029-*/` 下的 HTML,`complete --route phase_design_complete` 会校验它。

## 2. 改动目标:README.md
- **[实测]** 现状 3 行:`\n\n FLY-1375 land E2E marker 20260722T023540Z\n`,末尾有换行(`git show e9a75dfed` 无 `\ No newline at end of file`)。
- **[先例]** README 三次同类追加:`#24`(FLY-124 "append Hi")、`#58`(FLY-1286)、`#64`(FLY-1375)。全部是 1 insertion、单文件、`docs(...)`/`test(...)` 前缀 commit,经 `:cool:` ship。
- **追加命令(幂等 + 换行安全)**:
  ```bash
  LINE='FLY-2919 N-to-N claude-body probe'
  [ -s README.md ] && [ "$(tail -c1 README.md | od -An -c | tr -d ' ')" != '\n' ] && printf '\n' >> README.md
  grep -qxF "$LINE" README.md || printf '%s\n' "$LINE" >> README.md
  ```
  `grep -qxF`:整行精确匹配(`-x`)、字面量(`-F`),已存在则不重复追加——这就是「同一 thread 续干 / 换体重跑」的幂等保证。

## 3. 分支与推送
- **[实测]** worktree = `/private/tmp/flywheel-test-slot-1/project-slot-1-FLY-3029`,分支 `project-slot-1-FLY-3029`,**尚无 upstream**(`git rev-parse @{u}` 报 no upstream)→ 首推需 `git push -u origin project-slot-1-FLY-3029`。
- **[实测]** `origin/main` = `1855f7a1a`,本分支基于同一提交,无需 sync main。
- **[读码]** `core.hooksPath` 指向 push-guard hooks(`/tmp/flywheel-test-slot-1/state/push-guard/...`),`extensions.worktreeConfig=true`。pre-push 守卫:非 fast-forward 需 Lead 确认 + `FLYWHEEL_FORCE_PUSH_ACK=<branch>`;**本任务只做 fast-forward 推送,不会触发**。禁 `--no-verify`、禁改 hooksPath。
- **[先例]** 分支名 `project-slot-<n>-FLY-<id>` 与 `#106`/`#136` 同形;PR 标题 `docs(FLY-3029): append FLY-2919 N-to-N claude-body probe to README`。

## 4. 交卷路由(flywheel-comm complete)
- **[读码]** `dist/commands/complete.js` 合法路由含 `needs_review`、`pr_handoff`、`no_code`、`phase_design_complete`、`blocked`。
  - **本设计节点**:`phase_design_complete` = no-code/no-merge 的阶段交接;**禁止**带 `--pr`/`--merged`(否则 exit 1);会收集 `findDesignHtmlPaths`——正则 `(^|/)doc/FLY-3029(?:-[^/]+)?/.*\.html`,即 HTML 必须在 `engineering/doc/FLY-3029-nton-claude-body/` 下。
  - **实施节点(Claude 体,有 transport)**:`needs_review --pr <n>`,并需 `--question-id`(approve gate 的问题 id)——即正常 approve→ship 环,不是 `pr_handoff`(那是无 transport 的 agy/kimi 体)。
- **[读码]** merge 授权:任何 merge 前 `verify-approval`;设计/实施节点都不自行 merge。

## 5. N-to-N 验收项与本任务的关系(边界诚实)
| 验收项 | 谁证明 | 本任务提供什么 |
|---|---|---|
| 死体当场终结并换体 | FLY-2919 driver receipt | 一个能被 kill 的真实 runner 负载 |
| 活体丢窗口不判死 | driver receipt + Bridge 心跳 | 同上 |
| 同一 thread 续干 | driver receipt / Discord thread | 幂等追加 → 新体续同一分支不产生冲突 |
| 交卷回 thread | Bridge 事件路由 | 正常 `complete` 路由,不绕过 |

**本任务不实现、不修改任何 N-to-N 机制**;只是被测负载。

## 6. 环境差异(已上报,非阻塞)
- **[实测]** `FLYWHEEL_PROJECT_NAME=test-slot-1`、Lead `flywheel-test-1`、Bridge `localhost:19871`;issue 文本写 slot 2 / `bfdea677`。ask `cc943bba` 已发,截至写本文件 `check` 返回 not yet。设计阶段零副作用,继续。

## 7. 风险
1. **新体重跑在旧体已 push 之后**:新体 `git pull --ff-only` 同分支即可续;幂等守卫保证不重复追加。
2. **README 被其他并发 QA 单同时改**:PR 冲突概率极低(追加末尾),真冲突时 merge `origin/main` 进本分支(技术同步无需 ship 授权)。
3. **Linear MCP 不可用**:无法核对 issue 最新评论;以派单文本为准。
