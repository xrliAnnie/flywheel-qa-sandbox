import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	runMigrationLifecycle,
	runMigrationStaticPreflight,
} from "../bin/backend-migration-lifecycle.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "migration lifecycle "));
	dirs.push(root);
	mkdirSync(join(root, "scripts"));
	const home = join(root, "home");
	mkdirSync(home);
	writeFileSync(
		join(root, "scripts/flywheel-lead.sh"),
		'#!/bin/bash\nprintf "%s\\n" "$@" > "$HOME/invocation"\nprintf "%s\\n" "$FLYWHEEL_DIR" "$FLYWHEEL_STATE_DIR" > "$HOME/paths"\n',
	);
	mkdirSync(join(root, "scripts/lib"));
	writeFileSync(
		join(root, "scripts/lib/lead-backend-migration.sh"),
		'lead_backend_migration_load_staged() { /bin/bash "$2/scripts/flywheel-lead.sh" load --project flywheel --lead flywheel-product-lead; }\n',
	);
	return { root, home, assertWindow: () => {} };
}
it("calls source-only static preflight and returns only resolved paths", async () => {
	const f = fixture();
	mkdirSync(join(f.root, "scripts/lib"), { recursive: true });
	writeFileSync(
		join(f.root, "scripts/lib/lead-backend-migration.sh"),
		`lead_backend_migration_static_preflight() { printf '%s\\n' "$@" > "$HOME/static-args"; printf '{"codexHome":"/codex","stateDir":"/state"}'; }\n`,
	);
	expect(
		await runMigrationStaticPreflight({
			...f,
			projectRoot: "/project",
			deploymentSha: "a".repeat(40),
			botTokenEnv: "BOT_TOKEN",
		}),
	).toEqual({ codexHome: "/codex", stateDir: "/state" });
	expect(
		readFileSync(join(f.home, "static-args"), "utf8").trim().split("\n"),
	).toEqual([f.home, f.root, "/project", "a".repeat(40), "BOT_TOKEN"]);
	expect(existsSync(join(f.home, "invocation"))).toBe(false);
});
it("rejects malformed static output without exposing it", async () => {
	const f = fixture();
	mkdirSync(join(f.root, "scripts/lib"), { recursive: true });
	writeFileSync(
		join(f.root, "scripts/lib/lead-backend-migration.sh"),
		"lead_backend_migration_static_preflight() { echo secret-output; }\n",
	);
	await expect(
		runMigrationStaticPreflight({
			...f,
			projectRoot: "/project",
			deploymentSha: "a".repeat(40),
			botTokenEnv: "BOT_TOKEN",
		}),
	).rejects.toThrow(/^migration static preflight result invalid$/);
});
it("does not run a function from a helper that failed while sourcing", async () => {
	const f = fixture();
	mkdirSync(join(f.root, "scripts/lib"), { recursive: true });
	writeFileSync(
		join(f.root, "scripts/lib/lead-backend-migration.sh"),
		`lead_backend_migration_static_preflight() { printf '{"codexHome":"/codex","stateDir":"/state"}'; }; return 78\n`,
	);
	await expect(
		runMigrationStaticPreflight({
			...f,
			projectRoot: "/project",
			deploymentSha: "a".repeat(40),
			botTokenEnv: "BOT_TOKEN",
		}),
	).rejects.toThrow("migration static preflight failed");
});
it.each(["stop", "load", "preflight"] as const)(
	"calls only the fixed target through existing %s",
	async (operation) => {
		const f = fixture();
		await runMigrationLifecycle(f, operation);
		expect(
			readFileSync(join(f.home, "invocation"), "utf8").trim().split("\n"),
		).toEqual(
			operation === "preflight"
				? [
						operation,
						join(
							f.home,
							".flywheel/manifests/flywheel-flywheel-product-lead.json",
						),
					]
				: [
						operation,
						"--project",
						"flywheel",
						"--lead",
						"flywheel-product-lead",
					],
		);
		expect(
			readFileSync(join(f.home, "paths"), "utf8").trim().split("\n"),
		).toEqual([f.root, join(f.home, ".flywheel")]);
	},
);
it("rejects revoked window before launching a child", async () => {
	const f = fixture();
	f.assertWindow = () => {
		throw Error("revoked");
	};
	await expect(runMigrationLifecycle(f, "stop")).rejects.toThrow("revoked");
	expect(existsSync(join(f.home, "invocation"))).toBe(false);
});
it("does not expose child output or retry a failed lifecycle command", async () => {
	const f = fixture();
	writeFileSync(
		join(f.root, "scripts/flywheel-lead.sh"),
		'#!/bin/bash\necho invoked >> "$HOME/invocation"\necho secret-output >&2\nexit 78\n',
	);
	await expect(runMigrationLifecycle(f, "load")).rejects.toThrow(
		/^migration lifecycle load failed$/,
	);
	expect(readFileSync(join(f.home, "invocation"), "utf8")).toBe("invoked\n");
});
it("rechecks the window after the child exits", async () => {
	const f = fixture();
	let checks = 0;
	f.assertWindow = () => {
		if (++checks === 2) throw Error("revoked");
	};
	await expect(runMigrationLifecycle(f, "load")).rejects.toThrow("revoked");
	expect(checks).toBe(2);
});
