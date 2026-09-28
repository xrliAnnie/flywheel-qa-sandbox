# Code Review — FLY-2921 (Round 9, QA rework 3: tty installer harness race)

Status: APPROVED

审查对象：提交 `2b8ef4a7f`（父提交 `c01fd2b97` 只改 progress.md；再上一层 `72be5fc30` 是 QA 返工的 base）。
评审方式：`codex:rescue` 只读评审，xhigh；范围只有 `scripts/__tests__/test-claude-lead-session-start-adopt.test.sh`
内嵌 python harness 的这次改动。产品 diff 已由 R6/R7 批准，合并已由 R8 批准。

## 结论

无 BLOCKER / MAJOR / MINOR / NIT finding。

## 核对项

1. **根因**：读循环只有三个出口。`poll()` 非 None 时后面的 `poll()`/`wait()` 返回缓存的退出码，进不了旧的 timeout
   分支；30s deadline 解释不了 71ms；只剩 `OSError` break 后紧接着 `poll()` 仍为 None。Linux 在最后一个 slave
   关闭时唤醒 master reader，read 返回 `-EIO`（评审方引用了 `drivers/tty/pty.c` 和相关内核提交）。
   评审方的保留意见：harness 捕获的是任意 `OSError`、没有记录 errno，所以「就是 EIO」属于高可信推断，
   不是日志直接证明；但文件里没有别的地方能打出这条 `timed out` 文案，结合 Ubuntu runner、已捕获的成功行和
   71ms 时序，这是唯一有代码和平台证据支持的解释。
2. **修复**：正常退出时 `wait()` 立即返回；真挂死时剩余时间被夹到 `0.0`，`wait(0.0)` 对仍在运行的进程立即抛
   `TimeoutExpired`，杀进程组并回收；关 pty 后继续运行的子进程在剩余 deadline 后超时；非零退出码保留并照报。
   master fd 在每条路径都关闭，直接子进程在成功、非零、超时三条路径都被回收。`wait(timeout=0.0)` 会先做一次
   `waitpid(WNOHANG)`，已退出的子进程仍能正常返回（评审方在本机 CPython 上验证过）。新增的等待不会无限阻塞；
   SIGKILL 之后那次不带 timeout 的 `wait()` 是原有逻辑。
3. **写阻塞**：EIO 说明子进程这一侧最后一个 slave fd 已经关了，子进程不可能再阻塞在写 pty 上；就算出现别的
   `OSError`，最多到剩余 deadline 就被杀掉，harness 不会永久等待。
4. **断言强度**：没有变弱。保持 pty 打开并等输入仍在 30s 失败；先关 pty 再挂起也在 deadline 失败；非零退出仍失败；
   外层 shell 仍走 `bad` 分支。去掉的只是「slave 一关，子进程就必须已经能被回收」这个本不该有的约束。
5. **风格**：缩进、`TimeoutExpired` 处理、`max(0.0, deadline - monotonic())` 与仓库已有的 bounded-wait 写法一致
   （如 `scripts/lib/qa-lead-diagnostics.py:104`）。

## 评审方运行的命令（摘要）

`git show 2b8ef4a7f`、`git diff --check 2b8ef4a7f^ 2b8ef4a7f`、`git log --graph`、`git merge-base`、`nl -ba`/`rg` 读文件、
`bash -n`、用 `compile()` 检查内嵌 Python 语法、用本机 CPython 验证 `wait(timeout=0.0)` 在进程仍运行、已非零退出、
SIGKILL 回收三种情况下的行为。`gh run view 36292915296` 在评审沙箱里网络不通，未取到额外日志。
评审方没有跑完整测试脚本（只读沙箱不允许写临时文件，且本机 macOS 复现不了 Linux 的 master-read EIO），
本地测试证据见 implementation.md §9。评审方未做任何写操作。
