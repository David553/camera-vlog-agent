// 用真实摄像头帧测试视觉模型：node --env-file=.env src/test-vision.ts <jpg...>
import { readFile } from "node:fs/promises";
import { createGatewayModels } from "./gateway.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
	console.error("用法: node --env-file=.env src/test-vision.ts <jpg...>");
	process.exit(1);
}
const { models, model } = createGatewayModels("VISION", ["text", "image"]);
for (const p of paths) {
	const data = (await readFile(p)).toString("base64");
	const resp = await models.complete(model, {
		systemPrompt: "你是家庭摄像头画面识别助手，只输出 JSON。",
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: '识别这张摄像头画面，输出严格 JSON：{"tags":["3-6个中文标签"],"description":"一句话中文描述"}' },
				{ type: "image", data, mimeType: "image/jpeg" },
			],
			timestamp: Date.now(),
		}],
	});
	if (resp.stopReason === "error") {
		console.log(p, "→ 失败:", resp.errorMessage);
		continue;
	}
	const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
	console.log(p, "→", text);
	console.log("  usage:", JSON.stringify(resp.usage));
}