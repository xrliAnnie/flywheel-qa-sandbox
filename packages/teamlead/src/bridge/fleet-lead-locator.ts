import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
	type ExecFn,
	type LeadWindowRef,
	locateLeadWindow,
} from "../LeadWindowLocator.js";
import type { LeadRuntimeManifest } from "../lead-address.js";
import { classifyLeadPlistCarrier } from "./fleet-data.js";

/**
 * FLY-2882: a Bridge whose Leads are not launched from the production
 * LaunchAgents directory (a 529 room) names its own launchd registry here.
 * Production never sets it.
 */
export const LEAD_LAUNCHD_REGISTRY_ENV = "FLYWHEEL_LEAD_LAUNCHD_REGISTRY";

export interface ConfiguredLeadWindowLocatorOptions {
	homeDir: string;
	stateDir: string;
	readFile(path: string): string;
	execFn?: ExecFn;
	/**
	 * This Bridge's own launchd registry (`launchd-leads.json` rows of
	 * `{label, plist, manifest}`), given explicitly by the Bridge config. When
	 * present it is the only authority: production LaunchAgents are never read.
	 */
	launchdRegistryPath?: string;
}

interface LeadLaunchAuthority {
	/** The Lead's own FLYWHEEL_STATE_DIR — the canonical socket derives from it. */
	stateDir: string;
	manifest: LeadRuntimeManifest;
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
	try {
		const authority =
			options.launchdRegistryPath === undefined
				? readProductionAuthority(projectName, leadId, options)
				: readRegistryAuthority(
						leadId,
						options.launchdRegistryPath,
						options.readFile,
					);
		if (!authority) return null;
		return locateLeadWindow(projectName, leadId, {
			stateDir: authority.stateDir,
			manifest: authority.manifest,
			execFn: options.execFn,
		});
	} catch {
		return null;
	}
}

function readProductionAuthority(
	projectName: string,
	leadId: string,
	options: ConfiguredLeadWindowLocatorOptions,
): LeadLaunchAuthority | null {
	const key = `${projectName}-${leadId}`;
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
	if (carrier !== "v2") return null;
	const manifest = JSON.parse(
		options.readFile(join(options.stateDir, "manifests", `${key}.json`)),
	) as LeadRuntimeManifest;
	return { stateDir: options.stateDir, manifest };
}

/** `qa_launchd_label` in scripts/lib/qa-launchd-lead.sh. */
const ROOM_LEAD_LABEL = /^com\.flywheel\.qa\.lead\.slot-[1-9][0-9]*\.(.+)$/;
const V2_WRAPPER = "flywheel-lead-wrapper-v2.sh";

/**
 * Registry row → plist → manifest, every hop cross-checked: exactly one row
 * labelled for this Lead, a Claude (non-Codex) row, plist/manifest/state dir
 * all inside the registry's own directory, the plist's Label and v2 argv bind
 * that exact row and manifest. Manifest identity and the canonical socket are
 * then proven by `locateLeadWindow`, exactly as in production.
 */
function readRegistryAuthority(
	leadId: string,
	registryPath: string,
	readFile: (path: string) => string,
): LeadLaunchAuthority | null {
	if (!isCanonicalAbsolute(registryPath)) return null;
	const root = dirname(registryPath);
	const registry: unknown = JSON.parse(readFile(registryPath));
	if (!Array.isArray(registry)) return null;
	const rows = registry.filter(
		(row): row is Record<string, unknown> =>
			typeof row === "object" &&
			row !== null &&
			typeof (row as { label?: unknown }).label === "string" &&
			ROOM_LEAD_LABEL.exec((row as { label: string }).label)?.[1] === leadId,
	);
	if (rows.length !== 1) return null;
	const row = rows[0]!;
	const { label, plist: plistPath, manifest: manifestPath } = row;
	if (row.carrier !== undefined && row.carrier !== null) return null;
	if (
		typeof label !== "string" ||
		!isInside(root, plistPath) ||
		!isInside(root, manifestPath)
	)
		return null;
	const plist = readFile(plistPath);
	const argv = plistProgramArguments(plist);
	const stateDir = plistString(plist, "FLYWHEEL_STATE_DIR");
	if (
		plistString(plist, "Label") !== label ||
		argv?.length !== 2 ||
		!isCanonicalAbsolute(argv[0]!) ||
		basename(argv[0]!) !== V2_WRAPPER ||
		argv[1] !== manifestPath ||
		!isInside(root, stateDir)
	)
		return null;
	return {
		stateDir,
		manifest: JSON.parse(readFile(manifestPath)) as LeadRuntimeManifest,
	};
}

function isCanonicalAbsolute(path: string): boolean {
	return isAbsolute(path) && normalize(path) === path && !path.endsWith("/");
}

function isInside(root: string, path: unknown): path is string {
	return (
		typeof path === "string" &&
		isCanonicalAbsolute(path) &&
		path.startsWith(`${root}/`)
	);
}

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/** The five entities `qa_launchd_xml_escape` writes; anything else is refused. */
function xmlText(raw: string): string | undefined {
	if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) return undefined;
	return raw.replace(
		/&(amp|lt|gt|quot|apos);/g,
		(_, name: string) => XML_ENTITIES[name]!,
	);
}

/** The single `<key>K</key><string>…</string>` value; duplicates are refused. */
function plistString(plist: string, key: string): string | undefined {
	const matches = [
		...plist.matchAll(
			new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g"),
		),
	];
	return matches.length === 1 ? xmlText(matches[0]![1]!) : undefined;
}

function plistProgramArguments(plist: string): string[] | undefined {
	const arrays = [
		...plist.matchAll(
			/<key>ProgramArguments<\/key>\s*<array>((?:\s*<string>[^<]*<\/string>)*)\s*<\/array>/g,
		),
	];
	if (arrays.length !== 1) return undefined;
	const values = [...arrays[0]![1]!.matchAll(/<string>([^<]*)<\/string>/g)].map(
		(match) => xmlText(match[1]!),
	);
	return values.every((value) => value !== undefined)
		? (values as string[])
		: undefined;
}
