/**
 * FLY-615: portable ponytail-style code-minimalism ruleset.
 *
 * Codex Runners are headless (stdin prompt, no interactive TUI), so the real
 * ponytail plugin — which requires interactive hook-trust on Codex — cannot be
 * auto-enabled. ponytail's core is a portable "decision ladder" the project
 * documents as a copy-into-instructions ruleset for non-Claude agents. This is
 * the equivalent ruleset we inject into a Codex Runner's instruction layer when
 * ponytail is enabled for that run.
 *
 * NOTE (for FLY-616 eval): this is the *equivalent ruleset*, not the real
 * plugin's per-turn lifecycle hooks. Its effect may be weaker than the Claude
 * plugin path; eval must keep Claude/Codex buckets distinguishable.
 *
 * Source of the ladder: DietrichGebert/ponytail (MIT). Authored here as a
 * faithful equivalent — we do not vendor the plugin's hook code.
 */
export const PONYTAIL_RULESET = `# Ponytail — code-minimalism ruleset (decision ladder)

Before writing ANY code, stop at the FIRST rung that satisfies the task — do not climb higher than necessary:

1. **Skip it (YAGNI).** Is this actually required by the task right now? If it is speculative, do not build it.
2. **Use the standard library.** Prefer a stdlib function over a new helper.
3. **Use a native platform feature.** Prefer a built-in language/runtime/framework capability over custom code.
4. **Use an already-installed dependency.** Do not add a new dependency for something an existing one already does.
5. **Write one line.** If one expression does it, do not write a function/class/abstraction around it.
6. **Write the minimum that works.** Only then write code — the least that correctly satisfies the task.

When reviewing or editing, actively look for what to DELETE: reinvented stdlib, unneeded dependencies, speculative abstractions, dead flexibility, premature generalization. Less code that works beats more code that might.

This does not lower correctness or completeness — handle the real cases, error paths, and edge cases the task needs. It removes only what the task does NOT need.`;
