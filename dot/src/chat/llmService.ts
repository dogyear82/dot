import type { AppConfig } from "../config.js";
import type { SettingsStore } from "../settings.js";
import { startLlmTimer, withSpan } from "../observability.js";
import { OllamaChatProvider, OneMinAiChatProvider, type ChatMessage, type ChatProvider } from "./providers.js";
import { SpanKind } from "@opentelemetry/api";


export type LlmMode = "lite" | "normal" | "power";

export interface LlmService {
    generate(messages: ChatMessage[], model?: string): any;
}

export type ChatService = LlmService;

export function createLlmService(params: {
    config: AppConfig;
    settings: SettingsStore;
    providers?: ChatProvider[];
}): LlmService {
    const providers =
        params.providers ??
        [
            new OllamaChatProvider(
                params.config.OLLAMA_BASE_URL,
                params.config.OLLAMA_MODEL,
                params.config.MODEL_REQUEST_TIMEOUT_MS
            ),
            new OneMinAiChatProvider(
                params.config.ONEMINAI_BASE_URL,
                params.config.ONEMINAI_API_KEY,
                params.config.ONEMINAI_MODEL,
                params.config.MODEL_REQUEST_TIMEOUT_MS
            )
        ];
    return {
        async generate(messages: ChatMessage[], model?: string) {
            const reply = await executeProviderRequest({
                mode: getLlmMode(params.settings),
                providers,
                invoke: async (provider) => {
                    return await provider.generate(messages);
                },
                failurePrefix: "No LLM provider could infer addressedness and intent."
            });

            return reply;
        },
    }
}

async function executeProviderRequest(params: {
    mode: LlmMode;
    providers: ChatProvider[];
    invoke: (provider: ChatProvider) => Promise<string>;
    failurePrefix: string;
}): Promise<string> {
    const orderedProviders = orderProvidersForMode(params.providers, params.mode);
    const failures: string[] = [];

    for (const provider of orderedProviders) {
        if (!provider.isAvailable()) {
            failures.push(`${provider.route}: not configured`);
            continue;
        }

        const timer = startLlmTimer({
            operation: "llm.inferencing",
            provider: provider.name,
            route: provider.route
        });

        try {
            const reply = await withSpan(
                "llm.request",
                {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        "dot.llm.operation": "llm.inferencing",
                        "dot.llm.provider": provider.name,
                        "dot.llm.route": provider.route
                    }
                },
                async (span) => {
                    const response = await params.invoke(provider);
                    span.setAttribute("dot.llm.outcome", "success");
                    return response;
                }
            );
            timer.stop("success");
            return reply;
        } catch (error) {
            timer.stop("failure");
            const errorMessage = error instanceof Error ? error.message : "unknown error"
            failures.push(`${provider.route}: ${errorMessage}`);
        }
    }

    throw new Error(`${params.failurePrefix} ${failures.join("; ")}`);
}

export function getLlmMode(settings: SettingsStore): LlmMode {
    const configuredMode = settings.get("llm.mode");
    return configuredMode === "lite" || configuredMode === "power" ? configuredMode : "normal";
}

export function orderProvidersForMode(providers: ChatProvider[], mode: LlmMode): ChatProvider[] {
    const localProviders = providers.filter((provider) => provider.route === "local");
    const hostedProviders = providers.filter((provider) => provider.route === "hosted");

    switch (mode) {
        case "lite":
            return localProviders;
        case "power":
            return [...hostedProviders, ...localProviders];
        case "normal":
        default:
            return [...localProviders, ...hostedProviders];
    }
}