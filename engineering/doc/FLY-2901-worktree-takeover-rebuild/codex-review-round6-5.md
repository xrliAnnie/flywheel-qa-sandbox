# FLY-2901 Codex 设计复核 R6-5（gpt-6-astra xhigh，personal1 隔离 CODEX_HOME 全新线程，纯书面、未运行任何命令；只审 §4.7a (e)(f) 与第 5 条论证）
Issue: FLY-2901
日期: 2026-09-26
基于: plan.md（56b4bc4e4，blob b6d205488cd4cd84f72adb93d08c05a7019813b6）；提示词内联了 §4.7a 全文与 R6-4 执行摘要

> 原文如下。

## Summary

Clauses (f) and (e) close the supplied Boundaries A and B, respectively. However, a remaining HIGH in (e)’s `realpath` containment test invalidates item 5’s claim that an outside-worktree global ignore file cannot be affected by reset.

This is a paper review; no commands were run or files accessed.

## Issues

1. **HIGH — An in-worktree symlink can change which outside-worktree ignore file Git reads.**

   Minimal counterexample:

   - Worktree: `/w`.
   - `core.excludesFile=/w/global-ignore`.
   - `/w/global-ignore` is a tracked symlink to `/outside/ignore`, whose contents are `drafts/`.
   - `/w/drafts/note` contains unsaved, ignored bytes.
   - Target replaces `global-ignore` with an empty regular file.
   - No index entries have assume-unchanged or skip-worktree flags.

   Here, `D` contains `global-ignore`. Clauses (a)–(c) permit its replacement: it is a tracked symlink, with directory ancestors. Clause (d) does not match its basename. Clause (e) permits it because its current `realpath` is `/outside/ignore`. Clause (f) also permits it.

   `reset --hard` replaces the symlink with the target’s empty file. Subsequently, `git clean -fd` reads that empty file through the unchanged `core.excludesFile` pathname and deletes `drafts/note`. The ignored bytes were never saved. Both guard invocations can pass before this happens.

   Item 5 therefore confuses stability of the currently resolved file with stability of the pathname Git uses to find its rules.

   **Minimal fix:** Extend (e) to reject in-worktree dependencies anywhere in the effective excludes pathname’s resolution, including the pathname itself and every traversed symlink—not merely the final resolved file. Preserve the conservative refusal policy. Checking only the original pathname and final `realpath` also misses symlink chains that pass through the worktree and end outside it. Update item 5 to require that the entire rule-source lookup remains unaffected by reset.

## Verdict

The supplied A/B reproductions are addressed, but the symlink counterexample still allows deletion of unsaved ignored content. Clause (e) and item 5 need revision.

VERDICT: CHANGES REQUESTED
