import type { AppConfig } from "../config.js";
import type { SettingsStore } from "../settings.js";
import type { ConversationTurnRecord } from "../types.js";
import { buildToolInferencePrompt, inferDeterministicToolDecision, parseToolDecision, type ToolDecision } from "../toolInvocation.js";
import { buildSystemPrompt, type PersonaBalance, type PersonaMode } from "./persona.js";
import { OllamaChatProvider, OneMinAiChatProvider, type ChatMessage, type ChatProvider } from "./providers.js";

export type LlmMode = "lite" | "normal" | "power";
export type LlmRoute = "none" | "deterministic" | "local" | "hosted";
export type LlmPowerStatus = "off" | "standby" | "engaged";

export interface LlmService {
  generateOwnerReply(params: {
    userMessage: string;
    recentConversation?: ConversationTurnRecord[];
  }): Promise<{ route: LlmRoute; powerStatus: LlmPowerStatus; reply: string }>;
  inferToolDecision(userMessage: string): Promise<{ route: LlmRoute; powerStatus: LlmPowerStatus; decision: ToolDecision }>;
  getPowerStatus(route?: LlmRoute): LlmPowerStatus;
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

  const getPowerStatus = (route: LlmRoute = "none"): LlmPowerStatus => {
    const mode = getLlmMode(params.settings);

    if (mode === "lite") {
      return "off";
    }

    return route === "hosted" ? "engaged" : "standby";
  };

  return {
    async generateOwnerReply({ userMessage, recentConversation }) {
      const messages = buildMessages({
        userMessage,
        recentConversation,
        mode: (params.settings.get("persona.mode") ?? "sheltered") as PersonaMode,
        balance: (params.settings.get("persona.balance") ?? "balanced") as PersonaBalance,
        settings: params.settings
      });
      const { route, reply } = await executeProviderRequest({
        mode: getLlmMode(params.settings),
        providers,
        invoke: (provider) => provider.generate(messages),
        failurePrefix: "No LLM provider could generate a response."
      });

      return { route, powerStatus: getPowerStatus(route), reply };
    },
    async inferToolDecision(userMessage) {
      const deterministicDecision = inferDeterministicToolDecision(userMessage);
      if (deterministicDecision) {
        return {
          route: "deterministic",
          powerStatus: getPowerStatus("deterministic"),
          decision: deterministicDecision
        };
      }

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: "Return only strict JSON. Do not add markdown fences."
        },
        {
          role: "user",
          content: buildToolInferencePrompt(userMessage)
        }
      ];
      const { route, reply } = await executeProviderRequest({
        mode: getLlmMode(params.settings),
        providers,
        invoke: async (provider) => parseToolDecision(await provider.generate(messages)),
        failurePrefix: "No LLM provider could infer a tool decision."
      });

      return { route, powerStatus: getPowerStatus(route), decision: reply };
    },
    getPowerStatus
  };
}

export const createChatService = createLlmService;

export function appendPowerIndicator(content: string, powerStatus: LlmPowerStatus): string {
  return `${content}\n\n${formatPowerIndicator(powerStatus)}`;
}

export function formatPowerIndicator(powerStatus: LlmPowerStatus): string {
  return `[power: ${powerStatus}]`;
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

async function executeProviderRequest<T>(params: {
  mode: LlmMode;
  providers: ChatProvider[];
  invoke: (provider: ChatProvider) => Promise<T>;
  failurePrefix: string;
}): Promise<{ route: LlmRoute; reply: T }> {
  const orderedProviders = orderProvidersForMode(params.providers, params.mode);
  const failures: string[] = [];

  for (const provider of orderedProviders) {
    if (!provider.isAvailable()) {
      failures.push(`${provider.route}: not configured`);
      continue;
    }

    try {
      const reply = await params.invoke(provider);
      return { route: provider.route, reply };
    } catch (error) {
      failures.push(`${provider.route}: ${formatError(error)}`);
    }
  }

  throw new Error(`${params.failurePrefix} ${failures.join("; ")}`);
}

function buildMessages(params: {
  userMessage: string;
  recentConversation?: ConversationTurnRecord[];
  mode: PersonaMode;
  balance: PersonaBalance;
  settings: SettingsStore;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: buildSystemPrompt({
        mode: params.mode,
        balance: params.balance,
        settings: params.settings
      })
    },
    ...(params.recentConversation ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: params.userMessage
    }
  ];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
