import { createHash } from "node:crypto";

export function isStuckEligibleStatus(status: string): boolean {
	return status === "running";
}

export function fingerprintOutput(output: string): string {
	return createHash("sha256").update(output).digest("hex").slice(0, 16);
}

export function sigFingerprint(signature: string): string {
	return `sig:${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

export function detectInputBoxPresent(output: string): boolean {
	const tail = output
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(-10);
	const promptLine = /^\s*(❯|>\s|[│|]\s*>\s?)/;
	const boxBorder = /(─{8,}|[╭╰╮╯]─*)/;
	return (
		tail.some((line) => promptLine.test(line)) &&
		tail.some((line) => boxBorder.test(line))
	);
}
