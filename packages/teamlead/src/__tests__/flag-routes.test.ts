import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeEnvSha } from "../bridge/env-file-writer.js";
import {
	type FlagCanonical,
	type FlagRouteDeps,
	flagCanonicalSha,
	handleFlagApply,
	handleFlagStage,
} from "../bridge/flag-routes.js";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { FleetAdminAudit } from "../bridge/fleet-admin-audit.js";

const ENV_CONTENT = "# env\nFLYWHEEL_OTHER=1\n";

function makeDeps(over: Partial<FlagRouteDeps> = {}): FlagRouteDeps & {
	env: Record<string, string | undefined>;
	writeFile: ReturnType<typeof vi.fn>;
	audit: FleetAdminAudit;
} {
	const dbPath = join(mkdtempSync(join(tmpdir(), "ffaudit-")), "audit.db");
	return {
		envPath: "/tmp/.env",
		readFile: () => ENV_CONTENT,
		writeFile: vi.fn(),
		env: {},
		lock: (fn: () => unknown) => fn(), // pass-through; real lock tested in flag-toggle
		tokens: new ConfirmTokenStore(),
		audit: new FleetAdminAudit(dbPath),
		...over,
	} as never;
}

describe("handleFlagStage", () => {
	it("stages a direct flag: canonical + confirmToken + audit staged", () => {
		const deps = makeDeps();
		const r = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"http://localhost",
		);
		expect(r.code).toBe(200);
		const body = r.body as { canonical: FlagCanonical; confirmToken: string };
		expect(body.canonical.kind).toBe("flag");
		expect(body.canonical.envVar).toBe("FLYWHEEL_AUTO_QA");
		expect(body.canonical.rawTo).toBe("0"); // default_on off → write "0"
		expect(body.canonical.fileSha).toBe(computeEnvSha(ENV_CONTENT));
		expect(body.confirmToken).toBeTruthy();
	});

	it("rejects a non-direct / governance flag", () => {
		const deps = makeDeps();
		expect(
			handleFlagStage(deps, { name: "remote_reports", to: false }, "o").code,
		).toBe(400);
		expect(
			handleFlagStage(
				deps,
				{ name: "founder_consent_decision_mode", to: false },
				"o",
			).code,
		).toBe(400);
	});

	it("Codex R1 #2: rejects a malformed JSON boundary (non-boolean to / non-string name)", () => {
		const deps = makeDeps();
		// "off"/"false"/0 are truthy-or-not JS values that must NOT be coerced.
		for (const bad of ["off", "false", 0, 1, null, undefined]) {
			expect(
				handleFlagStage(
					deps,
					{ name: "auto_qa_killswitch", to: bad as never },
					"o",
				).code,
			).toBe(400);
		}
		expect(
			handleFlagStage(deps, { name: 123 as never, to: true }, "o").code,
		).toBe(400);
		expect(handleFlagStage(deps, {} as never, "o").code).toBe(400);
	});
});

describe("handleFlagApply", () => {
	it("applies with a valid token → mutates env, audits apply-result", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"o",
		).body as { canonical: FlagCanonical; confirmToken: string };
		const r = handleFlagApply(deps, staged.canonical, staged.confirmToken, "o");
		expect(r.code).toBe(200);
		expect(deps.env.FLYWHEEL_AUTO_QA).toBe("0");
		expect(deps.writeFile).toHaveBeenCalledTimes(1);
	});

	it("replay with the same token → denied (single-use)", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"o",
		).body as { canonical: FlagCanonical; confirmToken: string };
		handleFlagApply(deps, staged.canonical, staged.confirmToken, "o");
		const replay = handleFlagApply(
			deps,
			staged.canonical,
			staged.confirmToken,
			"o",
		);
		expect(replay.code).toBe(401);
	});

	it("tampered canonical (SHA mismatch) → denied", () => {
		const deps = makeDeps();
		const staged = handleFlagStage(
			deps,
			{ name: "auto_qa_killswitch", to: false },
			"o",
		).body as { canonical: FlagCanonical; confirmToken: string };
		const tampered = { ...staged.canonical, rawTo: null };
		const r = handleFlagApply(deps, tampered, staged.confirmToken, "o");
		expect(r.code).toBe(401);
	});

	it("flag canonical SHA is stable + change-sensitive", () => {
		const c: FlagCanonical = {
			kind: "flag",
			batchId: "b1",
			name: "x",
			envVar: "FLYWHEEL_X",
			rawFrom: null,
			rawTo: "0",
			fileSha: "sha",
			effectiveFrom: true,
			effectiveTo: false,
		};
		expect(flagCanonicalSha(c)).toBe(flagCanonicalSha({ ...c }));
		expect(flagCanonicalSha(c)).not.toBe(
			flagCanonicalSha({ ...c, rawTo: "1" }),
		);
	});
});
