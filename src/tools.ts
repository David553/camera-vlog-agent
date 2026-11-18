// pi-agent 工具集：查分段 / 打标签 / 查片段 / 合成 vlog / 实时抽帧
import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { DIRS } from "./config.ts";
import { analyzeSegment, editVlog, grabLiveFrame, type EditPiece } from "./media.ts";
import { loadIndex, loadSegments, saveIndex, type ClipEntry } from "./store.ts";
import { tagSegment } from "./tagging.ts";

function textResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: {} };
}

const listSegments: AgentTool<any> = {
	name: "list_segments",
	label: "List Segments",
	description: "列出录制分段及本地运动侦测结果（motion=true 表示画面有变化）。传 run_id 只看指定批次",
	parameters: obj({ run_id: opt(str({ description: "录制批次 id，可选" })) }),
	execute: async (_toolCallId, params) => {
		const [allSegments, index] = await Promise.all([loadSegments(), loadIndex()]);
		const segments = params.run_id ? allSegments.filter((s) => s.runId === params.run_id) : allSegments;
		const tagged = new Set(index.clips.map((c) => c.id));
		return textResult(
			segments.map((s) => ({
				id: s.id,
				startTime: s.startTime,
				duration: s.duration,
				motion: s.motion,
				motionScore: s.motionScore,
				activeFraction: s.activeFraction,
				brightness: s.brightness,
				tagged: tagged.has(s.id),
			})),
		);
	},
};

const tagClip: AgentTool<any> = {
	name: "tag_clip",
	label: "Tag Clip",
	description: "给一个有运动的分段打标签并存入 clips/。配置视觉模型时会上传关键帧图片；否则仅用统计文本推断（provisional=true）。force=true 可重新打标签（如升级为看图标签）",
	parameters: obj({
		segment_id: str({ description: "list_segments 返回的 id" }),
		force: opt(bool({ description: "已打标签时是否强制重打，默认 false" })),
	}),
	executionMode: "sequential",
	execute: async (_toolCallId, params) => {
		const segments = await loadSegments();
		const seg = segments.find((s) => s.id === params.segment_id);
		if (!seg) throw new Error(`分段不存在: ${params.segment_id}`);
		const index = await loadIndex();
		const existing = index.clips.find((c) => c.id === seg.id);
		if (existing && !params.force) return textResult({ alreadyTagged: true, clip: existing });
		const result = await tagSegment(seg);
		const clipFile = path.join(DIRS.clips, `clip_${seg.id}.mp4`);
		if (!existing) await copyFile(seg.file, clipFile);
		const clip: ClipEntry = {
			id: seg.id,
			file: clipFile,
			startTime: seg.startTime,
			duration: seg.duration,
			tags: result.tags,
			description: result.description,
			provisional: result.provisional,
			tagModel: result.tagModel,
			motionScore: seg.motionScore,
			uploadedFrames: result.uploadedFrames,
		};
		if (existing) index.clips[index.clips.indexOf(existing)] = clip;
		else index.clips.push(clip);
		await saveIndex(index);
		return textResult({ clipId: clip.id, tags: clip.tags, description: clip.description, provisional: clip.provisional });
	},
};

const listClips: AgentTool<any> = {
	name: "list_clips",
	label: "List Clips",
	description: "列出已打标签的片段，可按标签过滤",
	parameters: obj({ tag: opt(str({ description: "标签关键词，可选" })) }),
	execute: async (_toolCallId, params) => {
		const index = await loadIndex();
		const clips = params.tag ? index.clips.filter((c) => c.tags.some((t) => t.includes(params.tag))) : index.clips;
		return textResult(clips);
	},
};

const buildVlog: AgentTool<any> = {
	name: "build_vlog",
	label: "Build Vlog",
	description: "把已打标签的片段精剪合成 vlog：每段只保留动作最精彩的窗口，加片头片尾、字幕卡、淡入淡出",
	parameters: obj({
		tag: opt(str({ description: "只选含此标签的片段，可选" })),
		max_clips: opt(num({ description: "最多选几个片段，默认 12" })),
	}),
	executionMode: "sequential",
	execute: async (_toolCallId, params) => {
		const index = await loadIndex();
		let clips = params.tag ? index.clips.filter((c) => c.tags.some((t) => t.includes(params.tag))) : index.clips;
		clips = [...clips].sort((a, b) => a.startTime.localeCompare(b.startTime)).slice(0, params.max_clips ?? 12);
		if (clips.length === 0) throw new Error("没有符合条件的已打标签片段");

		const segments = await loadSegments();
		const pieces: EditPiece[] = [];
		for (const clip of clips) {
			let seg = segments.find((s) => s.id === clip.id);
			if (!seg || !seg.activeWindows) seg = await analyzeSegment(clip.file, "edit");
			const windows = seg.activeWindows ?? [];
			let start: number;
			let end: number;
			if (windows.length > 0) {
				const best = windows.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
				start = best.start;
				end = best.end;
			} else {
				start = Math.max(0, seg.peakTime - 2.5);
				end = Math.min(seg.duration, seg.peakTime + 2.5);
			}
			if (end - start < 2.5) {
				const mid = (start + end) / 2;
				start = Math.max(0, mid - 1.25);
				end = Math.min(seg.duration, start + 2.5);
			}
			if (end - start > 8) end = start + 8;
			pieces.push({
				file: clip.file,
				start,
				end,
				cardText: `${clip.tags.join(" · ")}\n${clip.startTime}`,
				subtitle: clip.description,
			});
		}

		const date = clips[0].startTime.slice(0, 10);
		const out = path.join(DIRS.vlogs, `vlog_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.mp4`);
		const { duration } = await editVlog(
			pieces,
			out,
			`家庭 Vlog\n${date}\nAI 自动剪辑`,
			"谢谢观看\npi-agent × qwen3-vl-plus",
		);
		index.vlogs.push({ file: out, createdAt: new Date().toISOString(), clips: clips.map((c) => c.id), duration });
		await saveIndex(index);
		return textResult({
			vlog: out,
			duration,
			edits: pieces.map((p, i) => ({ clip: clips[i].id, keep: `${p.start.toFixed(1)}s-${p.end.toFixed(1)}s`, tags: clips[i].tags })),
		});
	},
};

const grabFrame: AgentTool<any> = {
	name: "grab_frame",
	label: "Grab Frame",
	description: "从摄像头实时抽一帧 JPEG 存到 frames/，返回路径",
	parameters: obj({}),
	execute: async () => textResult({ frame: await grabLiveFrame() }),
};

export function buildTools(): AgentTool<any>[] {
	return [listSegments, tagClip, listClips, buildVlog, grabFrame];
}