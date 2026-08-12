import { describe, expect, it, vi } from "vitest";
import { deriveLeadSocketPath } from "../../lead-address.js";
import { locateConfiguredLeadWindow } from "../fleet-lead-locator.js";

const HOME = "/home/test";
const STATE = "/state/flywheel";
const KEY = "geo-product-lead";
const PLIST = `${HOME}/Library/LaunchAgents/com.flywheel.lead.${KEY}.plist`;
const MANIFEST = `${STATE}/manifests/${KEY}.json`;

describe("locateConfiguredLeadWindow", () => {
	it("reads current plist authority on every v2 lookup", async () => {
		const socketPath = deriveLeadSocketPath("geo/product-lead", STATE);
		const files: Record<string, string> = {
			[PLIST]: `<plist><string>${STATE}/bin/flywheel-lead-wrapper-v2.sh</string></plist>`,
			[MANIFEST]: JSON.stringify({
				projectName: "geo",
				leadId: "product-lead",
				socketPath,
			}),
		};
		const readFile = vi.fn((path: string) => files[path]!);
		const execFn = vi.fn(async (file: string) => {
			if (file === "ps") {
				return {
					stdout: "/bin/bash /repo/lead-body.sh /manifest\n",
					stderr: "",
				};
			}
			return {
				stdout: "%0\tmain\tbash /repo/lead-body.sh /manifest\tclaude\t0\t42\n",
				stderr: "",
			};
		});

		await expect(
			locateConfiguredLeadWindow("geo", "product-lead", {
				homeDir: HOME,
				stateDir: STATE,
				readFile,
				execFn,
			}),
		).resolves.toMatchObject({ carrier: "v2", socketPath, windowId: "%0" });
		expect(readFile.mock.calls.map(([path]) => path)).toEqual([
			PLIST,
			MANIFEST,
		]);
	});

	it("fails closed for missing or unknown plist authority", async () => {
		const execFn = vi.fn();
		await expect(
			locateConfiguredLeadWindow("geo", "product-lead", {
				homeDir: HOME,
				stateDir: STATE,
				readFile: () => "<plist><string>/bespoke/wrapper.sh</string></plist>",
				execFn,
			}),
		).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});

	it("fails closed for a historical shared-server plist", async () => {
		const execFn = vi.fn();
		await expect(
			locateConfiguredLeadWindow("geo", "product-lead", {
				homeDir: HOME,
				stateDir: STATE,
				readFile: () =>
					`<plist><string>${STATE}/bin/retired-wrapper.sh</string></plist>`,
				execFn,
			}),
		).resolves.toBeNull();
		expect(execFn).not.toHaveBeenCalled();
	});
});
