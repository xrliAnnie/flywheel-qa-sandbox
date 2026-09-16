import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const denied4 = new BlockList();
// IANA special-purpose ranges; deliberately no protocol-specific exceptions.
for (const [address, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	denied4.addSubnet(address, bits, "ipv4");
// Azure host virtual IP is public-shaped but represents privileged host services.
denied4.addAddress("168.63.129.16", "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const denied6 = new BlockList();
for (const [address, bits] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const)
	denied6.addSubnet(address, bits, "ipv6");
const reject = () => new Error("browser_egress_denied");
function publicAddress(address: string, family: number): boolean {
	if (isIP(address) !== family || address.includes("%")) return false;
	if (family === 4) return !denied4.check(address, "ipv4");
	return (
		family === 6 &&
		global6.check(address, "ipv6") &&
		!denied6.check(address, "ipv6")
	);
}
export interface BrowserEgressAddress {
	address: string;
	family: number;
}
export interface BrowserEgressPolicy {
	/** Trusted deployment sources only. Ports must include every Bridge/admin/CDP listener. */
	protectedPorts: readonly number[];
	localQaTargets: readonly { origin: string; address: "127.0.0.1" | "::1" }[];
}
export interface BrowserEgressTarget {
	url: string;
	hostname: string;
	address: string;
	family: 4 | 6;
	port: number;
}
/** Resolve afresh for each connection/hop. Consumer MUST connect to address,
 * never resolve hostname again; hostname is only HTTP Host/TLS SNI. */
export async function resolveBrowserEgressTarget(
	raw: string,
	options: {
		policy?: BrowserEgressPolicy;
		lookup?: (hostname: string) => Promise<BrowserEgressAddress[]>;
		signal?: AbortSignal;
	} = {},
): Promise<BrowserEgressTarget> {
	if (
		typeof raw !== "string" ||
		raw.length > 8192 ||
		[...raw].some(
			(char) =>
				char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === "\\",
		)
	)
		throw reject();
	if (!/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(raw)) throw reject();
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw reject();
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		!url.hostname
	)
		throw reject();
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
	if (port < 1 || port > 65535 || options.signal?.aborted) throw reject();
	const policy = options.policy;
	if (policy) {
		if (
			policy.localQaTargets.length > 32 ||
			(policy.localQaTargets.length && !policy.protectedPorts.length) ||
			policy.protectedPorts.some(
				(p) => !Number.isInteger(p) || p < 1 || p > 65535,
			)
		)
			throw reject();
		const origins = new Set<string>();
		for (const target of policy.localQaTargets) {
			let origin: URL;
			try {
				origin = new URL(target.origin);
			} catch {
				throw reject();
			}
			const localPort = Number(
				origin.port || (origin.protocol === "https:" ? 443 : 80),
			);
			if (
				origin.origin !== target.origin ||
				!["http:", "https:"].includes(origin.protocol) ||
				!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
				!["127.0.0.1", "::1"].includes(target.address) ||
				policy.protectedPorts.includes(localPort) ||
				origins.has(target.origin)
			)
				throw reject();
			if (
				origin.hostname !== "localhost" &&
				origin.hostname.replace(/^\[|\]$/g, "") !== target.address
			)
				throw reject();
			origins.add(target.origin);
		}
		const local = policy.localQaTargets.find(
			(target) => target.origin === url.origin,
		);
		if (local)
			return Object.freeze({
				url: url.href,
				hostname,
				address: local.address,
				family: local.address === "::1" ? 6 : 4,
				port,
			});
	}
	const family = isIP(hostname);
	let addresses: BrowserEgressAddress[];
	try {
		addresses = family
			? [{ address: hostname, family }]
			: await new Promise<BrowserEgressAddress[]>((resolve, deny) => {
					const stop = () => {
						cleanup();
						deny(reject());
					};
					const timer = setTimeout(stop, 15_000);
					const cleanup = () => {
						clearTimeout(timer);
						options.signal?.removeEventListener("abort", stop);
					};
					options.signal?.addEventListener("abort", stop, { once: true });
					if (options.signal?.aborted) {
						stop();
						return;
					}
					Promise.resolve()
						.then(() => {
							if (options.signal?.aborted) throw reject();
							return (
								options.lookup ??
								((name) => dnsLookup(name, { all: true, verbatim: true }))
							)(hostname);
						})
						.then(
							(rows) => {
								cleanup();
								resolve(rows);
							},
							() => {
								cleanup();
								deny(reject());
							},
						);
				});
	} catch {
		throw reject();
	}
	if (
		options.signal?.aborted ||
		!Array.isArray(addresses) ||
		addresses.length === 0 ||
		addresses.length > 64 ||
		addresses.some((row) => !publicAddress(row.address, row.family))
	)
		throw reject();
	const selected = addresses[0]!;
	return Object.freeze({
		url: url.href,
		hostname,
		address: selected.address,
		family: selected.family as 4 | 6,
		port,
	});
}
