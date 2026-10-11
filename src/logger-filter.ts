export function setupLogFilter(): void {
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		const first = String(args[0] || "");
		if (
			first.includes("All retry attempts have exhausted") ||
			first.includes("Request cannot be retried")
		) {
			return;
		}
		originalWarn(...args);
	};
}
