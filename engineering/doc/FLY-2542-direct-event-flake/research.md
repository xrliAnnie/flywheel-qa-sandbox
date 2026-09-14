# FLY-2542 DirectEventSink 时序隔离 — 调研
Issue: FLY-2542 (https://linear.app/geoforge3d/issue/FLY-2542/flake-directeventsinktestts1605-在-ci-teamlead-shard-3-间歇红9-14)
日期: 2026-09-14
基于: exploration.md

当前 emitStarted 在 finally 中 await Linear attempt/deadline，flush 只等待通知。前一用例启用 fake timers，启动含动态 import(@linear/sdk) 的任务后直接推进 15000ms；Promise.race 超时不等待底层 attempt。

实证：GitHub run 34800774965 attempt 2（FLY-2390），03:11:02.374 tail 用例日志出现上一超时 attempt 的 linear_start_aborted，03:11:02.887 出现 Authentication required；updateIssue mock 为 0。完整日志 /tmp/fly2542-red2390.log，获取命令：XDG_CACHE_HOME=/tmp/fly2542-gh-cache gh run view 34800774965 --attempt 2 --log-failed。

假设：fake timer 提前结束 timeout 用例，未结动态导入穿过测试边界，污染 Vitest mock 上下文。需要控制导入完成顺序先红后绿；不能把该假设或负载关联当已证明。onTaskUpdate 属 worker RPC，要另查原回执与安装代码，不扩大到全仓配置修复。

## 已完成的红绿对照

- 初始全文件 65/65，12.55s；原始 FLY-2293 用例组连续 20/20 exit 0（每次 8 个目标测试）。自然循环绿不能区分修复与安慰剂。
- scratch 第一个探针用 vi.spyOn 延迟 callFunctionMock，但 afterEach 提前恢复 spy，仅重现日志跨界，2/2 绿；这不是红侧证据。
- 改为进程内直接包装 callFunctionMock，延迟 750ms：`/tmp/fly2542-probe-red2.log` exit 1，timeout 通过，tail 原断言失败 `expected spy to be called once, but got 0 times`；同时记录 `FLY2542_UNMOCKED_LINEAR_SDK_BLOCKED`。guard 在 executor.directRequest 拒绝加载真实 SDK，不发网络请求。
- 相同探针添加 dynamicImportSettled：`/tmp/fly2542-probe-green.log` 仍 exit 1。否定最初一行方案。
- 等到 issue() mock 被调用后推进时钟：waitFor 对照 exit 0；最终标准库 Promise 信号版本 `/tmp/fly2542-probe-green3.log` exit 0，2/2，timeout 836ms、tail 803ms。最终方案无新的轮询超时，也没有修改任何原始断言。

因果链：vite-node 的 importer request 共用 callstack；Vitest requestWithMock 先 push mockPath 再 await callFunctionMock。在这一窗口第二个 import 看到 mockPath 已存在，跳过 mock，加载真实 SDK。超时 Promise.race 不等待 import，原 fixture 允许第二个用例进入窗口。issueRequested 由 SDK mock 内 resolve，因此 await 返回时 requestWithMock 已退出并清理 callstack，下一用例不能重叠这次导入。

## onTaskUpdate 调查

同一 CI run 34800774965：attempt 1 是 343 files / 4092 passed / 1 skipped，1 个 unhandled onTaskUpdate RPC timeout，551.29s；attempt 2 是 342 files passed / 1 failed，4091 passed / 1 failed / 1 skipped，439.33s，只有 SDK mock 失效，没有 onTaskUpdate。完整原回执分别 `/tmp/fly2542-rpc-red.log` 与 `/tmp/fly2542-red2390.log`。

获取：`XDG_CACHE_HOME=/tmp/fly2542-gh-cache gh run view 34800774965 --attempt 1 --log-failed`（attempt 2 同理）。Vitest 3.2.4 `rpc.-pEldfrD.js` 用 safe real timers 包装 worker RPC，`index.B521nVV-.js` 的 DEFAULT_TIMEOUT 为 60000ms；它不是本例的 15000ms fake deadline。更慢的 attempt 1 有 RPC 超时，与 shard 负载压力相容，但原日志没有 CPU/事件循环延迟指标，不能据此证明同因。本次只消除测试导入重叠，不声称修复 worker RPC 或修改其 timeout。

## 可重跑的受控证明

在仓库根目录把下面脚本保存到 `/tmp/fly2542-reproduce.py`，执行 `python3 /tmp/fly2542-reproduce.py`。需要先完成 frozen install 与 build。它创建两个临时包副本，红侧读取原始基线 14866f7e5，绿侧读取当前修复；测试选择器仅选择 timeout 与 tail 两条，没有添加 skip。750ms 是实验注入的重叠窗口，未写入修复。原 SDK 加载会在 directRequest 处抛错，红侧必须同时命中该护栏和原零调用断言；绿侧必须 exit 0。每次均为全新 Vitest 进程，探针只存在于 scratch。

```python
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path.cwd()
root = Path(tempfile.mkdtemp(prefix='fly2542-proof-'))
package = repo / 'packages/teamlead'
for mode in ('red', 'green'):
    dst = root / mode / 'packages/teamlead'
    shutil.copytree(package, dst, ignore=shutil.ignore_patterns('node_modules', 'dist', '.git'))
    for name in ('node_modules', 'dist'):
        (dst / name).symlink_to(package / name, target_is_directory=True)
    (dst.parent / 'config').symlink_to(repo / 'packages/config', target_is_directory=True)
    shutil.copyfile(repo / 'tsconfig.base.json', dst.parents[1] / 'tsconfig.base.json')
    path = 'packages/teamlead/src/__tests__/DirectEventSink.test.ts'
    source = (subprocess.check_output(['git', 'show', f'14866f7e5:{path}'], text=True)
              if mode == 'red' else (repo / path).read_text())
    source = source.replace('import type { EventEnvelope }',
        'import { setTimeout as realSetTimeout } from "node:timers";\nimport type { EventEnvelope }', 1)
    timeout = '\tit("times out without failing the already-running session", async () => {\n'
    source = source.replace(timeout, timeout + '''
        const mocker = (globalThis as any).__vitest_mocker__;
        const original = mocker.callFunctionMock.bind(mocker);
        mocker.callFunctionMock = async (...args: any[]) => {
            await new Promise((resolve) => realSetTimeout(resolve, 750));
            return original(...args);
        };
''')
    tail = '\tit("still notifies and starts exactly once when a post-upsert tail step throws", async () => {\n'
    source = source.replace(tail, tail + '''
        const executor = (globalThis as any).__vitest_mocker__.executor;
        const original = executor.directRequest.bind(executor);
        vi.spyOn(executor, "directRequest").mockImplementation((...args: any[]) => {
            if (String(args[0]).includes("linear/sdk") || String(args[0]).includes("@linear+sdk")) {
                throw new Error("FLY2542_UNMOCKED_LINEAR_SDK_BLOCKED");
            }
            return original(...args);
        });
''')
    (dst / 'src/__tests__/DirectEventSink.test.ts').write_text(source)
    log = root / f'{mode}.log'
    with log.open('w') as out:
        result = subprocess.run(['pnpm', '--filter', 'flywheel-teamlead', 'exec', 'vitest',
            'run', '--root', str(dst), 'src/__tests__/DirectEventSink.test.ts',
            '-t', 'times out without|post-upsert tail'], stdout=out, stderr=subprocess.STDOUT)
    print(f'{mode}: exit={result.returncode} log={log}', flush=True)
    text = log.read_text()
    if mode == 'red':
        assert result.returncode == 1
        assert 'FLY2542_UNMOCKED_LINEAR_SDK_BLOCKED' in text
        assert 'to be called once, but got 0 times' in text
    else:
        assert result.returncode == 0
        assert 'FLY2542_UNMOCKED_LINEAR_SDK_BLOCKED' not in text
```
