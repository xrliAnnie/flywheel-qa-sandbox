import { basename, isAbsolute, normalize } from "node:path";
import { readProcComparison } from "./qa-fly-2456-proc-comparison.mjs";

function parse(path, roots) {
	const rows = new Map();
	for (const line of readProcComparison(path).trim().split("\n")) {
		const m = line.match(
			/^\s*(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/,
		);
		if (!m) throw new Error("invalid ps row");
		const pid = Number(m[1]),
			ppid = Number(m[2]),
			lstart = m[3].replace(/\s+/g, " "),
			command = m[4];
		if (
			!Number.isSafeInteger(pid) ||
			pid <= 0 ||
			!Number.isSafeInteger(ppid) ||
			rows.has(pid) ||
			!Number.isFinite(Date.parse(lstart)) ||
			command.includes("\0")
		)
			throw new Error("invalid process identity");
		rows.set(pid, { pid, ppid, lstart, command });
	}
	const within = (p) =>
		isAbsolute(p) &&
		normalize(p) === p &&
		roots.some((root) => p === root || p.startsWith(`${root}/`));
	function classify(row, seen = new Set()) {
		if (seen.has(row.pid)) throw new Error("cyclic process ancestry");
		seen.add(row.pid);
		const parent = rows.get(row.ppid);
		if (parent && Date.parse(parent.lstart) > Date.parse(row.lstart))
			throw new Error("parent identity newer than child");
		const inherited = parent ? classify(parent, seen) : false;
		const words = row.command.split(/\s+/);
		// ps does not preserve argv quoting: accept only executable or an immediate
		// interpreter script path. Arbitrary arguments are not ownership evidence.
		const direct =
			within(words[0]) ||
			(/^(node|nodejs|bash|zsh|sh|python3?)$/.test(basename(words[0])) &&
				words[1] &&
				within(words[1]));
		return Boolean(direct || inherited);
	}
	for (const row of rows.values())
		row.attribution = classify(row) ? "SLOT" : "NONSLOT";
	return new Map(
		[...rows.values()].map((row) => [`${row.pid}|${row.lstart}`, row]),
	);
}
export function procAttribution({
	baselinePath,
	afterPath,
	slotDir,
	checkout,
	mode = "live",
}) {
	try {
		if (
			!["live", "post-teardown"].includes(mode) ||
			![slotDir, checkout].every(
				(p) =>
					typeof p === "string" &&
					isAbsolute(p) &&
					p !== "/" &&
					!p.endsWith("/") &&
					!p.includes("..") &&
					!/\s/.test(p),
			)
		)
			throw new Error("invalid attribution configuration");
		const before = parse(baselinePath, [slotDir, checkout]),
			after = parse(afterPath, [slotDir, checkout]);
		const removed = [...before]
			.filter(([id]) => !after.has(id))
			.map(([, row]) => row);
		const added = [...after]
			.filter(([id]) => !before.has(id))
			.map(([, row]) => row);
		const unexplained = removed.filter((row) => row.attribution === "NONSLOT");
		const status =
			mode === "live" && added.some((row) => row.attribution === "NONSLOT")
				? "fail"
				: unexplained.length
					? "needs-attribution"
					: "pass";
		return { status, mode, removed, added, unexplained };
	} catch (error) {
		return { status: "fail", reason: error.message };
	}
}
