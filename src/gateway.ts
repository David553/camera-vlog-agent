// 声明式 LLM gateway：models.yaml 定义 providers/models/roles/policy，
// 路由中间件提供 重试退避 / 模态拒收降级 / 并发限流 / 帧缓存 / local-only 隐私路由 / 调用台账。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { parse as parseYaml } from "yaml";
import { DIRS, ROOT } from "./config.ts";
import { logCloudCall } from "./store.ts";

export type Cap = "text" | "image";
export type ApiKind = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface ProviderCfg {
	id: string;
	api?: ApiKind;
	baseUrl: string;
	apiKeyEnv?: string;
	local?: boolean;
}
export interface ModelCfg {
	id: string;
	provider: string;
	model?: string;
	caps?: Cap[];
	contextWindow?: number;
	maxTokens?: number;
}
export interface PolicyCfg {
	localOnly?: boolean;
	retries?: number;
	maxConcurrency?: number;
	cache?: boolean;
}
export interface GatewayConfig {
	providers: ProviderCfg[];
	models: ModelCfg[];
	roles: Record<string, string[]>;
	policy?: PolicyCfg;
}

export function substituteEnv(value: unknown, env: Record<string, string | undefined>): unknown {
	if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => env[n] ?? "");
	if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env)]));
	return value;
}

export function parseGatewayConfig(text: string, env: Record<string, string | undefined>): GatewayConfig {
	return substituteEnv(parseYaml(text), env) as GatewayConfig;
}

export function synthLegacyConfig(env: Record<string, string | undefined>): GatewayConfig {
	const providers: ProviderCfg[] = [];
	const models: ModelCfg[] = [];
	const roles: Record<string, string[]> = { brain: [], vision: [], judge: [] };
	if (env.AGENT_BASE_URL && env.AGENT_MODEL) {
		providers.push({ id: "agent", baseUrl: env.AGENT_BASE_URL, apiKeyEnv: "AGENT_API_KEY" });
		models.push({ id: "brain", provider: "agent", model: env.AGENT_MODEL, caps: ["text"] });
		roles.brain.push("brain");
		roles.judge.push("brain");
	}
	if (env.VISION_BASE_URL && env.VISION_MODEL) {
		providers.push({ id: "vision", baseUrl: env.VISION_BASE_URL, apiKeyEnv: "VISION_API_KEY" });
		models.push({ id: "vision", provider: "vision", model: env.VISION_MODEL, caps: ["text", "image"] });
		roles.vision.push("vision");
		roles.judge.unshift("vision");
	}
	return { providers, models, roles, policy: { retries: 2, maxConcurrency: 2, cache: true } };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
	try {
		const text = readFileSync(path.join(ROOT, "models.yaml"), "utf-8");
		return parseGatewayConfig(text, env);
	} catch {
		return synthLegacyConfig(env);
	}
}

const API_FACTORIES: Record<ApiKind, () => any> = {
	"openai-completions": openAICompletionsApi,
	"anthropic-messages": anthropicMessagesApi,
	"google-generative-ai": googleGenerativeAIApi,
};

class Semaphore {
	max: number;
	active = 0;
	queue: (() => void)[] = [];
	constructor(max: number) {
		this.max = Math.max(1, max);
	}
	async acquire(): Promise<void> {
		if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
		this.active++;
	}
	release(): void {
		this.active--;
		this.queue.shift()?.();
	}
}

export interface CompleteOpts {
	purpose?: string;
	images?: string[];
	cacheKey?: string;
}
export interface CompleteResult {
	text: string;
	modelId: string;
	usage: { input: number; output: number };
	cacheHit: boolean;
}

function retryable(msg: string): boolean {
	return /429|500|502|503|504|timeout|timed out|ECONN|fetch failed|overloaded|rate.?limit/i.test(msg);
}
function modalityReject(msg: string): boolean {
	return /400|modality|only supports|not support|invalid.?request/i.test(msg);
}

export class Gateway {
	cfg: GatewayConfig;
	env: Record<string, string | undefined>;
	models: ReturnType<typeof createModels>;
	available = new Map<string, { cfg: ModelCfg; provider: ProviderCfg; resolved: Model<any> }>();
	sem: Semaphore;
	cacheDir: string;

	constructor(cfg: GatewayConfig, env: Record<string, string | undefined> = process.env) {
		this.cfg = cfg;
		this.env = env;
		this.sem = new Semaphore(cfg.policy?.maxConcurrency ?? 2);
		this.cacheDir = path.join(DIRS.logs, "cache");
		this.models = createModels();
		for (const p of cfg.providers) {
			const key = p.apiKeyEnv ? env[p.apiKeyEnv] : undefined;
			if (!p.baseUrl || (!p.local && p.apiKeyEnv && !key)) continue;
			const ms = cfg.models
				.filter((m) => m.provider === p.id && (m.model ?? m.id))
				.map((m): Model<any> => ({
					id: m.model ?? m.id,
					name: m.id,
					api: p.api ?? "openai-completions",
					provider: p.id,
					baseUrl: p.baseUrl,
					reasoning: false,
					input: m.caps ?? ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: m.contextWindow ?? 128000,
					maxTokens: m.maxTokens ?? 8192,
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				}));
			if (!ms.length) continue;
			const provider = createProvider({
				id: p.id,
				name: p.id,
				baseUrl: p.baseUrl,
				auth: { apiKey: p.apiKeyEnv ? envApiKeyAuth(`${p.id} key`, [p.apiKeyEnv]) : async () => (p.local ? "local" : undefined) },
				models: ms,
				api: API_FACTORIES[p.api ?? "openai-completions"](),
			});
			this.models.setProvider(provider);
			for (const m of cfg.models.filter((x) => x.provider === p.id && (x.model ?? x.id))) {
				const resolved = this.models.getModel(p.id, m.model ?? m.id);
				if (resolved) this.available.set(m.id, { cfg: m, provider: p, resolved });
			}
		}
	}

