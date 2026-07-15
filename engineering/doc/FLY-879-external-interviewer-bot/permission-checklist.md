# FLY-879 Anna 权限/隔离清单(部署前后核对用)

Issue: FLY-879 (https://linear.app/geoforge3d/issue/FLY-879)
日期: 2026-07-05
基于: deploy-runbook.md, plan.md §5

> 给 Tadashi 部署时逐条核对用的浓缩版(全部细节见 deploy-runbook.md §2-§5)。
> 不是新设计——只是把已经过 Codex design review(3 轮 APPROVED)的隔离面收进一张清单。

## A. GitHub 权限(Annie 手动建的那把 PAT)

- [ ] Repository access = **Only select repositories** → 仅 `xrliAnnie/flywheel-interviews`
- [ ] Permissions 仅三项、都是 RW:**Contents / Pull requests / Issues**
- [ ] 没有勾任何 org 级权限、没有勾 Actions/Admin/Workflows 等
- [ ] `scripts/verify-anna-isolation.sh` Surface 1(GitHub API)+ Surface 2(raw git)跑通:
      对 `flywheel-interviews` 是 200/可 push,对 `flywheel`(主仓)是 404/被拒

## B. Claude pane 环境(claude-lead.sh 已实现,部署后验证)

- [ ] `FLYWHEEL_LEAD_EXTERNAL=1` 在 pane env 里
- [ ] 高权限凭据全部 EMPTY:`TEAMLEAD_API_TOKEN` / `BRIDGE_URL` / `FLYWHEEL_COMM_CLI` / `FLYWHEEL_COMM_DB` / `OPENAI_API_KEY`
- [ ] 没有任何裸 `ANNA_*` 环境变量(`GH_TOKEN` / `DISCORD_BOT_TOKEN` 是转译后的通用名,不是 `ANNA_GITHUB_TOKEN` 原名)
- [ ] 没有其他 Lead 的 `*_BOT_TOKEN`、没有 `LINEAR_*`
- [ ] 没有注册任何内部 MCP(flywheel-terminal / flywheel-inbox / gbrain / 用户级 MCP 全部为空)
- [ ] 系统提示**只有一个文件**:`external-agent-contract.md`(工程规则/founder-only-authority/cross-dept/discord-reply-contract/screencap 全部不加载)
- [ ] `scripts/verify-anna-isolation.sh` Surface 3(pane env)跑通

## C. 工作区隔离

- [ ] `LEAD_WORKSPACE` 目录树内**没有主仓 checkout**(无 `packages/teamlead` 等指纹路径)
- [ ] `scripts/verify-anna-isolation.sh` Surface 4(workspace)跑通

## D. Discord 频道权限

- [ ] `access.json` allowlist 里**只加了两个频道**:客户频道 + `#pm-interviewer`
      (漏加 = bot 在线但不回话,见 [[reference_lead_bot_online_ignores_messages_missing_access_json]])
- [ ] `#pm-interviewer` 收得到 `external_config_error` 告警(fail-STOP 落点验证,见 R1 备注)

## E. 上线前硬闸(W6,全绿才允许发邀请)

- [ ] 内部彩排 E2E 走完全流程,体感自然
- [ ] 注入对抗测试(5 条诱导话术)全部婉拒 + 上报
- [ ] `product-intro/` seed v0 Annie 已过目
- [ ] interviews 仓 public-safe 内容闸 PASS(零内部信息)
- [ ] **Annie 明确 GO**,且由她本人生成客户 server 邀请链接、安排老公进场

---

**一句话红线**:A/B/C/D 是"结构性锁死"——就算 Anna 被诱导也做不到;E 是"行为验证"——确认她的对话体感和拒绝诱导的实际表现。两类都要过,E 没过之前不发邀请。
