import test from "node:test";
import assert from "node:assert/strict";
import { Gateway, parseGatewayConfig, synthLegacyConfig } from "./gateway.ts";

test("parseGatewayConfig 替换 ${ENV} 占位符", () => {
	const cfg = parseGatewayConfig(
		"providers:\n  - id: p\n    baseUrl: ${URL}\n    apiKeyEnv: KEY\nmodels: []\nroles: {}",
		{ URL: "http://x/v1" },
	);
	assert.equal(cfg.providers[0].baseUrl, "http://x/v1");
});

test("synthLegacyConfig 从 AGENT_/VISION_ 环境变量合成角色", () => {
	const cfg = synthLegacyConfig({
		AGENT_BASE_URL: "http://a", AGENT_MODEL: "m1", AGENT_API_KEY: "k",
		VISION_BASE_URL: "http://b", VISION_MODEL: "m2", VISION_API_KEY: "k",
	});
	assert.deepEqual(cfg.roles.brain, ["brain"]);
	assert.deepEqual(cfg.roles.vision, ["vision"]);
	assert.deepEqual(cfg.roles.judge, ["vision", "brain"]);
});

const cfg = {
	providers: [
		{ id: "p1", baseUrl: "http://a", apiKeyEnv: "K1" },
		{ id: "p2", baseUrl: "http://b", apiKeyEnv: "K2" },
		{ id: "p3", baseUrl: "http://c", local: true },
	],
	models: [
		{ id: "t", provider: "p1", caps: ["text"] as const },
		{ id: "v", provider: "p2", caps: ["text", "image"] as const },
		{ id: "lv", provider: "p3", caps: ["text", "image"] as const },
	],
	roles: { brain: ["t"], vision: ["v", "lv"] },
};

test("缺 key 的 provider 不可用，候选链跳过", () => {
	const gw = new Gateway(cfg as any, { K1: "x" });
	assert.deepEqual(gw.candidates("brain").map((m) => m.id), ["t"]);
	assert.deepEqual(gw.candidates("vision", ["text", "image"]).map((m) => m.id), ["lv"]);
});

test("caps 过滤：纯文本角色不选视觉模型", () => {
	const gw = new Gateway(cfg as any, { K1: "x", K2: "y" });
	assert.deepEqual(gw.candidates("vision", ["text"]).map((m) => m.id), ["v", "lv"]);
	assert.deepEqual(gw.candidates("vision", ["text", "image"]).map((m) => m.id), ["v", "lv"]);
});

test("localOnly 策略只保留本地 provider", () => {
	const gw = new Gateway({ ...cfg, policy: { localOnly: true } } as any, { K1: "x", K2: "y" });
	assert.deepEqual(gw.candidates("vision", ["text", "image"]).map((m) => m.id), ["lv"]);
	assert.equal(gw.hasRole("brain"), false);
});