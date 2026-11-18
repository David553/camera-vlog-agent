// OpenAI 兼容网关接入：agent 大脑（AGENT_*）与视觉模型（VISION_*）共用一套构建逻辑
import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export function createGatewayModels(prefix: "AGENT" | "VISION", input: ("text" | "image")[]) {
	const baseUrl = process.env[`${prefix}_BASE_URL`];
	const modelId = process.env[`${prefix}_MODEL`];
	const apiKey = process.env[`${prefix}_API_KEY`];
	if (!baseUrl || !modelId || !apiKey) throw new Error(`缺少 ${prefix}_BASE_URL / ${prefix}_MODEL / ${prefix}_API_KEY`);

	const providerId = prefix.toLowerCase();
	const model: Model<"openai-completions"> = {
		id: modelId,
		name: `${modelId} (${providerId})`,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	};

	const provider = createProvider({
		id: providerId,
		name: providerId,
		baseUrl,
		auth: { apiKey: envApiKeyAuth(`${providerId} API key`, [`${prefix}_API_KEY`]) },
		models: [model],
		api: openAICompletionsApi(),
	});
	const models = createModels();
	models.setProvider(provider);
	const resolved = models.getModel(providerId, modelId);
	if (!resolved) throw new Error(`Model ${modelId} not found`);
	return { models, model: resolved };
}

export function visionConfigured(): boolean {
	return Boolean(process.env.VISION_API_KEY && process.env.VISION_BASE_URL && process.env.VISION_MODEL);
}