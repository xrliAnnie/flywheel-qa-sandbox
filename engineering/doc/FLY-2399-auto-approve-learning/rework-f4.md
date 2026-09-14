# FLY-2399 用户配置隔离 — 实施记录
Issue: FLY-2399
日期: 2026-09-11
基于: plan.md

基线 `44b17c33bc92ee65be56fe7dc785ba936e605242` 已通过 R2 review c79fc9a4 和精确头 CI 34608738421，随后 QA attempt 2 判 FAIL。本轮严格按 Lead 指令 2a23a266-1903-4a12-a0ab-d87661a422fe 只修 F4：`--setting-sources user` 读取用户 settings，导致语言、thinking 与 effort 进入模型输入却不进入 configuration_digest。其它 advisory 不处理；不修改 plan、授权、flag 或生产服务。

每次调用创建独立 HOME、CLAUDE_CONFIG_DIR、cwd（0700），仅写入经字段校验的 `.credentials.json`（0600）。读取顺序为显式 OAuth token、指定配置目录认证文件、仅 macOS 默认 home/config 的现有订阅 Keychain；无写回、无读取用户 settings/CLAUDE.md、无 API key 继承。认证文件拒绝符号链接、非普通文件、超过 64KiB 和无效结构；额外字段剥离。子进程结束或启动失败后清理整个目录。OAuth token 只传给该子进程，stderr 不保留，日志与材料不含认证内容。

保留 CLI 2.1.268 所需的非空 setting source `user`，其来源现在是隔离目录。固定 `--settings`：language=english、alwaysThinkingEnabled=true、effortLevel=bindings 对应 effort（本次 high）、MAX_THINKING_TOKENS=31999、禁用 thinking/adaptive 的变量均为 0；保留 safe-mode、禁 hooks、空 tools/MCP 与原 120s、无重试策略。设置说明参考 [Claude Code settings](https://code.claude.com/docs/en/settings) 与 [environment variables](https://code.claude.com/docs/en/env-vars)。

依 Lead 澄清 33ff9673-e57a-40ad-841a-3a87f4c3623f，configuration_digest 覆盖完整固定 settings JSON、认证类型、目录文件白名单和不继承 settings/CLAUDE.md/env 的契约、全部固定 argv（含 model/effort）；不散列 credential 字节，也不散列每次随机目录路径。认证轮换不消耗语义版本。配置变更使旧冻结包 model_or_prompt_changed 且零调用；本轮新冒烟冻结包使用新 digest，旧包保留原字节。

测试：配置 A/B 单测先 RED，分别读到 english/chinese 与污染 env，修复后 GREEN；增加认证负例与固定 settings/白名单/argv 漂移拒绝测试。ship-judgment 全部 51 文件、197 项通过（/tmp/fly2399-f4-focused.log），包 build 通过。

真实模型 A/B：相同问题 `Answer in one short sentence: what is the capital of France?`、相同 argv、两个只改变用户 language 的临时认证目录。RED 为英文 “The capital of France is Paris.” / 中文 “法国的首都是巴黎（Paris）。”；GREEN 均为 “The capital of France is Paris.”。固定其它用户设置为 thinking=false、effort=low、MAX_THINKING_TOKENS=0。四次顺序调用，无重试；真实用户设置未改。完整 envelope 在 rework-f4-fixtures/ab-{red,green}.json；复现脚本 ab-probe.mjs 接受未存在的绝对输出路径前缀，需要本机已登录订阅的 macOS Keychain 与编译 dist，分别在基线/新代码运行。

另用生产 replay 脚本跑一个新冻结的有限输入域 inc 合成正例，以覆盖默认 Keychain→隔离配置→真实 evaluator 全链路。期望在运行前写入 expectations.json。该合成证据不是生产 QA 验收；F4 总调用预算 5 次、顺序、零重试。结果与完整 Quick Gate、review、CI 在完成后补录。宿主全包按 Lead 原指令不重跑，继续标「Lead 主动结束，未采信」。

最终本地回执：默认 macOS 订阅认证的完整 evaluator 冒烟 `evaluated / pass / pass`，原输入 SHA-256 与报告一致，未使用 A/B harness 的显式 token 环境。完整 Quick Gate 28 条命令 exit 0（/tmp/fly2399-f4-quick-gate.log，包含 pnpm -r build、typecheck、lint）；新 timer/mutation 脚本另行核验。review 与精确头 CI 仍须在最后推送后取得，不以这些本地结果替代。

新增 timer/mutation 两脚本共 4 项通过（/tmp/fly2399-f4-scripts.log），没有执行全包重跑。
