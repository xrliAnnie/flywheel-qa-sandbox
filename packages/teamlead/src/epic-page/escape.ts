export function escapeMarkdownTableCell(value: string): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]+/g, " ")
		.replace(/\[/g, "&#91;")
		.replace(/\]/g, "&#93;")
		.replace(/\(/g, "&#40;")
		.replace(/\)/g, "&#41;");
}
