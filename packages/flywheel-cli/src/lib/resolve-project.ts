/**
 * FLY-137 Phase 6: project-root resolution for flywheel-cli.
 *
 * All three subcommands (init / doctor / migrate-agent-registry) accept an
 * optional `--project-path <path>` flag. When omitted, the resolver
 * walks up parent directories from `process.cwd()` looking for a
 * `.flywheel/` directory (the same pattern git uses to find `.git/`).
 *
 * `init` is the one exception — it ALWAYS expects to scaffold a
 * `.flywheel/` and so calls this helper with `expectExisting: false`,
 * which short-circuits the walk and returns the explicit or cwd path
 * without erroring on missing `.flywheel/`.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

export interface ResolveProjectOpts {
	explicit?: string;
	/**
	 * When false, the helper returns the explicit or cwd path even if
	 * `.flywheel/` doesn't exist (used by `init` which is about to
	 * create it). When true (default), the helper walks up looking
	 * for `.flywheel/` and errors if none is found.
	 */
	expectExisting?: boolean;
	/** Override `process.cwd()` for testing. */
	cwd?: string;
}

export class ProjectRootNotFoundError extends Error {
	constructor(searchedFrom: string) {
		super(
			`No .flywheel/ found in any ancestor of ${searchedFrom}. ` +
				`Pass --project-path or run from a Flywheel project tree.`,
		);
		this.name = "ProjectRootNotFoundError";
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function resolveProjectPath(opts: ResolveProjectOpts = {}): string {
	const cwd = opts.cwd ?? process.cwd();

	if (opts.explicit) {
		const resolved = isAbsolute(opts.explicit)
			? opts.explicit
			: resolvePath(cwd, opts.explicit);
		if (!isDir(resolved)) {
			throw new Error(
				`--project-path does not exist or is not a directory: ${resolved}`,
			);
		}
		return resolved;
	}

	// init mode — don't require .flywheel/ to exist.
	if (opts.expectExisting === false) {
		return cwd;
	}

	// Walk up from cwd to filesystem root looking for `.flywheel/`.
	let current = cwd;
	while (true) {
		if (existsSync(resolvePath(current, ".flywheel"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new ProjectRootNotFoundError(cwd);
}
