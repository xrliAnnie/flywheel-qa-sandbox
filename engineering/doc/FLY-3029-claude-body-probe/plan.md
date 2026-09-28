# FLY-3029 Claude 体探针 — 实施计划
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: research.md

## 目标
在指定 QA 沙箱的 README.md 末尾追加精确行 `FLY-2919 N-to-N claude-body probe`，提交推送并按实现节点的正常流程交卷。设计材料归本目录；实现有效载荷仅 README.md。

## 身份和结构
设计 execution：0ee9d075-5898-498e-90f4-bf2c53704fb8；run：ffeb71ea-d22d-4867-84c8-2242df6e2edb；节点 eng_design、attempt 1、TURN epoch 1。
上述身份仅记录本设计节点。后继阶段必须使用自己的注入身份，不复制设计 execution 或 activation。固定展示标签 `claude-body` 不决定运行厂商。
结构只有 README 原字节 + 一条 UTF-8 标记行；无新增业务模型、接口、数据库、迁移或配置。Git 提交是文件事实源；driver 回执是生命周期验收事实源，二者不能互相替代。

## 实施步骤（由后继 TURN 持有人执行）
- [ ] 运行自己环境中的 `node "$FLYWHEEL_COMM_CLI" turn`，只有 `yours` 才可写共享工作树；检查 inbox 和 progress，确认不是重复已完成的工作。
- [ ] 检查 `git remote get-url origin` 为 `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`，`git branch --show-current` 为派单沙箱分支，且 `git status --short` 无他人未提交改动。异常时报告 Lead，不切生产仓、不重置、不强推。
- [ ] 按 research.md 的选择方法重新发现相关测试。读取 README；若目标行不在，先运行下列只读断言，预期失败；若已唯一位于末尾，则核对 Git 历史后跳过追加，避免恢复时重复写入。

```sh
python3 - <<'PY'
from pathlib import Path
b = Path('README.md').read_bytes()
m = b'FLY-2919 N-to-N claude-body probe'
assert b.splitlines().count(m) == 1
assert b.endswith(m + b'\n')
PY
```

- [ ] 保存变更前 README 内容到内存，追加一次。以下片段也可在恢复后安全重跑，任何“已存在但位置/数量不对”均显式失败，交由 Lead 判断。

```sh
python3 - <<'PY'
from pathlib import Path
p = Path('README.md')
before = p.read_bytes()
marker = b'FLY-2919 N-to-N claude-body probe'
count = before.splitlines().count(marker)
if count:
    assert count == 1 and before.endswith(marker + b'\n'), 'Unexpected existing marker'
    print('Already appended; verify commit and push')
else:
    suffix = (b'' if not before or before.endswith(b'\n') else b'\n') + marker + b'\n'
    p.write_bytes(before + suffix)
    assert p.read_bytes() == before + suffix
PY
```

- [ ] 再运行只读断言，预期成功。检查 `git diff -- README.md` 仅增加指定行、旧标记和原空行未改；运行 `git diff --check` 与 `pnpm lint`。不新增为一行文案镜像实现的测试文件，不运行任何全包/全库测试。没有 TypeScript 或构建输入变化，无需 related/build/typecheck。
- [ ] 提交前检查 inbox；仅暂存 README.md，`git commit -m "docs: add FLY-2919 claude-body probe"`，普通 `git push -u origin HEAD`；不绕过 hooks、不改写历史。恢复场景若已提交则不空提交，只核对远端。
- [ ] 用 `git show --stat HEAD`、`git show HEAD:README.md` 和 `git ls-remote origin refs/heads/project-slot-2-FLY-3029` 证明内容与推送。按自己的实现节点提示完成 review/PR/结构化回报/交卷，不借用 design 完成命令，不自行派发后继、不合并、不部署。

## 失败与回退
推送失败保留本地提交并报告；非快进冲突需协调，不能强推。若需要撤销本探针，后续有权 TURN 持有人仅撤销追加行的独立提交；不 reset 共享分支、不撤销其他阶段成果。无需数据迁移或服务重启。

## 外层验收矩阵
| 要求 | 权威证据 | 责任 |
|---|---|---|
| README 单行追加并推送 | 文件字节、提交差异、远端 SHA 一致 | 实现/QA |
| 死体当场终结并换体 | driver receipt 及真实进程状态 | FLY-2919 QA |
| 活体丢窗口不判死 | 窗口缺失期间进程存活和恢复回执 | FLY-2919 QA |
| 同一 thread 续干 | 恢复前后相同 thread 身份、续跑记录 | FLY-2919 QA |
| 交卷回 thread | 完成事件与原 thread 投递回执 | FLY-2919 QA |
| 测试房精确头 bfdea677 | 外层 driver 的版本证明 | FLY-2919 QA |

设计审核必须读取以上范围，不能以 README 的成功代替整场 N-to-N 通过。当前沙箱 HEAD 与测试系统版本分属不同仓/层次，本设计未验证外层版本。

## 设计节点交付
本节点提交 exploration.md、research.md、plan.md、progress.md、design.html 和本地 Mermaid 源；本地渲染两次失败时按合同使用明确占位并报告，成功才包含 SVG。HTML 每节评论保存在按路径隔离的浏览器本地存储，汇总以 `【页面意见汇总】FLY-3029` 开头，复制失败有后备路径；所有交互集中在单个 nonce 脚本，零外部依赖，派生内容转义。
显式注册设计 review 并取得有效 APPROVED。提交推送最终 HTML 后 publish-report --publish-only，向实际 Lead 结构化报告链接；满足证据后 complete --route phase_design_complete，然后 park。设计完成不等于 issue 或 resident goal 终结。
