import { join } from "node:path";
import {
	type ExecFn,
	type LeadWindowRef,
	locateLeadWindow,
} from "../LeadWindowLocator.js";
import { classifyLeadPlistCarrier } from "./fleet-data.js";

export interface ConfiguredLeadWindowLocatorOptions {
	homeDir: string;
	stateDir: string;
	readFile(path: string): string;
	execFn?: ExecFn;
}

/**
 * Resolve a Lead terminal from current launchd authority, never a cached fleet
 * snapshot. A missing/unknown plist is intentionally terminally invisible:
 * guessing the old shared server during cutover can address the wrong body.
 */
export async function locateConfiguredLeadWindow(
	projectName: string,
	leadId: string,
	options: ConfiguredLeadWindowLocatorOptions,
): Promise<LeadWindowRef | null> {
	const key = `${projectName}-${leadId}`;
	try {
		const plist = options.readFile(
			join(
				options.homeDir,
				"Library",
				"LaunchAgents",
				`com.flywheel.lead.${key}.plist`,
			),
		);
		const carrier = classifyLeadPlistCarrier(
			plist,
			options.homeDir,
			options.stateDir,
		);
		if (carrier === "v1") {
			return locateLeadWindow(projectName, leadId, { execFn: options.execFn });
		}
		if (carrier !== "v2") return null;
		const manifest = JSON.parse(
			options.readFile(join(options.stateDir, "manifests", `${key}.json`)),
		) as Record<string, unknown>;
		return locateLeadWindow(projectName, leadId, {
			carrier,
			stateDir: options.stateDir,
			manifest,
			execFn: options.execFn,
		});
	} catch {
		return null;
	}
}
