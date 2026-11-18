// ffmpeg / go2rtc 进程封装：取流录制、抽帧、合成
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DIRS, FFMPEG, GO2RTC, GO2RTC_API, GO2RTC_CONFIG, PYTHON, PYTHON_PACKAGES, SEGMENT_SECONDS, SUB_STREAM } from "./config.ts";

function run(exe: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(exe, args, { env: env ?? process.env, windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

export async function ensureGo2rtc(): Promise<void> {
	try {
		const res = await fetch(`${GO2RTC_API}/api/streams`, { signal: AbortSignal.timeout(2000) });
		if (res.ok) return;
	} catch {}
	console.log("[go2rtc] 未运行，启动中…");
	const child = spawn(GO2RTC, ["-config", GO2RTC_CONFIG], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			const res = await fetch(`${GO2RTC_API}/api/streams`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) return;
		} catch {}
	}
	throw new Error("go2rtc 启动失败");
}

export async function recordSegments(seconds: number): Promise<string[]> {
	const startedAt = Date.now();
	console.log(`[录制] 从 go2rtc 子码流录制 ${seconds}s，每 ${SEGMENT_SECONDS}s 一段…`);
	const result = await run(FFMPEG, [
		"-hide_banner", "-loglevel", "error",
		"-rtsp_transport", "tcp",
		"-i", SUB_STREAM,
		"-t", String(seconds),
		"-c", "copy",
		"-f", "segment",
		"-segment_time", String(SEGMENT_SECONDS),
		"-reset_timestamps", "1",
		"-strftime", "1",
		path.join(DIRS.segments, "seg_%Y%m%d_%H%M%S.mp4"),
	]);
	if (result.code !== 0) throw new Error(`录制失败: ${result.stderr.slice(-500)}`);
	const files = await readdir(DIRS.segments);
	return files
		.filter((f) => f.startsWith("seg_") && f.endsWith(".mp4"))
		.map((f) => path.join(DIRS.segments, f))
		.filter((f) => startedAt - parseSegTime(f) < (seconds + SEGMENT_SECONDS + 5) * 1000 && parseSegTime(f) >= startedAt - 2000)
		.sort();
}

function parseSegTime(file: string): number {
	const m = path.basename(file).match(/seg_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
	if (!m) return 0;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

export interface SegmentAnalysis {
	id: string;
	runId: string;
	file: string;
	startTime: string;
	frames: number;
	fps: number;
	duration: number;
	width: number;
	height: number;
	motion: boolean;
	motionScore: number;
	activeFraction: number;
	activeWindows: { start: number; end: number }[];
	peakTime: number;
	brightness: number;
	meanColor: string;
	keyframes: string[];
}

export async function analyzeSegment(file: string, runId: string): Promise<SegmentAnalysis> {
	const result = await run(PYTHON, [path.join(import.meta.dirname, "analyze_segment.py"), file, DIRS.frames], {
		...process.env,
		...(PYTHON_PACKAGES ? { PYTHONPATH: PYTHON_PACKAGES } : {}),
	});
	if (result.code !== 0) throw new Error(`分析失败 ${file}: ${result.stderr.slice(-500)}`);
	const data = JSON.parse(result.stdout.trim());
	if (data.error) throw new Error(data.error);
	const m = path.basename(file).match(/seg_(\d{8})_(\d{6})/);
	const startTime = m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)} ${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}` : "";
	return { id: path.basename(file, ".mp4"), runId, startTime, ...data };
}

export async function grabLiveFrame(): Promise<string> {
	const out = path.join(DIRS.frames, `live_${Date.now()}.jpg`);
	const result = await run(FFMPEG, [
		"-hide_banner", "-loglevel", "error",
		"-rtsp_transport", "tcp",
		"-i", SUB_STREAM,
		"-frames:v", "1", "-update", "1", "-y", out,
	]);
	if (result.code !== 0) throw new Error(`抽帧失败: ${result.stderr.slice(-300)}`);
	return out;
}

export async function concatVlog(files: string[], out: string): Promise<void> {
	const listFile = path.join(DIRS.logs, `concat_${Date.now()}.txt`);
	await writeFile(listFile, files.map((f) => `file '${f.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"), "utf-8");
	const result = await run(FFMPEG, [
		"-hide_banner", "-loglevel", "error",
		"-f", "concat", "-safe", "0",
		"-i", listFile,
		"-c", "copy", "-y", out,
	]);
	if (result.code !== 0) throw new Error(`合成失败: ${result.stderr.slice(-500)}`);
}

export function fontPath(): string {
	if (process.env.FONT_PATH) return process.env.FONT_PATH;
	if (process.platform === "win32") return "C:/Windows/Fonts/msyh.ttc";
	if (process.platform === "darwin") return "/System/Library/Fonts/PingFang.ttc";
	return "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
}

export function filterPath(p: string): string {
	return p.replaceAll("\\", "/").replaceAll(":", "\\\\:");
}

function drawtext(textFile: string, size: number, y: string, box = false): string {
	return `drawtext=fontfile=${filterPath(fontPath())}:textfile=${filterPath(textFile)}:fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${y}${box ? ":box=1:boxcolor=black@0.5:boxborderw=8" : ""}`;
}
const W = 640;
const H = 360;
const FPS = 15;

function wrapText(text: string, perLine: number): string {
	const maxWidth = perLine * 2;
	const width = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
	const tokens = text.match(/[^\s一-鿿　-〿＀-￯]+|[\s\S]/g) ?? [];
	const lines: string[] = [];
	let line = "";
	for (const tok of tokens) {
		if (tok === "\n") { lines.push(line.trimEnd()); line = ""; continue; }
		const tw = width(tok);
		if (width(line) + tw > maxWidth && line.trim()) { lines.push(line.trimEnd()); line = ""; }
		if (!line && /^\s+$/.test(tok)) continue;
		line += tok;
	}
	if (line.trim()) lines.push(line.trimEnd());
	return lines.join("\n");
}

async function renderCard(text: string, seconds: number, out: string, size = 26): Promise<void> {
	const textFile = out + ".txt";
	await writeFile(textFile, wrapText(text, 20), "utf-8");
	const result = await run(FFMPEG, [
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", `color=c=0x16213e:s=${W}x${H}:r=${FPS}:d=${seconds}`,
		"-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
		"-vf", drawtext(textFile, size, "(h-text_h)/2"),
		"-t", String(seconds),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-ar", "16000", "-ac", "1",
		"-y", out,
	]);
	if (result.code !== 0) throw new Error(`字幕卡渲染失败: ${result.stderr.slice(-500)}`);
}

export interface EditPiece {
	file: string;
	start: number;
	end: number;
	cardText: string;
	subtitle: string;
}

export async function editVlog(pieces: EditPiece[], out: string, opening: string, closing: string): Promise<{ parts: number; duration: number }> {
	const workDir = path.join(DIRS.vlogs, "parts");
	await mkdir(workDir, { recursive: true });
	const parts: string[] = [];
	let duration = 0;

	const openingFile = path.join(workDir, `p${String(parts.length).padStart(2, "0")}_open.mp4`);
	await renderCard(opening, 2.2, openingFile, 30);
	parts.push(openingFile);
	duration += 2.2;

	for (const piece of pieces) {
		const cardFile = path.join(workDir, `p${String(parts.length).padStart(2, "0")}_card.mp4`);
		await renderCard(piece.cardText, 1.8, cardFile);
		parts.push(cardFile);
		duration += 1.8;

		const dur = piece.end - piece.start;
		const subFile = path.join(workDir, `p${String(parts.length).padStart(2, "0")}_sub.txt`);
		await writeFile(subFile, wrapText(piece.subtitle, 26), "utf-8");
		const clipFile = path.join(workDir, `p${String(parts.length).padStart(2, "0")}_clip.mp4`);
		const vf = [
			`scale=${W}:${H}`, `fps=${FPS}`, "format=yuv420p",
			`fade=t=in:st=0:d=0.3`, `fade=t=out:st=${Math.max(0, dur - 0.3).toFixed(2)}:d=0.3`,
			drawtext(subFile, 18, "h-text_h-16", true),
		].join(",");
		const result = await run(FFMPEG, [
			"-hide_banner", "-loglevel", "error",
			"-ss", piece.start.toFixed(2), "-i", piece.file, "-t", dur.toFixed(2),
			"-vf", vf,
			"-af", `afade=t=in:st=0:d=0.2,afade=t=out:st=${Math.max(0, dur - 0.2).toFixed(2)}:d=0.2`,
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
			"-c:a", "aac", "-ar", "16000", "-ac", "1",
			"-y", clipFile,
		]);
		if (result.code !== 0) throw new Error(`精剪失败 ${piece.file}: ${result.stderr.slice(-500)}`);
		parts.push(clipFile);
		duration += dur;
	}

	const closingFile = path.join(workDir, `p${String(parts.length).padStart(2, "0")}_end.mp4`);
	await renderCard(closing, 1.8, closingFile);
	parts.push(closingFile);
	duration += 1.8;

	await concatVlog(parts, out);
	return { parts: parts.length, duration };
}