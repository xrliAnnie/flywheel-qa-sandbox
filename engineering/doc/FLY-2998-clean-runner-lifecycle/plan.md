# FLY-2998 干净房间执行流程 — 实施计划
Issue: FLY-2998 (https://linear.app/geoforge3d/issue/FLY-2998/qa-sbx-fly-2925-clean-room-synthetic-runner-lifecycle-task-2)
日期: 2026-09-28
基于: research.md

## 目标、权限与文件模型
实施节点仅创建 qa-sandbox/fly2925-clean.md，一个标题和三个段落，依次提交、推送三次。设计文档独立位于本目录，已获 Lead 对问题 546b3cf4-1508-4021-a922-420caa62d7fa 的线程答复授权。设计节点不写正文，不实施，不派发后继，不请求 shipping 权限。

文件内容是唯一产品交付；分支提交记录是步骤证据。无新 API、数据库、迁移、配置或依赖。标题是显示文本，不用作执行身份。执行/激活/原会话身份沿用引擎，不能由正文或目录名推导。

## 开始与恢复守卫
- [ ] 先运行 node "$FLYWHEEL_COMM_CLI" turn，只有 yours 才能改共享工作树；检查 inbox 和 git status --short。
- [ ] 记录实施起始 HEAD，核对分支为 project-slot-2-FLY-2998。已有修改时先识别归属，不覆盖、不 reset。
- [ ] 首次目标应不存在。若恢复时已存在，用 git log --reverse --format='%H %s' -- qa-sandbox/fly2925-clean.md 和 git show 核对已完成步骤；仅做未完成部分。
- [ ] 每一步只 git add 目标路径；git diff --cached --name-only 必须只有 qa-sandbox/fly2925-clean.md；有别的已暂存文件则先解决归属，不提交。

## 步骤 1：职责
创建目录及 UTF-8 Markdown，内容如下（段落不折为多个段落）：

```markdown
# Runner lifecycle

A runner carries out an assigned task within its authorized scope, checks its work, and saves progress in commits so the team can follow what has been completed.
```

- [ ] 检查一个标题、一个段落；git diff --check。
- [ ] git add qa-sandbox/fly2925-clean.md
- [ ] git commit -m "docs(FLY-2998): describe runner responsibilities"
- [ ] git push origin HEAD:refs/heads/project-slot-2-FLY-2998
- [ ] 记录成功推送输出，用 git rev-parse HEAD 和 git ls-remote origin refs/heads/project-slot-2-FLY-2998 核对编号一致，再继续。

## 步骤 2：重启
保留步骤 1 的字节，空行后追加：

```markdown
When a runner is restarted, it resumes the assigned task from saved progress, checks the existing files and commits, and continues with the first unfinished step without duplicating completed work.
```

- [ ] 检查一个标题、两个段落；diff 仅追加上述段落；git diff --check。
- [ ] git add qa-sandbox/fly2925-clean.md
- [ ] git commit -m "docs(FLY-2998): describe restart continuity"
- [ ] git push origin HEAD:refs/heads/project-slot-2-FLY-2998
- [ ] 记录成功推送输出并按步骤 1 的远端命令核对当前 HEAD，再继续。

## 步骤 3：交回
保留前两步的字节，空行后追加：

```markdown
The runner hands in its work by checking the final result, pushing the completed commits to the issue branch, reporting the outcome through the normal workflow, and recording the required handoff so the next authorized phase can continue.
```

- [ ] 检查一个标题、三个段落，顺序职责→重启→交回；diff 仅追加上述段落；git diff --check。
- [ ] git add qa-sandbox/fly2925-clean.md
- [ ] git commit -m "docs(FLY-2998): describe normal handoff"
- [ ] git push origin HEAD:refs/heads/project-slot-2-FLY-2998
- [ ] 记录成功推送输出并核对当前远端 HEAD。

## 验收与交接
- [ ] git log --reverse --format='%H %s' -- qa-sandbox/fly2925-clean.md 显示三个内容提交。逐个 git show <sha>:qa-sandbox/fly2925-clean.md，应分别为 1/2/3 段。
- [ ] git show --format= --name-only <sha> 对三个内容提交分别只显示目标文件。核对实施起始 HEAD 至当前 HEAD 的文件列表，无其他业务文件变化；设计前缀提交不混入实施文件限制。
- [ ] 核对三次成功推送记录；只看最终远端 HEAD 不能单独证明每一步都曾推送。
- [ ] 按实施节点届时注入的 normal flow 完成必要评审、报告、交接命令；不得把打印摘要当成交接成功，也不得复用设计执行身份。

## 失败与回滚边界
提交失败先检查错误；推送失败重试普通推送，禁止 force/no-verify，不进入下一步。非快进需要 Lead 明确决策，不覆写远端。意外文字问题追加纠正提交并报告三步历史偏差，不重写已推历史。没有服务变更，不能部署、重启或操纵数据库；主动制造重启不属于本题。

## 本地验证纪律
该变更只含 Markdown，按 research.md 的目标路径/文件名/父目录匹配排除了无关测试，不新增镜像测试，不跑全仓或全包套件。没有 TypeScript、导出类型或 API 变更，不需要 vitest related、依赖构建或类型检查。保留仓库要求的 pnpm lint。远端完整 CI 的结果只能按其实际冻结提交报告，不用本地文档检查冒充全量测试。

## 设计阶段交付清单
本目录 exploration/research/plan/progress、Mermaid 图稿与 founder-design.html；评论按页面路径隔离、保存失败可见、汇总每片以【页面意见汇总】FLY-2998 起始；不把反馈标记当通过。HTML 只有一个带 __CSP_NONCE__ 的内联脚本，事件用 addEventListener，所有动态 DOM 只用 textContent/value，无外部依赖。图需本地 mmdc 渲染，失败重试一次后明确报告。
设计 review_design gate 与 request-review 必须得到有效 APPROVED；随后提交推送最终产物，publish-report --publish-only、ask --report hosted URL，再 complete --route phase_design_complete 并 park。设计阶段完成不是 issue 终结。
