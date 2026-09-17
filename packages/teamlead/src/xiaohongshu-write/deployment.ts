import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize } from "node:path";
import {
	parseAuthorityConfig,
	verifyProviderConfigBinding,
} from "./authority-config.js";

type PathRequirement = {
	path: string;
	uid: number;
	gid: number;
	mode: number;
	sha256?: string;
};
const xml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
function plistValue(value: unknown): string {
	if (typeof value === "string") return `<string>${xml(value)}</string>`;
	if (typeof value === "number" && Number.isSafeInteger(value))
		return `<integer>${value}</integer>`;
	if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
	if (Array.isArray(value))
		return `<array>${value.map(plistValue).join("")}</array>`;
	if (value && typeof value === "object")
		return `<dict>${Object.entries(value)
			.map(([key, item]) => `<key>${xml(key)}</key>${plistValue(item)}`)
			.join("")}</dict>`;
	throw Error();
}
/** Offline rendering only. This does not install, chmod, create identities,
 * read secrets, mint acceptance, or start launchd. Requirements need host proof. */
export function renderAuthorityDeployment(
	policyRaw: string,
	providerRaw: string,
	policyPath: string,
) {
	try {
		const config = parseAuthorityConfig(policyRaw);
		const provider = verifyProviderConfigBinding(config, providerRaw);
		const digest = (raw: string) =>
			createHash("sha256").update(raw).digest("hex");
		if (digest(providerRaw) !== config.providerConfig.sha256) throw Error();
		const directories = new Map<string, PathRequirement>();
		const files = new Map<string, PathRequirement>();
		const checkPath = (path: string) => {
			if (
				!isAbsolute(path) ||
				normalize(path) !== path ||
				[...path].some((char) => char.charCodeAt(0) < 32)
			)
				throw Error();
		};
		const put = (
			target: Map<string, PathRequirement>,
			item: PathRequirement,
		) => {
			checkPath(item.path);
			const prior = target.get(item.path);
			if (prior && JSON.stringify(prior) !== JSON.stringify(item))
				throw Error();
			target.set(item.path, item);
		};
		const rootParents = (start: string) => {
			for (let path = start; ; path = dirname(path)) {
				put(directories, { path, uid: 0, gid: 0, mode: 0o755 });
				if (dirname(path) === path) break;
			}
		};
		const privateDirectory = (start: string) => {
			let path = start;
			for (;;) {
				put(directories, {
					path,
					uid: config.serviceUid,
					gid: config.serviceGid,
					mode: 0o700,
				});
				if (
					path === config.stateRoot ||
					!path.startsWith(`${config.stateRoot}/`)
				)
					break;
				path = dirname(path);
			}
			rootParents(dirname(path));
		};
		for (const path of [
			config.stateRoot,
			config.artifactRoot,
			provider.epochPath,
			provider.journalPath,
			provider.mediaRoot,
			provider.profileRoot,
			dirname(provider.providerSocket),
		])
			privateDirectory(path);
		for (const path of [
			config.ledgerPath,
			config.botTokenPath,
			config.permitKeyPath,
		]) {
			privateDirectory(dirname(path));
			put(files, {
				path,
				uid: config.serviceUid,
				gid: config.serviceGid,
				mode: 0o600,
			});
		}
		const privateParent = dirname(config.authoritySocket);
		put(directories, {
			path: privateParent,
			uid: 0,
			gid: config.serviceGid,
			mode: 0o750,
		});
		rootParents(dirname(privateParent));
		rootParents(dirname(config.ingressSocket));
		for (const pin of [
			config.node,
			config.peerHelper,
			config.launcher,
			config.boundaryProbe,
			provider.providerBinary,
			provider.browser,
			provider.guardian,
			provider.ffmpeg,
			provider.ffprobe,
		]) {
			rootParents(dirname(pin.path));
			put(files, {
				path: pin.path,
				uid: 0,
				gid: 0,
				mode: 0o755,
				sha256: pin.sha256,
			});
		}
		for (const item of [
			{
				path: config.entry.path,
				uid: 0,
				gid: 0,
				mode: 0o644,
				sha256: config.entry.sha256,
			},
			{
				path: policyPath,
				uid: 0,
				gid: 0,
				mode: 0o644,
				sha256: digest(policyRaw),
			},
			{
				path: config.providerConfig.path,
				uid: 0,
				gid: 0,
				mode: 0o644,
				sha256: digest(providerRaw),
			},
			{ path: config.acceptancePath, uid: 0, gid: 0, mode: 0o644 },
			{ path: provider.acceptancePath, uid: 0, gid: 0, mode: 0o644 },
		]) {
			rootParents(dirname(item.path));
			put(files, item);
		}
		for (const path of directories.keys()) if (files.has(path)) throw Error();
		const sockets = {
			Ingress: {
				SockPathName: config.ingressSocket,
				SockPathOwner: 0,
				SockPathGroup: config.ingressGid,
				SockPathMode: 0o660,
				SockType: "stream",
				SockPassive: true,
			},
			Authority: {
				SockPathName: config.authoritySocket,
				SockPathOwner: 0,
				SockPathGroup: config.serviceGid,
				SockPathMode: 0o660,
				SockType: "stream",
				SockPassive: true,
			},
		};
		for (const socket of Object.values(sockets)) {
			checkPath(socket.SockPathName);
			if (
				files.has(socket.SockPathName) ||
				directories.has(socket.SockPathName)
			)
				throw Error();
		}
		const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(
			{
				Label: "com.flywheel.xhs-authority",
				ProgramArguments: [
					config.launcher.path,
					config.node.path,
					config.entry.path,
					"--config",
					policyPath,
				],
				UserName: "_flywheel_xhs",
				GroupName: "_flywheel_xhs",
				Umask: 0o077,
				ProcessType: "Background",
				WorkingDirectory: "/",
				RunAtLoad: true,
				KeepAlive: true,
				Sockets: sockets,
			},
		)}</plist>\n`;
		const plistPath = "/Library/LaunchDaemons/com.flywheel.xhs-authority.plist";
		rootParents(dirname(plistPath));
		put(files, {
			path: plistPath,
			uid: 0,
			gid: 0,
			mode: 0o644,
			sha256: digest(plist),
		});
		for (const path of directories.keys()) if (files.has(path)) throw Error();
		return {
			schemaVersion: 1,
			configDigest: digest(policyRaw),
			providerConfigDigest: digest(providerRaw),
			plistPath: "/Library/LaunchDaemons/com.flywheel.xhs-authority.plist",
			plist,
			principal: {
				name: "_flywheel_xhs",
				uid: config.serviceUid,
				gid: config.serviceGid,
				modelUid: config.modelUid,
				ingressGid: config.ingressGid,
			},
			directories: [...directories.values()].sort((a, b) =>
				a.path.localeCompare(b.path),
			),
			files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
		};
	} catch {
		throw Error("authority_deployment_unavailable");
	}
}
