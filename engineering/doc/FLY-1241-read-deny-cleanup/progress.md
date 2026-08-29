# FLY-1241 进度台账

- [x] onboard / brainstorm(exploration.md)+ brainstorm gate → Tadashi 拍 **Option A**
- [x] research.md / plan.md
- [x] design_review — Codex design review **4 轮 APPROVED**(8→6→无HIGH→APPROVED)
- [x] implement(TDD)— sentinel RED → 删除 → GREEN
- [x] 验证全绿(见下)
- [ ] PR + codex code review
- [ ] approve gate(本段停在这)

## 实现结果

- 删除面:37 tracked 文件(31 改 6 删)+ 2 新增测试(sentinel + infra-bot)+ 1 hostile-ambient 用例。
- read-deny + content-coordination profile + lead-actions broker-mode **全删**;full-access / companion /
  write-capable + secret-broker.ts(gateway 在用)**全保留**;lead-actions child 改 env-token-only。

## 验证(证据)

- typecheck teamlead + config:PASS
- build teamlead + config:PASS
- sentinel(read-deny-removed):GREEN 2/2(含 mutation 自测 + JSDoc 跨行 fixture)
- 我改的 10 个 vitest 测试文件隔离:**333 passed / 0 failed**
- config 全套:394/0;home shell:33/33(FLY-694 保留);mufasa(含 hostile ambient):20/0;
  mufasa-fullaccess:13/13;**infra-bot(新):13/0**;package-onboard 10/26/13 全 0
- grep-zero(产品源码+脚本+契约):**ZERO residue**
- biome:我改的 22 文件干净;剩余 lint 噪音全在非-diff 文件(baseline,与绿 main 相同或 plugin.ts 落后 1 commit rebase 即清)
- **全量 teamlead 套的失败全部预存在/环境**(baseline stash 复现 lead-rules-bundle 真-daemon 失败;stuck-candidate/worktree-quarantine 不在 diff;createLeadRuntime-preflight 负载 flake 隔离 PASS)

## Tadashi 注意点(已落实)
- ① Mufasa 现役 launcher = fullaccess wrapper(已确认不受影响);新增 infra-bot launcher 回归测试。
- ② contract md 删除在 PR 描述注明「由 AI-agnostic 决策取代」。
- 单独 codex code review。
