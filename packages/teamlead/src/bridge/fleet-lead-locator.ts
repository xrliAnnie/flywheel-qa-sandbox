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
	const plist = parseLaunchdPlist(readFile(plistPath));
	if (!plist) return null;
	const argv = plist.ProgramArguments;
	const env = plist.EnvironmentVariables;
	const stateDir = isDict(env) ? env.FLYWHEEL_STATE_DIR : undefined;
	if (
		plist.Label !== label ||
		!Array.isArray(argv) ||
		argv.length !== 2 ||
		typeof argv[0] !== "string" ||
		!isCanonicalAbsolute(argv[0]) ||
		basename(argv[0]) !== V2_WRAPPER ||
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

type PlistValue = string | boolean | number | PlistValue[] | PlistDict;
interface PlistDict {
	[key: string]: PlistValue;
}

function isDict(value: PlistValue | undefined): value is PlistDict {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PLIST_PROLOGUE =
	/^\s*<\?xml version="1\.0" encoding="UTF-8"\?>\s*(?:<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*)?<plist version="1\.0">/;
const PLIST_TOKEN =
	/<(\/?)(dict|key|string|array|integer|true|false)(\/?)>|([^<]+)/y;
const PLIST_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Strict reader for the launchd plist subset qa-launchd-lead.sh renders: one
 * top-level dict of dict/array/string/integer/true/false, keys spelled
 * literally (no entities), no duplicate key at any level, nothing else —
 * comments, CDATA, attributes and trailing content are refused, so the value
 * we act on is the one launchd reads.
 */
function parseLaunchdPlist(xml: string): PlistDict | undefined {
	const prologue = PLIST_PROLOGUE.exec(xml);
	if (!prologue) return undefined;
	const end = xml.lastIndexOf("</plist>");
	if (end < 0 || xml.slice(end + "</plist>".length).trim() !== "")
		return undefined;
	const tokens: Array<{
		tag?: string;
		close?: boolean;
		empty?: boolean;
		text?: string;
	}> = [];
	const body = xml.slice(prologue[0].length, end);
	PLIST_TOKEN.lastIndex = 0;
	while (PLIST_TOKEN.lastIndex < body.length) {
		const match = PLIST_TOKEN.exec(body);
		if (!match) return undefined;
		if (match[4] !== undefined) tokens.push({ text: match[4] });
		else if (match[1] && match[3]) return undefined;
		else tokens.push({ tag: match[2], close: !!match[1], empty: !!match[3] });
	}
	let at = 0;
	const skipBlank = () => {
		while (tokens[at]?.text !== undefined && tokens[at]!.text!.trim() === "")
			at++;
	};
	const leaf = (tag: string): string | undefined => {
		const text = tokens[at]?.text;
		if (text !== undefined) at++;
		const close = tokens[at];
		if (close?.tag !== tag || !close.close) return undefined;
		at++;
		return text ?? "";
	};
	const value = (): PlistValue | undefined => {
		skipBlank();
		const open = tokens[at++];
		if (!open?.tag || open.close) return undefined;
		if (open.empty) {
			if (open.tag === "true") return true;
			if (open.tag === "false") return false;
			return open.tag === "string" ? "" : undefined;
		}
		switch (open.tag) {
			case "string": {
				const raw = leaf("string");
				return raw === undefined ? undefined : xmlText(raw);
			}
			case "integer": {
				const raw = leaf("integer");
				return raw !== undefined && /^-?\d{1,15}$/.test(raw)
					? Number(raw)
					: undefined;
			}
			case "array": {
				const items: PlistValue[] = [];
				for (;;) {
					skipBlank();
					if (tokens[at]?.tag === "array" && tokens[at]!.close) {
						at++;
						return items;
					}
					const item = value();
					if (item === undefined) return undefined;
					items.push(item);
				}
			}
			case "dict": {
				const dict: PlistDict = Object.create(null);
				for (;;) {
					skipBlank();
					const next = tokens[at++];
					if (next?.tag === "dict" && next.close) return dict;
					if (next?.tag !== "key" || next.close || next.empty) return undefined;
					const key = leaf("key");
					if (key === undefined || !PLIST_KEY.test(key) || key in dict)
						return undefined;
					const item = value();
					if (item === undefined) return undefined;
					dict[key] = item;
				}
			}
			default:
				return undefined;
		}
	};
	const root = value();
	skipBlank();
	return isDict(root) && at === tokens.length ? root : undefined;
}
