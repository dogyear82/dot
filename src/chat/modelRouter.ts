import type { AppConfig } from "../config.js";
import type { SettingsStore } from "../settings.js";
import { buildToolInferencePrompt, parseToolDecision, type ToolDecision } from "../toolInvocation.js";
import { buildSystemPrompt, type PersonaBalance, type PersonaMode } from "./persona.js";
import { OllamaChatProvider, OpenAiCompatibleChatProvider, type ChatMessage, type ChatProvider } from "./providers.js";

export interface ChatService {
  generateOwnerReply(userMessage: string): Promise<{ provider: string; reply: string }>;
  inferToolDecision(userMessage: string): Promise<{ provider: string; decision: ToolDecision }>;
}

export function createChatService(params: {
  config: AppConfig;
  settings: SettingsStore;
  providers?: ChatProvider[];
}): ChatService {
  const providers =
    params.providers ??
    [
      new OllamaChatProvider(
        params.config.OLLAMA_BASE_URL,
        params.config.OLLAMA_MODEL,
        params.config.MODEL_REQUEST_TIMEOUT_MS
      ),
      new OpenAiCompatibleChatProvider(
        params.config.ONEMINAI_BASE_URL,
        params.config.ONEMINAI_API_KEY,
        params.config.ONEMINAI_MODEL,
        params.config.MODEL_REQUEST_TIMEOUT_MS
      )
    ];

  return {
    async generateOwnerReply(userMessage) {
      const orderedProviders = orderProviders(providers, params.settings.get("models.primary") ?? "ollama");
      const messages = buildMessages({
        userMessage,
        mode: (params.settings.get("persona.mode") ?? "sheltered") as PersonaMode,
        balance: (params.settings.get("persona.balance") ?? "balanced") as PersonaBalance,
        settings: params.settings
      });

      const failures: string[] = [];

      for (const provider of orderedProviders) {
        if (!provider.isAvailable()) {
          failures.push(`${provider.name}: not configured`);
          continue;
        }

        try {
          const reply = await provider.generate(messages);
          return { provider: provider.name, reply };
        } catch (error) {
          failures.push(`${provider.name}: ${formatError(error)}`);
        }
      }

      throw new Error(`No chat provider could generate a response. ${failures.join("; ")}`);
    },
    async inferToolDecision(userMessage) {
      const orderedProviders = orderProviders(providers, params.settings.get("models.primary") ?? "ollama");
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
      const failures: string[] = [];

      for (const provider of orderedProviders) {
        if (!provider.isAvailable()) {
          failures.push(`${provider.name}: not configured`);
          continue;
        }

        try {
          const reply = await provider.generate(messages);
          return { provider: provider.name, decision: parseToolDecision(reply) };
        } catch (error) {
          failures.push(`${provider.name}: ${formatError(error)}`);
        }
      }

      throw new Error(`No chat provider could infer a tool decision. ${failures.join("; ")}`);
    }
  };
}

export function orderProviders(providers: ChatProvider[], preferredProvider: string): ChatProvider[] {
  const preferred = providers.find((provider) => provider.name === preferredProvider);
  const remaining = providers.filter((provider) => provider.name !== preferredProvider);
  return preferred ? [preferred, ...remaining] : providers;
}

function buildMessages(params: {
  userMessage: string;
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
    {
      role: "user",
      content: params.userMessage
    }
  ];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
