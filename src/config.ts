import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const GO2RTC = process.env.GO2RTC_PATH || "go2rtc";
export const GO2RTC_CONFIG = process.env.GO2RTC_CONFIG || path.join(ROOT, "go2rtc.yaml");
export const PYTHON_PACKAGES = process.env.PYTHON_PACKAGES || "";
export const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
export const GO2RTC_API = "http://127.0.0.1:1984";
export const SUB_STREAM = "rtsp://127.0.0.1:8554/tplink_sub";

export const DIRS = {
	segments: path.join(ROOT, "segments"),
	frames: path.join(ROOT, "frames"),
	clips: path.join(ROOT, "clips"),
	vlogs: path.join(ROOT, "vlogs"),
	logs: path.join(ROOT, "logs"),
};

export const SEGMENTS_FILE = path.join(ROOT, "segments.json");
export const INDEX_FILE = path.join(ROOT, "index.json");
export const CLOUD_LOG = path.join(DIRS.logs, "cloud-calls.json");

export const RECORD_SECONDS = Number(process.env.RECORD_SECONDS ?? 60);
export const SEGMENT_SECONDS = Number(process.env.SEGMENT_SECONDS ?? 10);