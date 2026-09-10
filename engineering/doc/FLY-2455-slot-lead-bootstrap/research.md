# FLY-2455 529 房启动诊断 — 调研
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-08
基于: exploration.md

## 结论和证据强度

已查明的精确失败项是 **main arm 的私有 socket / main 会话探测失败**，不是 label 未生成，也不是 plist 尚未拉起 wrapper。最早的 body 退出原因仍缺原始输出；不能把“拓扑门失败”写成根因闭环。

FLY-2107 原命令：`TMPDIR=/tmp/q7 bash scripts/test-deploy.sh 2 --extra-lead 3:Ops-Test`。main 对照改用 `/Users/xiaorongli/Dev/flywheel/scripts/test-deploy.sh`，其 HEAD 和 build identity 均为 `ee113cab956bf3d71f186e5d72b24baf545e629c`。两臂均未带 `--alerts`。

PR arm：19:05:37 启动，19:06:55 失败；最后观测 `launchPid=95382 manifestPid=87768`。wrapper 日志在 19:05:39、19:05:56、19:06:10、19:06:26、19:06:40 多次打印启动；host gate 每次 pass + verified。

main arm：19:13:21 启动，19:14:33 失败。原始行：

```text
[qa-launchd] ERROR: topology verification failed: label=com.flywheel.qa.lead.slot-2.flywheel-test-2 launchPid=17981 manifestPid=17981 socket=/tmp/flywheel-test-slot-2/q/2/sock/fw-test-slot-2-flywheel-4f15afe70cbcdbd5.sock
[test-deploy] 19:14:33 ERROR: launchd-v2 Lead bootstrap failed
```

`qa_launchd_lead_verify` 中相等 PID 后唯一剩余成功条件是该 socket 上 `has-session -t '=main'` 返回 0。因为读取并非原子快照，不能据这两个相等整数断言整个采样窗口内服务持续存活。

## 原始证据位置

FLY-2107 QA session：`~/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-2107/928a29a0-c22f-4d65-9dc2-294571cd2f2b.jsonl`。第 428、444、470、473、500、550 行为相关工具结果；第 524 行保存 main arm 命令。原 scratchpad：`/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2107/928a29a0-c22f-4d65-9dc2-294571cd2f2b/scratchpad/`。

- `deploy.log` SHA-256 `42f5a01a5ec200b09a6837c65c56607d2608438bf808627365596b91da93322b`。
- `deploy-main.log` SHA-256 `c1cb83154b0ffaab4f4870a00b77a6194c68a8d5a00d28e1264051d2452307d2`。
- `wrapper-manual.log` SHA-256 `34f72023e175df8555865874767b79563a66ef2377e54bb22c25633df0fa6cc5`。

手动复跑中出现过 `LEAD_ID`/`FLYWHEEL_LEAD_ID` ambient identity 冲突。这些调用没清空 runner 自己的环境；后来 `env -i` 复跑没有该冲突。不得把实验引入的错误当作原 launchd 的主因。第 473/500 行的 `no server running` 是停止/手动复跑后的观测，只支持会话未持续存在，不能单独证明原采样时刻的死亡原因。

FLY-2398 原始日志未独立找回；issue 提供的同症状是关联证据，不冒充第二份已核实的根因。Lead 已确认配套隔离单为 **FLY-2454**，当时仍在 design。回复 question `99a93a6a-6751-4021-99ca-bf5210c5710d` 已读取并报告落实。

## 调用链与所有相关消费者

