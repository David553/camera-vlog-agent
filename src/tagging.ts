// 打标签：配置了视觉模型就看图打标签；否则用画面统计 + 文本模型推断（标记 provisional）
import { readFile } from "node:fs/promises";
import { frameCacheKey, getGateway, visionConfigured } from "./gateway.ts";
import type { SegmentAnalysis } from "./media.ts";

export interface TagResult {
	tags: string[];
	description: string;
	provisional: boolean;
	tagModel: string;
	uploadedFrames: string[];
}

function extractJson(text: string): { tags?: string[]; description?: string } {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) throw new Error(`模型未返回 JSON: ${text.slice(0, 200)}`);
	return JSON.parse(m[0]);
}

const VISION_PROMPT = (startTime: string) =>
	`这是家庭摄像头在 ${startTime} 录下的片段的关键帧。请输出严格 JSON：{"tags":["3-6个中文标签，如 人物活动/宠物/光线变化/静止画面"],"description":"一句话中文描述画面内容"}。只输出 JSON。`;

async function visionTag(seg: SegmentAnalysis): Promise<TagResult> {
	const frames = seg.keyframes.slice(0, 2);
	const buffers = await Promise.all(frames.map((f) => readFile(f)));
	const prompt = VISION_PROMPT(seg.startTime);
	const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
		{ type: "text", text: prompt },
		...buffers.map((b) => ({ type: "image" as const, data: b.toString("base64"), mimeType: "image/jpeg" })),
	];
	const res = await getGateway().complete(
		"vision",
		{ systemPrompt: "你是画面内容识别助手，只输出 JSON。", messages: [{ role: "user", content, timestamp: Date.now() }] },
		{ purpose: `tag_clip ${seg.id}`, images: frames, cacheKey: frameCacheKey(prompt, buffers) },
	);
	const parsed = extractJson(res.text);
	return {
		tags: parsed.tags ?? [],
		description: parsed.description ?? "",
		provisional: false,
		tagModel: res.modelId,
		uploadedFrames: frames,
	};
}

async function textFallbackTag(seg: SegmentAnalysis): Promise<TagResult> {
	const hour = Number(seg.startTime.slice(11, 13));
	const tags = [
		seg.activeFraction > 0.5 ? "持续活动" : "间歇活动",
		seg.brightness < 50 ? "弱光" : "光线正常",
		hour >= 19 || hour < 6 ? "夜间" : "白天",
	];
	const stats = `时间 ${seg.startTime}，时长 ${seg.duration}s，运动比例 ${(seg.activeFraction * 100).toFixed(0)}%，运动强度 ${seg.motionScore}，平均亮度 ${seg.brightness}/255，画面主色 ${seg.meanColor}`;
	const res = await getGateway().complete(
		"brain",
		{
			systemPrompt: "你是监控画面统计摘要助手。你没有看到画面，只有统计数据。用一句话中文概括可能的场景，不要编造具体人物或物体细节，不超过40字。",
			messages: [{ role: "user", content: stats, timestamp: Date.now() }],
		},
		{ purpose: `tag_clip ${seg.id} (文本推断)`, images: [] },
	);
	const description = res.text.trim();
	return {
		tags,
		description: description || stats,
		provisional: true,
		tagModel: `${res.modelId}(文本推断)`,
		uploadedFrames: [],
	};
}

export async function tagSegment(seg: SegmentAnalysis): Promise<TagResult> {
	return visionConfigured() ? visionTag(seg) : textFallbackTag(seg);
}