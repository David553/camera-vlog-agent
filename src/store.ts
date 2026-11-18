// segments.json / index.json / 云端调用台账
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CLOUD_LOG, DIRS, INDEX_FILE, SEGMENTS_FILE } from "./config.ts";
import type { SegmentAnalysis } from "./media.ts";

export interface ClipEntry {
	id: string;
	file: string;
	startTime: string;
	duration: number;
	tags: string[];
	description: string;
	provisional: boolean;
	tagModel: string;
	motionScore: number;
	uploadedFrames: string[];
}

export interface VlogEntry {
	file: string;
	createdAt: string;
	clips: string[];
	duration: number;
}

export interface IndexData {
	clips: ClipEntry[];
	vlogs: VlogEntry[];
}

export async function ensureDirs(): Promise<void> {
	for (const dir of Object.values(DIRS)) await mkdir(dir, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(file, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

export async function loadSegments(): Promise<SegmentAnalysis[]> {
	return readJson(SEGMENTS_FILE, []);
}

export async function saveSegments(segments: SegmentAnalysis[]): Promise<void> {
	await writeFile(SEGMENTS_FILE, JSON.stringify(segments, null, 2), "utf-8");
}

export async function loadIndex(): Promise<IndexData> {
	return readJson(INDEX_FILE, { clips: [], vlogs: [] });
}

export async function saveIndex(index: IndexData): Promise<void> {
	await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

export interface CloudCall {
	time: string;
	purpose: string;
	model: string;
	endpoint: string;
	imagesUploaded: string[];
	note: string;
	role?: string;
	tokensIn?: number;
	tokensOut?: number;
	latencyMs?: number;
	attempt?: number;
	cacheHit?: boolean;
}

export async function logCloudCall(call: CloudCall): Promise<void> {
	const calls = await readJson<CloudCall[]>(CLOUD_LOG, []);
	calls.push(call);
	await writeFile(CLOUD_LOG, JSON.stringify(calls, null, 2), "utf-8");
}

export async function loadCloudCalls(): Promise<CloudCall[]> {
	return readJson(CLOUD_LOG, []);
}