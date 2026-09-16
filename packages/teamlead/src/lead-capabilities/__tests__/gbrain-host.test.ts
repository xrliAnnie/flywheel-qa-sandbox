import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pinGbrainHost } from "../gbrain-host.js";

const hash = (x: string | Buffer) =>
	createHash("sha256").update(x).digest("hex");
it("pins code before launch, keeps host configuration private and rejects all drift", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gbrain-host-")));
	try {
		const pkg = join(root, "gbrain");
		mkdirSync(join(pkg, "src"), { recursive: true });
		mkdirSync(join(root, ".gbrain"));
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ name: "gbrain", version: "0.9.0" }),
		);
		writeFileSync(join(pkg, "src/cli.ts"), "// fixture");
		writeFileSync(join(root, "bun"), "fixture binary");
		writeFileSync(join(root, "bun.lock"), "fixture lock");
		writeFileSync(
			join(root, ".gbrain/config.json"),
			JSON.stringify({
				engine: "postgres",
				database_url: "postgres://user:PRIVATE%5FPASSWORD@localhost/db",
			}),
		);
		const rows = ["package.json", "src/cli.ts"].map((p) => [
			p,
			hash(readFileSync(join(pkg, p))),
		]);
		const baseline = {
			home: root,
			packageRoot: pkg,
			version: "0.9.0",
			sourceSha256: hash(JSON.stringify(rows)),
			bun: { path: join(root, "bun"), sha256: hash("fixture binary") },
			lock: { path: join(root, "bun.lock"), sha256: hash("fixture lock") },
		};
		const pin = pinGbrainHost(baseline);
		expect(pin.launch.args).toEqual([
			"--no-env-file",
			"--no-install",
			"--config=/dev/null",
			join(pkg, "src/cli.ts"),
			"serve",
		]);
		expect(pin.launch.env).toEqual({
			HOME: root,
			PATH: "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
		});
		expect(JSON.stringify(pin.evidence)).not.toContain("PRIVATE_CANARY");
		expect(pin.secrets).toContain(
			"postgres://user:PRIVATE%5FPASSWORD@localhost/db",
		);
		expect(pin.secrets).toContain("PRIVATE_PASSWORD");
		pin.assertCurrent();
		writeFileSync(join(root, ".gbrain/config.json"), "{}");
		expect(pin.assertCurrent).toThrow("gbrain_host_unverified");
		writeFileSync(
			join(root, ".gbrain/config.json"),
			JSON.stringify({
				engine: "postgres",
				database_url: "postgres://user:PRIVATE%5FPASSWORD@localhost/db",
			}),
		);
		writeFileSync(join(pkg, "src/cli.ts"), "// changed");
		expect(() => pinGbrainHost(baseline)).toThrow("gbrain_host_unverified");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
