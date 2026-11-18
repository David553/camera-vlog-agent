// 自检：AGENT 文本+工具调用；若配置了 VISION 再测图片输入
import { readFile } from "node:fs/promises";
import { createGatewayModels, visionConfigured } from "./gateway.ts";

const agent = createGatewayModels("AGENT", ["text"]);
const textResp = await agent.models.complete(agent.model, {
	messages: [{ role: "user", content: "回复两个字：正常", timestamp: Date.now() }],
});
console.log("AGENT 文本:", textResp.stopReason === "error" ? `失败 ${textResp.errorMessage}` : textResp.content.filter((b) => b.type === "text").map((b) => b.text).join(""));

if (visionConfigured()) {
	const vision = createGatewayModels("VISION", ["text", "image"]);
	const image = await readFile(new URL("../frames/api-test.jpg", import.meta.url));
	const resp = await vision.models.complete(vision.model, {
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: "这张图片里有什么？一句话描述。" },
				{ type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
			],
			timestamp: Date.now(),
		}],
	});
	console.log("VISION 图片:", resp.stopReason === "error" ? `失败 ${resp.errorMessage}` : resp.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
} else {
	console.log("VISION: 未配置（tag_clip 将使用文本推断标签）");
}