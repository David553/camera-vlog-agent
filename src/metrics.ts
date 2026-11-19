export function tagF1(pred: string[], gt: string[]): number {
	const p = new Set(pred);
	const g = new Set(gt);
	const inter = [...p].filter((t) => g.has(t)).length;
	return p.size + g.size === 0 ? 1 : (2 * inter) / (p.size + g.size);
}

export function windowIoU(a: [number, number], b: [number, number]): number {
	const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
	const union = Math.max(a[1], b[1]) - Math.min(a[0], b[0]);
	return union > 0 ? inter / union : 0;
}