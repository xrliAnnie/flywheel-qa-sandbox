export const RUNNER_MEMORY_ID_MAX_LENGTH = 128;

/** Encode a safe identifier injectively on case-insensitive filesystems. */
export function encodeMemoryPathComponent(name: string): string {
	const lower = name.toLowerCase();
	if (name === lower && !name.includes("--")) return name;
	let uppercaseMask = 0n;
	for (let index = 0; index < name.length; index += 1) {
		if (name[index] !== lower[index]) {
			uppercaseMask |= 1n << BigInt(index);
		}
	}
	return `${lower}--${uppercaseMask.toString(16)}`;
}

/** Reverse a component produced by {@link encodeMemoryPathComponent}. */
export function decodeMemoryPathComponent(encoded: string): string {
	const separator = encoded.lastIndexOf("--");
	if (separator === -1) return encoded;
	const base = encoded.slice(0, separator);
	const maskHex = encoded.slice(separator + 2);
	const uppercaseMask = BigInt(`0x${maskHex}`);
	return Array.from(base, (character, index) =>
		(uppercaseMask & (1n << BigInt(index))) !== 0n
			? character.toUpperCase()
			: character,
	).join("");
}
