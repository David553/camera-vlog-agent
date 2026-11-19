// eval 骨架：对 dataset 逐条跑 打标签(tag F1) + 高光选取(window IoU)，出报告。
// 视觉调用走 gateway 帧缓存，重复 eval 零上传。
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DIRS, ROOT } from "./config.ts";
import { analyzeSegment, pickWindow } from "./media.ts";
import { tagF1, windowIoU } from "./metrics.ts";
import { loadIndex, loadSegments } from "./store.ts";
import { tagSegment } from "./tagging.ts";

interface Entry {
	id: string;
	tags: string[];
	window: [number, number];
}

const ds = JSON.parse(await readFile(path.join(ROOT, "evals", "dataset.json"), "utf-8")) as { entries: Entry[] };
const segments = await loadSegments();
const index = await loadIndex();
const rows: { id: string; f1: number; iou: number; predTags: string[]; window: [number, number] }[] = [];

for (const e of ds.entries) {
	let seg = segments.find((s) => s.id === e.id);
	if (!seg || !seg.activeWindows) {
		const file = index.clips.find((c) => c.id === e.id)?.file ?? path.join(DIRS.clips, `${e.id}.mp4`);
		seg = await analyzeSegment(file, "eval");
	}
	const tagRes = await tagSegment(seg);
	const w = pickWindow(seg);
	const row = {
		id: e.id,
		f1: tagF1(tagRes.tags, e.tags),
		iou: windowIoU([w.start, w.end], e.window),
		predTags: tagRes.tags,
		window: [Number(w.start.toFixed(2)), Number(w.end.toFixed(2))] as [number, number],
	};
	rows.push(row);
	console.log(`${e.id}  F1=${row.f1.toFixed(2)}  IoU=${row.iou.toFixed(2)}  keep=${row.window[0]}-${row.window[1]}s  tags=${row.predTags.join("/")}`);
}

const macro = (k: "f1" | "iou") => rows.reduce((s, r) => s + r[k], 0) / rows.length;
const report = { time: new Date().toISOString(), datasetVersion: ds.version ?? 0, macroF1: macro("f1"), macroIoU: macro("iou"), rows };
await writeFile(path.join(ROOT, "evals", "report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`\nmacro F1=${report.macroF1.toFixed(2)}  macro IoU=${report.macroIoU.toFixed(2)}  → evals/report.json`);