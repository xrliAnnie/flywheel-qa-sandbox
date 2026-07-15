import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..", "..");

describe("flywheel-quota-monitor package entry", () => {
	it("ships an executable thin launcher registered in package.json", () => {
		const pkg = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		);
		expect(pkg.bin["flywheel-quota-monitor"]).toBe(
			"bin/flywheel-quota-monitor",
		);
		expect(pkg.files).toContain("bin");
		const bin = join(packageRoot, "bin", "flywheel-quota-monitor");
		expect(existsSync(bin)).toBe(true);
		expect(statSync(bin).mode & 0o111).not.toBe(0);
		expect(readFileSync(bin, "utf8")).toContain(
			"dist/account-heal/quota-monitor-cli.js",
		);
	});
});
