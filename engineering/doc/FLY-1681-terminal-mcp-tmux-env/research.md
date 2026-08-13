# FLY-1681 terminal-mcp 剥离 TMUX env — 调研

Issue: FLY-1681 (https://linear.app/geoforge3d/issue/FLY-1681/flywheel-terminal-mcp-从-v2-lead-座位探测-runner-全假阴性-tmux-客户端命中私有-server)
日期: 2026-08-12
基于: exploration.md

## 1. 改动面精确清单

`packages/terminal-mcp/src/index.ts` 里全部 4 个 tmux 子进程位点(也是整个包、乃至 Lead 侧 MCP 面上仅有的 tmux 位点;inbox-mcp 零 tmux):

| 位点 | 行为 | 使用者 | timeout |
|---|---|---|---|
| `tmuxCapture()` → `capture-pane -t <target> -p -S -N` | 读屏 | capture / search / status | 5000ms |
| `tmuxAlive()` → `list-panes -t <target>` | 探活 | list / status / input | 3000ms |
| `send-keys -t <target> -l <text>` | 写入 | input | 5000ms |
| `send-keys -t <target> Enter` | 写入 | input | 5000ms |

所有位点都走同一个 `execFileAsync("tmux", [...])`,env 未显式传 ⇒ 继承 `process.env`(含私有 `TMUX`)。所有位点都带显式 `-t`(⇒ `TMUX_PANE` 目前 inert,但剥掉更卫生:任何未来无 `-t` 的调用会拿它默认到一个错误命名空间里的 pane)。

## 2. tmux 客户端 socket 解析规则(fix 依赖的语义)

优先级:`-S <path>` > `-L <name>`(在 socket dir 下)> `$TMUX` 第一段(已设且非空时)> 默认 `$TMUX_TMPDIR|/tmp` + `tmux-<uid>/default`。

⇒ **删掉 child env 里的 `TMUX` 键 = 让 tmux 自己走默认解析**,与已验证 48h+ 的 workaround `TMUX= tmux ...` 语义一致(shell 的 `TMUX=` 置空串,tmux 对空串同样回落默认;Node 里删键更干净,无空串歧义)。`TMUX_TMPDIR` **保留不动**:它是"默认 server 在哪"的合法转向器(测试沙箱正要用它),剥掉反而破坏语义。

## 3. repo 内三个既有惯例(方案对齐)

1. **纯函数 + 注入依赖的单测惯例**:`lifecycle.ts` 自述 "pure, unit-testable helpers",`mapWithConcurrency` 等纯函数配 `lifecycle.test.ts`;`scope.test.ts` 用真 CommDB tmp 文件。⇒ 新增 `sanitizeTmuxEnv()`(纯)+ `execTmux()`(注入 execFile fn)完全贴合。
2. **real-tmux 补位测试惯例**(FLY-169/FLY-172 教训:mock 会把对 tmux 行为的错误假设固化):`tmux-lookup.real-tmux.test.ts` / `scaffold-prune.real-tmux.test.ts`,`tmux` 不可用时 `describe.skip` 保 CI 绿。⇒ 本单的 RED/GREEN 复现测试沿用此形态。
3. **显式 `-S` 的先例边界**:claude-runner `tmuxDefaultSocketPath()`(`TMUX_TMPDIR|/tmp` + `tmux-<uid>/default`)存在,但那是**跨进程 rescue CLI 必须把 socket 当参数传**才有的;terminal-mcp 进程内自用没有这个约束,复刻推导属于重复造轮子且多一处要跟 tmux 语义对齐的逻辑。

## 4. RED 测试设计(真实复现 bug,不碰 host 默认 server)

关键技巧:用 `TMUX_TMPDIR=<tmpdir>` 把测试的"默认 server"整个搬进临时目录——两个 server 都是测试私产,host 默认 server 零接触(memory 教训:隔离不能悄悄改掉被测语义——这里隔离恰恰用的是被测代码**保留** `TMUX_TMPDIR` 的语义本身,GREEN 断言同时覆盖了"只剥 TMUX 不剥 TMUX_TMPDIR")。

```
T = mkdtemp()
"默认" server:env TMUX_TMPDIR=T 起 session runner-test(socket = T/tmux-<uid>/default)
私有 server:tmux -S T/private.sock new-session -d(模拟 fw-*.sock)
座位 env:{ TMUX_TMPDIR: T, TMUX: "T/private.sock,<pid>,0", TMUX_PANE: "%0" }

RED(裸 exec,带座位 env):list-panes -t runner-test → 失败(命中私有 server)   ← 复现 bug
GREEN(execTmux,同座位 env 为 base):list-panes -t runner-test → 成功(回落 T 默认) ← 修复生效
teardown:kill 两个 server + rm -rf T
```

RED 分支同时是"探针自证"(阳性对照的对照):证明这套沙箱真的能重现假阴性,GREEN 才有意义。

## 5. 「想查私有 server 的调用」终审(exploration §4 的补强)

- CommDB `sessions.tmux_window` 实测形态 `runner-flywheel:@649`(含本 runner 自己的行)——**无 socket 维度**,schema 结构上只能描述一个命名空间。
- 全部写入方(claude-runner TmuxAdapter + Codex/Antigravity/Kimi adapter)从 Bridge(launchd 起,无 TMUX env)spawn 到默认 server;rescue 路径显式 `-S` 默认 socket。
- 结论:**不存在**依赖"terminal-mcp 继承座位 TMUX"才正确的调用。今天恰恰相反:继承即失明(13/13 生产进程实锤)。

## 6. 生效与部署链

- terminal-mcp 由 claude-lead.sh 注册为 stdio MCP(`dist/index.js`),随 Lead 的 claude session spawn、常驻同生命周期。
- 生效条件 = ① merge 进 main ② 生产 `git pull` + `pnpm -r build`(部署车/updater 既有流程,产出新 dist)③ 各 Lead 的 claude session 重启(全舰重启车即覆盖)。**无需 Bridge 改动/重启**。
- 已在跑的 Lead session 旧 MCP 进程不自愈——验收必须在**部署+重启后**的真 v2 Lead 座位上做,不能拿部署前座位假验。

## 7. 防回归

风险:未来往 index.ts 加第 5 个 tmux 位点时忘走 `execTmux` ⇒ bug 复活且症状隐蔽(只在 v2 座位显形)。
对策:包内静态守卫测试——断言 `index.ts` 源码零裸 `execFileAsync("tmux"` / `spawn("tmux"`(tmux 只许出现在 `tmux-exec.ts`)。与 repo 守卫测试文化一致(FLY-880 contract test / FLY-1631 residue guard),成本一个 it()。

## 8. 结论

方案 A(exec 边界统一剥 `TMUX`+`TMUX_PANE`,单一 `execTmux` 收口)成立:
- 与地面真相 workaround 字节等价;
- 零新配置、零新探测层、零 socket 推导(方案 B 的复刻逻辑、方案 C 的启动器补丁均否);
- 测试三层齐:纯函数单测 + real-tmux RED/GREEN 复现 + 静态守卫。
