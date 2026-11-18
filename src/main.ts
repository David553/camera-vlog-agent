// 端到端主流程：录制 → 运动分析 → pi agent 打标签/剪辑 → 汇总与上传披露
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { DIRS, RECORD_SECONDS, ROOT } from "./config.ts";
import { createGatewayModels, visionConfigured } from "./gateway.ts";
import { analyzeSegment, ensureGo2rtc, recordSegments } from "./media.ts";
import { ensureDirs, loadCloudCalls, loadIndex, loadSegments, saveSegments } from "./store.ts";
import { buildTools } from "./tools.ts";

const SYSTEM_PROMPT = `你是家庭摄像头 vlog 剪辑 agent，工作目录 ${ROOT}。
工作流程：
1. 调用 list_segments 查看分段与本地运动侦测结果。
2. 只对 motion=true 且未打标签的分段逐个调用 tag_clip（静止片段跳过，节省成本）。
3. 调用 build_vlog 把打标签的片段合成一条 vlog。
4. 用中文简短总结：选了哪些片段、各自标签、成片路径。
注意：provisional=true 表示标签是统计文本推断（未看画面），总结时如实说明。不要重复给同一段打标签。全程不要删除任何文件。`;

async function main() {
	const secondsArg = process.argv.indexOf("--seconds");
	const seconds = secondsArg > -1 ? Number(process.argv[secondsArg + 1]) : RECORD_SECONDS;
	const editOnly = process.argv.includes("--edit-only");

	await ensureDirs();
	await ensureGo2rtc();

	const runId = new Date().toISOString();
	let analyzed: Awaited<ReturnType<typeof analyzeSegment>>[] = [];
	if (!editOnly) {
		const files = await recordSegments(seconds);
		console.log(`[录制] 完成，共 ${files.length} 段`);
		const previous = await loadSegments();
		for (const file of files) {
			const seg = await analyzeSegment(file, runId);
			analyzed.push(seg);
			console.log(`[分析] ${seg.id} 运动=${seg.motion} 强度=${seg.motionScore} 活跃比=${seg.activeFraction} 亮度=${seg.brightness}`);
		}
		const merged = [...previous.filter((p) => !analyzed.some((a) => a.id === p.id)), ...analyzed];
		await saveSegments(merged);
	}

	const motionCount = analyzed.filter((s) => s.motion).length;
	if (!editOnly) console.log(`[分析] 有运动的分段: ${motionCount}/${analyzed.length}`);

	const { models, model } = createGatewayModels("AGENT", ["text"]);
	const agent = new Agent({
		initialState: { systemPrompt: SYSTEM_PROMPT, model, thinkingLevel: "off", tools: buildTools() },
		streamFn: models.streamSimple.bind(models),
	});

	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			console.log(`[agent] 调用工具 ${event.toolName} ${JSON.stringify(event.args)}`);
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		} else if (event.type === "turn_end" && event.message.stopReason === "error") {
			console.error(`\n[agent] 出错: ${event.message.errorMessage}`);
		}
	});

	console.log(`[agent] 开始打标签与剪辑（大脑: ${process.env.AGENT_MODEL}，视觉: ${visionConfigured() ? process.env.VISION_MODEL : "未配置，文本推断"}）`);
	const prompt = editOnly
		? "剪辑模式：不录制。先 list_clips 查看片段库；对 provisional=true 的片段调用 tag_clip(force=true) 升级为看图标签；然后调用 build_vlog 精剪合成一条 vlog（保留动作精彩窗口、片头片尾、字幕卡）。完成后中文总结。"
		: `录制完成，本次 run_id=${runId}，共 ${analyzed.length} 个分段（${seconds} 秒），其中 ${motionCount} 个有运动。请用 list_segments 传 run_id 只看本次分段，按流程完成打标签与剪辑。`;
	await agent.prompt(prompt);
	await agent.waitForIdle();
	console.log();

	await writeFile(path.join(DIRS.logs, "agent-transcript.json"), JSON.stringify(agent.state.messages, null, 2), "utf-8");

	const index = await loadIndex();
	const calls = await loadCloudCalls();
	console.log("========== 运行汇总 ==========");
	console.log(`带标签片段: ${index.clips.length} 个（clips/ 与 index.json）`);
	for (const v of index.vlogs.slice(-1)) console.log(`成片: ${v.file}（约 ${v.duration.toFixed(1)}s）`);
	console.log("---- 云端上传披露 ----");
	if (calls.length === 0) console.log("本次运行没有任何云端调用");
	for (const c of calls) {
		console.log(`${c.time} ${c.purpose} → ${c.model}；上传图片 ${c.imagesUploaded.length} 张${c.imagesUploaded.length ? ": " + c.imagesUploaded.join(", ") : "（" + c.note + "）"}`);
	}
	console.log(`完整台账: ${path.join(DIRS.logs, "cloud-calls.json")}`);
}

main().catch((err) => {
	console.error("运行失败:", err);
	process.exit(1);
});