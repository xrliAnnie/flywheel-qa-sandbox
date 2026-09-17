import { isAbsolute, normalize } from "node:path";
import type { AuthorityConfig } from "./authority-config.js";

type Config = Pick<
	AuthorityConfig,
	| "serviceUid"
	| "serviceGid"
	| "ingressGid"
	| "launcher"
	| "node"
	| "entry"
	| "ingressSocket"
	| "authoritySocket"
>;

/** Pure deployment artifact renderer. Installation must independently prove
 * root ownership, dedicated account/group membership and the signed QA receipt. */
export function renderAuthorityLaunchd(
	config: Config,
	policyPath: string,
): string {
	const paths = [
		config.launcher.path,
		config.node.path,
		config.entry.path,
		policyPath,
		config.ingressSocket,
		config.authoritySocket,
	];
	if (
		paths.some(
			(p) =>
				!isAbsolute(p) ||
				normalize(p) !== p ||
				[...p].some((char) => char.charCodeAt(0) < 32),
		) ||
		new Set(paths).size !== paths.length ||
		[config.serviceUid, config.serviceGid, config.ingressGid].some(
			(id) => !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff,
		) ||
		config.serviceGid === config.ingressGid ||
		config.serviceGid === 80 ||
		config.ingressGid === 80
	)
		throw Error("authority_launchd_invalid");
	const xmlEscape = (s: string) =>
		s
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&apos;");
	const socket = (
		path: string,
		uid: number,
		gid: number,
		mode: number,
	) => `<dict>
<key>SockFamily</key><string>Unix</string>
<key>SockType</key><string>stream</string>
<key>SockPassive</key><true/>
<key>SockPathName</key><string>${xmlEscape(path)}</string>
<key>SockPathOwner</key><integer>${uid}</integer>
<key>SockPathGroup</key><integer>${gid}</integer>
<key>SockPathMode</key><integer>${mode}</integer>
</dict>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.flywheel.xhs-authority</string>
<key>ProgramArguments</key><array>${[config.launcher.path, config.node.path, config.entry.path, "--config", policyPath].map((p) => `<string>${xmlEscape(p)}</string>`).join("")}</array>
<key>UserName</key><string>_flywheel_xhs</string>
<key>GroupName</key><string>_flywheel_xhs</string>
<key>Umask</key><integer>63</integer>
<key>ProcessType</key><string>Background</string>
<key>WorkingDirectory</key><string>/</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string><key>LANG</key><string>C</string><key>LC_ALL</key><string>C</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>Sockets</key><dict>
<key>Ingress</key>${socket(config.ingressSocket, 0, config.ingressGid, 0o660)}
<key>Authority</key>${socket(config.authoritySocket, config.serviceUid, config.serviceGid, 0o600)}
</dict>
</dict></plist>
`;
}