1. `scripts/test-deploy.sh:1515` 构造 base env；`:1630` 写 canonical manifest；`:1633` 渲染 plist；`:1636` 注册；`:1637` 启动；`:1638` 验证；`:1707` 用通用错误包裹主 Lead 失败。extra Lead 经 `:1903` 同一函数，`:1911` 包裹错误。
2. `scripts/lib/qa-lead-artifacts.sh:28` 是 manifest 写者；成功 deploy stdout 和 launch manifest 也由本文件生成。不得把诊断文字混入这些 JSON/TSV。
3. `scripts/lib/qa-launchd-lead.sh:118` 渲染 plist。`:702` 先验证任务不存在、bootstrap 并取 PID；`:736` 验证 manifest PID/socket 与 launchd PID；`:762` registry 是拆除 KeepAlive 任务的权威。错误增强不增加新的拆房权限。
4. `scripts/flywheel-lead-wrapper-v2.sh:161` host gate；`:239` canonical identity；`:311` socket 地址；`:358` exit-empty/pane-exited；`:483` 创建 `main`；`:49` 在 pane 内先发布 manifest，再 exec `packages/teamlead/scripts/lead-body.sh`。
5. `packages/teamlead/scripts/lead-body.sh` 保留 canonical tuple 后读取 wrapper env，最终 source `claude-lead.sh`；后者负责配置、插件检查、model、租约与实际 Claude 子进程。wrapper 的 launchd stdout 不包含消失 pane 的正文输出。
6. Claude 验证器使用 `${FLYWHEEL_QA_TMUX:-tmux}`，dev-channel poller 用 bare `tmux`。wrapper 自己重排 PATH。Codex 在 `test-deploy.sh:1457` 已固定绝对 tmux 路径，不能以 Claude 的可疑路径替换 Codex 合同。
7. `scripts/__tests__/fly1663-qa-launchd.test.sh` 与 `fly1663-qa-launchd-mutants.test.sh` 消费 helper/plist 字节快照；`test-deploy-fly1389.test.sh` 用 stub wrapper 执行真实 deploy composition；`test-deploy-qa-room.test.sh` 有源码合同；`fly1663-lead-v2-runtime.test.sh` 执行真实 wrapper 与 stub body；`fly1726-lead-identity-wrapper.test.sh`、`fly1697-v2-lease-body.test.sh` 覆盖真实 identity/body 边界。

消费者扫描：2026-09-09 UTC，在 `scripts/` 全量检索 `qa_launchd_lead_verify` / `qa_launchd_render_plist`；生产 verifier 调用只有上述 qa_slot_start_lead；其余是列出的测试。没有删除或重命名公开 CLI。

## 对照两个旧问题

- **FLY-2174 alerts env**：`test-deploy.sh:1043` 已移除 duplicate projects/token；两个历史失败臂都不带 alerts。不是这次已见失败的来源，保持 canonical identity 拒绝规则。
- **TMPDIR 超限**：Bridge tsx 的 IPC 地址过长曾发生，但这次失败发生在 Bridge 启动前且原命令已经 `TMPDIR=/tmp/q7`。Lead 地址由 `lead-address.sh` 独立派生，固定要求少于 90 字节。本轮记录的 slot-2 地址符合该约束。不能因此断言所有临时路径安全；QA 仍量实际路径字节，分别记录 Lead socket 和 Bridge tmp。
- **旧 host tmux 门**：原日志每次 pass，且本设计用现有 gate 在 `/private/tmp/fly2455-probe-t3veupy0` 写独立 receipt，返回 0，native 3.7c arm64。没动任何服务或生产 receipt。

## 两个待实证的假设

**H1：正文早退。** manifest 发布后 body 很快退出，主 pane 消失，私有 server 退出，launchd KeepAlive 再拉。不同代 PID 对不上是可能结果。现有 pane 未保存输出，因此不知道早退来自哪项配置/依赖。不能猜一个默认值就修。

**H2：探测客户端与服务端不一致。** wrapper 固定 native-first PATH，而 verifier 继承 QA shell 的 tmux。不同版本客户端可能导致 probe 非零。当前 shell 也选 3.7c，但历史 QA 的实际选中路径与 probe stderr 未保存，不能排除或证实。保留 `=main`：本机 tmux primary manpage 定义它为合法精确会话名。

两者可先后出现，不能强行二选一。重跑必须同一尝试同时采集 wrapper 使用的 tmux、验证器使用的 tmux、两个 PID、socket/main 探测结果和 body 退出证据。

## 已运行的无服务探测

真实 helper + fixture PID 17981 + manifest PID 17981 + `/usr/bin/false` 探测器：exit 1，输出与 main arm 同形，仅 socket 路径为 fixture。这证明“客户端失败”和“会话消失”无法由当前最终文本区分，不证明 H1/H2 任一成立。

独立研究还验证 `{}` 与非法 JSON `{bad` 都得到相同空字段错误，且没有调用 launchctl PID helper。`:740` 吞掉 jq stderr，`:750` 吞掉 tmux stderr，是确定的可观测性缺口。

现有测试刻意要求 pending manifest 时不高频轮询 launchctl（`fly1663-qa-launchd.test.sh:683`）。设计保留 60×1 秒冷启动窗口，在末次失败时增加一次有上限的快照，不引入 10Hz 进程探测。

## 方案界线

实现先完成精确诊断和可保存的起步证据；安全台架具备后复现并写根因附录，经增量设计评审再提交根因修复。**仅诊断变好不能完成 FLY-2455**。设计阶段没有虚称干净 main 启动成功；未取得真实 body 退出原因的事实要贯穿交接、HTML 和最后验收。
