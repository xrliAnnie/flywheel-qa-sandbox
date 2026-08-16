/**
 * FLY-939 (G-D): Bridge startup checkout-SHA visibility.
 *
 * The production Bridge runs its checkout's source directly (tsx / dist); a
 * launchd KeepAlive respawn or a manual restart does NOT `git pull`. FLY-887's
 * root-cause incident: a merge landed at 12:10, the Bridge restarted at 17:29 on
 * a STALE checkout, and the merged keep-alive fix silently never went live — with
 * zero signal that the running code was behind origin/main.
 *
 * This is pure observability: on boot, log the running HEAD (so every restart
 * leaves a record of exactly which commit is live), then best-effort compare it
 * against origin/main. If HEAD is strictly BEHIND origin/main (an ancestor of it)
 * → a stale checkout of merged work: WARN loudly + a durable StateStore event +
 * a best-effort Lead alert. If HEAD is AHEAD or DIVERGED (a dev/QA-slot branch)
 * → just log (never warn — those Bridges legitimately run non-main checkouts).
 * Any git failure is swallowed: this must NEVER affect Bridge startup.
 */

/**
 * The five boot-SHA states collapse to four classifications:
 *   - `same`    — HEAD === origin/main: up to date.
 *   - `stale`   — HEAD is a strict ANCESTOR of origin/main: behind merged work.
 *   - `branch`  — HEAD is ahead of / diverged from origin/main: a branch checkout
 *                 (dev box, QA slot worktree) — legitimately not on main.
 *   - `unknown` — origin/main could not be resolved (offline / fetch failed) —
 *                 no comparison possible.
 * Only `stale` warrants the loud STALE-CHECKOUT signal.
 */
export type BootShaClass = "same" | "stale" | "branch" | "unknown";

/**
 * Pure classifier — no I/O, trivially unit-testable. `originMain === null`
 * (fetch/rev-parse failed) OR `isAncestor === null` (comparison unavailable) →
 * `unknown`. Otherwise: equal → `same`; HEAD is an ancestor of origin/main →
 * `stale`; else (ahead / diverged) → `branch`.
 */
export function classifyBootSha(input: {
	head: string;
	originMain: string | null;
	isAncestor: boolean | null;
}): BootShaClass {
	if (!input.originMain || input.isAncestor === null) return "unknown";
	if (input.head === input.originMain) return "same";
	if (input.isAncestor === true) return "stale";
	return "branch";
}

export interface BootShaCheckDeps {
	/** The Bridge's own source checkout root (where `git rev-parse HEAD` runs). */
	projectRoot: string;
	/**
	 * Run a git subcommand in `projectRoot`. Resolves with trimmed stdout on exit
	 * 0; REJECTS on any non-zero exit or spawn error (standard execFile shape).
	 * The effect uses reject/resolve to drive classification: a rejected
	 * `merge-base --is-ancestor` (exit 1 = not ancestor, or an error) → not stale.
	 */
	git(args: string[]): Promise<string>;
	logger: { log(m: string): void; warn(m: string): void };
	/** Durable `bridge_boot_stale_checkout` event (best-effort; never throws). */
	recordStaleEvent(payload: {
		headSha: string;
		originMainSha: string;
		aheadBy?: number;
	}): void;
	/** Best-effort Lead alert on a stale checkout (never throws). */
	alertStale?(info: {
		headSha: string;
		originMainSha: string;
		message: string;
	}): Promise<void>;
}

/** The explicit remote-tracking refspec (Codex design R1 #3): a bare
 * `git fetch origin main` updates only FETCH_HEAD on some configs, leaving
 * refs/remotes/origin/main stale — so a later `rev-parse origin/main` reads the
 * OLD ref and the stale checkout goes undetected (a false negative, exactly what
 * this feature exists to catch). The explicit dst ref forces the update. */
const FETCH_ARGS = [
	"fetch",
	"--quiet",
	"origin",
	"+refs/heads/main:refs/remotes/origin/main",
];

/**
 * Run the boot-SHA check. Fire-and-forget from the Bridge boot sequence (never
 * awaited on the critical path). Fully guarded — any error is swallowed.
 */
export async function runBootShaCheck(deps: BootShaCheckDeps): Promise<void> {
	try {
		let head: string;
		try {
			head = (await deps.git(["rev-parse", "HEAD"])).trim();
		} catch (err) {
			deps.logger.log(
				`[bridge-boot] running HEAD unknown (git rev-parse failed: ${(err as Error).message})`,
			);
			return;
		}
		if (!/^[0-9a-f]{40}$/i.test(head)) {
			deps.logger.log(`[bridge-boot] running HEAD unparseable ("${head}")`);
			return;
		}
		let subject = "";
		try {
			subject = (await deps.git(["log", "-1", "--format=%s", head])).trim();
		} catch {
			/* subject is cosmetic */
		}
		// Unconditional: every restart leaves a record of the exact live commit.
		deps.logger.log(
			`[bridge-boot] running HEAD=${head}${subject ? ` (${subject})` : ""}`,
		);

		// Best-effort compare against origin/main (fetch first — a stale local
		// origin/main ref would false-negative). Any failure → unknown → no warn.
		let originMain: string | null = null;
		let isAncestor: boolean | null = null;
		try {
			await deps.git(FETCH_ARGS);
			originMain = (await deps.git(["rev-parse", "origin/main"])).trim();
			isAncestor = false;
			try {
				await deps.git(["merge-base", "--is-ancestor", head, "origin/main"]);
				isAncestor = true; // exit 0 → HEAD IS an ancestor (behind)
			} catch {
				isAncestor = false; // exit 1 (not ancestor) or error → not stale
			}
		} catch (err) {
			deps.logger.log(
				`[bridge-boot] origin/main compare skipped (offline / fetch failed: ${(err as Error).message})`,
			);
			originMain = null;
		}

		const cls = classifyBootSha({ head, originMain, isAncestor });
		if (cls !== "stale" || !originMain) {
			// same / branch / unknown → nothing to warn about. (branch = dev / QA slot.)
			return;
		}

		let aheadBy: number | undefined;
		try {
			const n = Number.parseInt(
				(
					await deps.git(["rev-list", "--count", `${head}..origin/main`])
				).trim(),
				10,
			);
			if (Number.isFinite(n) && n > 0) aheadBy = n;
		} catch {
			/* count is cosmetic */
		}
		const aheadNote = aheadBy
			? ` (${aheadBy} commit${aheadBy === 1 ? "" : "s"} ahead)`
			: "";
		const message = `[bridge-boot] STALE CHECKOUT: running ${head} but origin/main is ${originMain}${aheadNote} — merged work is NOT live; pull + restart to deploy`;
		deps.logger.warn(message);
		try {
			deps.recordStaleEvent({
				headSha: head,
				originMainSha: originMain,
				aheadBy,
			});
		} catch (err) {
			deps.logger.warn(
				`[bridge-boot] recordStaleEvent failed: ${(err as Error).message}`,
			);
		}
		if (deps.alertStale) {
			try {
				await deps.alertStale({
					headSha: head,
					originMainSha: originMain,
					message,
				});
			} catch (err) {
				deps.logger.warn(
					`[bridge-boot] stale-checkout alert failed: ${(err as Error).message}`,
				);
			}
		}
	} catch (err) {
		// Absolute backstop — a boot-SHA check must NEVER break Bridge startup.
		deps.logger.warn(
			`[bridge-boot] sha check failed (non-fatal): ${(err as Error).message}`,
		);
	}
}
