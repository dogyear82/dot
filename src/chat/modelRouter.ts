import type { AppConfig } from "../config.js";
import { SpanKind } from "@opentelemetry/api";
import { startLlmTimer, withSpan } from "../observability.js";
import type { SettingsStore } from "../settings.js";
import type {
  ConversationTurnRecord,
  WorldLookupArticleRecord,
  WorldLookupEvidenceRecord,
  WorldLookupQueryBucket,
  WorldLookupSourceFailure,
  WorldLookupSourceName
} from "../types.js";
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
  generateGroundedReply?(params: {
    userMessage: string;
    evidence: WorldLookupEvidenceRecord[];
    articles?: WorldLookupArticleRecord[];
    bucket: WorldLookupQueryBucket;
    selectedSources: WorldLookupSourceName[];
    failures: WorldLookupSourceFailure[];
    outcome: "success" | "partial_failure" | "no_evidence";
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
        operation: "chat.generate",
        invoke: (provider) => provider.generate(messages),
        failurePrefix: "No LLM provider could generate a response."
      });

      return { route, powerStatus: getPowerStatus(route), reply };
    },
    async generateGroundedReply({ userMessage, evidence, articles, bucket, selectedSources, failures, outcome, recentConversation }) {
      const messages = buildGroundedMessages({
        userMessage,
        evidence,
        articles,
        bucket,
        selectedSources,
        failures,
        outcome,
        recentConversation,
        mode: (params.settings.get("persona.mode") ?? "sheltered") as PersonaMode,
        balance: (params.settings.get("persona.balance") ?? "balanced") as PersonaBalance,
        settings: params.settings
      });
      const { route, reply } = await executeProviderRequest({
        mode: getLlmMode(params.settings),
        providers,
        operation: "world_lookup.answer",
        invoke: (provider) => provider.generate(messages),
        failurePrefix: "No LLM provider could generate a grounded response."
      });

      return {
        route,
        powerStatus: getPowerStatus(route),
        reply: appendGroundedLinks(reply, evidence)
      };
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
        operation: "tool.infer",
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
  const indicator = formatPowerIndicator(powerStatus);
  const trimmed = content.trimEnd();
  return trimmed.endsWith(indicator) ? trimmed : `${trimmed}\n\n${indicator}`;
}

export function formatPowerIndicator(powerStatus: LlmPowerStatus): string {
  return `[mode: ${formatModeLabel(powerStatus)}]`;
}

export function buildCurrentDateTimeInstruction(now = new Date()): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return `Current date and time: ${now.toISOString()} (${timezone}). Use this as the authoritative current time reference unless newer explicit context is provided.`;
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
  operation: string;
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

    const timer = startLlmTimer({
      operation: params.operation,
      provider: provider.name,
      route: provider.route
    });

    try {
      const reply = await withSpan(
        "llm.request",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "dot.llm.operation": params.operation,
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
      return { route: provider.route, reply };
    } catch (error) {
      timer.stop("failure");
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
      content: `${buildSystemPrompt({
        mode: params.mode,
        balance: params.balance,
        settings: params.settings
      })} ${buildCurrentDateTimeInstruction()}`
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

function buildGroundedMessages(params: {
  userMessage: string;
  evidence: WorldLookupEvidenceRecord[];
  articles?: WorldLookupArticleRecord[];
  bucket: WorldLookupQueryBucket;
  selectedSources: WorldLookupSourceName[];
  failures: WorldLookupSourceFailure[];
  outcome: "success" | "partial_failure" | "no_evidence";
  recentConversation?: ConversationTurnRecord[];
  mode: PersonaMode;
  balance: PersonaBalance;
  settings: SettingsStore;
}): ChatMessage[] {
  const evidenceLines =
    params.evidence.length > 0
      ? params.evidence
          .slice(0, 6)
          .map(
            (record, index) =>
              `${index + 1}. source=${formatWorldLookupSource(record.source)} | title=${record.title} | snippet=${record.snippet} | url=${record.url ?? "none"} | publishedAt=${record.publishedAt ?? "unknown"}`
          )
          .join("\n")
      : "No public evidence was found.";

  const failureLines =
    params.failures.length > 0
      ? params.failures.map((failure) => `${formatWorldLookupSource(failure.source)}: ${failure.reason}`).join("; ")
      : "none";
  const articleLines =
    (params.articles?.length ?? 0) > 0
      ? params.articles
          ?.slice(0, 3)
          .map(
            (article, index) =>
              `${index + 1}. publisher=${article.publisher} | title=${article.title} | publishedAt=${article.publishedAt ?? "unknown"} | url=${article.url} | excerpt=${article.excerpt}`
          )
          .join("\n")
      : "No article text could be extracted from the selected sources.";

  return [
    {
      role: "system",
      content: `${buildSystemPrompt({
        mode: params.mode,
        balance: params.balance,
        settings: params.settings
      })} ${buildCurrentDateTimeInstruction()} Use the supplied external evidence when answering. Stay in the active personality profile. Answer only the user's question. Make it clear this information was looked up, not remembered. Cite sources naturally in prose, such as 'According to Reuters...' or 'I'm seeing from CNN...'. Prefer the supplied article extracts over bare snippets whenever article text is available. Summarize in your own words. Do not quote long passages or regurgitate article paragraphs. If the evidence is missing, conflicting, or too weak, say you couldn't verify it from the available public sources and do not guess.`
    },
    ...(params.recentConversation ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: [
        `User question: ${params.userMessage}`,
        `Lookup bucket: ${params.bucket}`,
        `Lookup outcome: ${params.outcome}`,
        `Selected sources: ${params.selectedSources.map((source) => formatWorldLookupSource(source)).join(", ")}`,
        `Source failures: ${failureLines}`,
        "Evidence:",
        evidenceLines,
        "Article extracts:",
        articleLines,
        "Answer in Dot's normal voice. Mention the source naturally in the sentence when you rely on it. Keep the answer tight."
      ].join("\n")
    }
  ];
}

function appendGroundedLinks(reply: string, evidence: WorldLookupEvidenceRecord[]): string {
  const uniqueLinks = Array.from(
    new Map(
      evidence
        .filter((record): record is WorldLookupEvidenceRecord & { url: string } => typeof record.url === "string" && record.url.length > 0)
        .map((record) => [record.url, record])
    ).values()
  ).slice(0, 3);

  if (uniqueLinks.length === 0) {
    return reply;
  }

  return `${reply.trimEnd()}\n\nLinks:\n${uniqueLinks.map((record) => `- ${record.url}`).join("\n")}`;
}

function formatWorldLookupSource(source: WorldLookupSourceName): string {
  switch (source) {
    case "wikipedia":
      return "Wikipedia";
    case "wikimedia_current_events":
      return "Wikinews";
    case "gdelt":
      return "GDELT";
    case "open_meteo":
      return "Open-Meteo";
    case "world_bank":
      return "World Bank";
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function formatModeLabel(powerStatus: LlmPowerStatus): LlmMode {
  switch (powerStatus) {
    case "off":
      return "lite";
    case "engaged":
      return "power";
    case "standby":
    default:
      return "normal";
  }
}