	candidates(role: string, need: Cap[] = ["text"]): ModelCfg[] {
		const ids = this.cfg.roles[role] ?? [];
		let list = ids
			.map((id) => this.available.get(id))
			.filter((x): x is NonNullable<typeof x> => Boolean(x))
			.filter((x) => need.every((c) => (x.cfg.caps ?? ["text"]).includes(c)));
		if (this.cfg.policy?.localOnly) list = list.filter((x) => x.provider.local);
		return list.map((x) => x.cfg);
	}

	hasRole(role: string, need: Cap[] = ["text"]): boolean {
		return this.candidates(role, need).length > 0;
	}

	describe(): string {
		const b = this.candidates("brain")[0]?.id ?? "未配置";
		const v = this.candidates("vision", ["text", "image"])[0]?.id ?? "未配置，文本推断";
		return `大脑: ${b}，视觉: ${v}`;
	}

	async complete(role: string, params: Parameters<ReturnType<typeof createModels>["complete"]>[1], opts: CompleteOpts = {}): Promise<CompleteResult> {
		const need: Cap[] = JSON.stringify(params.messages).includes('"image"') ? ["text", "image"] : ["text"];
		const chain = this.candidates(role, need);
		if (!chain.length) throw new Error(`角色 ${role} 无可用模型（检查 models.yaml / .env / local-only 策略）`);
		const retries = this.cfg.policy?.retries ?? 2;
		const useCache = (this.cfg.policy?.cache ?? true) && opts.cacheKey;
		if (useCache) {
			try {
				const cached = JSON.parse(await readFile(path.join(this.cacheDir, `${opts.cacheKey}.json`), "utf-8"));
				await logCloudCall({
					time: new Date().toISOString(), purpose: opts.purpose ?? `complete:${role}`, model: cached.modelId,
					endpoint: "", imagesUploaded: opts.images ?? [], note: "缓存命中，未上传未调用",
					role, cacheHit: true,
				});
				return { text: cached.text, modelId: cached.modelId, usage: cached.usage, cacheHit: true };
			} catch { /* 无缓存 */ }
		}
		let lastErr = "";
		for (const cand of chain) {
			const entry = this.available.get(cand.id)!;
			for (let attempt = 0; attempt <= retries; attempt++) {
				const t0 = Date.now();
				await this.sem.acquire();
				try {
					const res = await this.models.complete(entry.resolved, params);
					if (res.stopReason === "error") throw new Error(res.errorMessage ?? "model error");
					const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
					const usage = { input: res.usage?.input ?? 0, output: res.usage?.output ?? 0 };
					await logCloudCall({
						time: new Date().toISOString(), purpose: opts.purpose ?? `complete:${role}`, model: entry.resolved.id,
						endpoint: entry.provider.baseUrl, imagesUploaded: opts.images ?? [], note: "调用成功",
						role, tokensIn: usage.input, tokensOut: usage.output, latencyMs: Date.now() - t0, attempt,
					});
					if (useCache) {
						await mkdir(this.cacheDir, { recursive: true });
						await writeFile(path.join(this.cacheDir, `${opts.cacheKey}.json`), JSON.stringify({ text, usage, modelId: cand.id }), "utf-8");
					}
					return { text, modelId: cand.id, usage, cacheHit: false };
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
					await logCloudCall({
						time: new Date().toISOString(), purpose: opts.purpose ?? `complete:${role}`, model: entry.resolved.id,
						endpoint: entry.provider.baseUrl, imagesUploaded: opts.images ?? [], note: `失败 attempt=${attempt}: ${lastErr.slice(0, 200)}`,
						role, latencyMs: Date.now() - t0, attempt,
					});
					if (modalityReject(lastErr)) break;
					if (attempt < retries && retryable(lastErr)) {
						await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
						continue;
					}
					break;
				} finally {
					this.sem.release();
				}
			}
		}
		throw new Error(`角色 ${role} 全部候选失败: ${lastErr}`);
	}
}

let singleton: Gateway | null = null;
export function getGateway(): Gateway {
	if (!singleton) singleton = new Gateway(loadConfig());
	return singleton;
}

export function frameCacheKey(prompt: string, buffers: Buffer[]): string {
	const h = createHash("sha256").update(prompt);
	for (const b of buffers) h.update(b);
	return h.digest("hex");
}

// 兼容旧接口：AGENT→brain，VISION→vision，返回首个候选的 pi-ai models/model
export function createGatewayModels(prefix: "AGENT" | "VISION", input: Cap[]) {
	const gw = getGateway();
	const role = prefix === "AGENT" ? "brain" : "vision";
	const cand = gw.candidates(role, input)[0];
	if (!cand) throw new Error(`缺少 ${prefix}_BASE_URL / ${prefix}_MODEL / ${prefix}_API_KEY（或 models.yaml 对应角色）`);
	return { models: gw.models, model: gw.available.get(cand.id)!.resolved };
}

export function visionConfigured(): boolean {
	return getGateway().hasRole("vision", ["text", "image"]);
}