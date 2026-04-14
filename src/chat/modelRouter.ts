import type { AppConfig } from "../config.js";
import { SpanKind } from "@opentelemetry/api";
import { startLlmTimer, withSpan } from "../observability.js";
import type { SettingsStore } from "../settings.js";
import type { ToolRenderInstructions } from "../conversationalTools.js";
import type {
  ConversationTurnRecord,
  NewsBrowseSessionItemRecord,
  WorldLookupArticleRecord,
  WorldLookupEvidenceRecord,
  WorldLookupQueryBucket,
  WorldLookupSourceFailure,
  WorldLookupSourceName
} from "../types.js";
import { buildToolInferencePrompt, parseToolDecision, type ConversationalIntentDecision } from "../toolInvocation.js";
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
  generateNewsBriefingReply?(params: {
    userMessage: string;
    evidence: WorldLookupEvidenceRecord[];
    selectedSources: WorldLookupSourceName[];
    failures: WorldLookupSourceFailure[];
    outcome: "success" | "partial_failure" | "no_evidence";
    recentConversation?: ConversationTurnRecord[];
  }): Promise<{ route: LlmRoute; powerStatus: LlmPowerStatus; reply: string }>;
  generateStoryFollowUpReply?(params: {
    userMessage: string;
    selectedItem: NewsBrowseSessionItemRecord;
    evidence: WorldLookupEvidenceRecord[];
    articles?: WorldLookupArticleRecord[];
    recentConversation?: ConversationTurnRecord[];
  }): Promise<{ route: LlmRoute; powerStatus: LlmPowerStatus; reply: string }>;
  renderToolResult?(params: {
    userMessage: string;
    payload: Record<string, unknown>;
    renderInstructions: ToolRenderInstructions;
    recentConversation?: ConversationTurnRecord[];
  }): Promise<{ route: LlmRoute; powerStatus: LlmPowerStatus; reply: string }>;
  inferToolDecision(
    userMessage: string,
    recentConversation?: ConversationTurnRecord[]
  ): Promise<{ route: LlmRoute; powerStatus: LlmPowerStatus; decision: ConversationalIntentDecision }>;
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
    async generateNewsBriefingReply({ userMessage, evidence, selectedSources, failures, outcome, recentConversation }) {
      const messages = buildNewsBriefingMessages({
        userMessage,
        evidence,
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
        operation: "news_briefing.answer",
        invoke: (provider) => provider.generate(messages),
        failurePrefix: "No LLM provider could generate a news briefing."
      });

      return {
        route,
        powerStatus: getPowerStatus(route),
        reply: appendGroundedLinks(reply, evidence, 5)
      };
    },
    async generateStoryFollowUpReply({ userMessage, selectedItem, evidence, articles, recentConversation }) {
      const messages = buildStoryFollowUpMessages({
        userMessage,
        selectedItem,
        evidence,
        articles,
        recentConversation,
        mode: (params.settings.get("persona.mode") ?? "sheltered") as PersonaMode,
        balance: (params.settings.get("persona.balance") ?? "balanced") as PersonaBalance,
        settings: params.settings
      });
      const { route, reply } = await executeProviderRequest({
        mode: getLlmMode(params.settings),
        providers,
        operation: "news_follow_up.answer",
        invoke: (provider) => provider.generate(messages),
        failurePrefix: "No LLM provider could generate a news follow-up."
      });

      return {
        route,
        powerStatus: getPowerStatus(route),
        reply: appendGroundedLinks(reply, evidence)
      };
    },
    async renderToolResult({ userMessage, payload, renderInstructions, recentConversation }) {
      const messages = buildToolRenderMessages({
        userMessage,
        payload,
        renderInstructions,
        recentConversation,
        mode: (params.settings.get("persona.mode") ?? "sheltered") as PersonaMode,
        balance: (params.settings.get("persona.balance") ?? "balanced") as PersonaBalance,
        settings: params.settings
      });
      const { route, reply } = await executeProviderRequest({
        mode: getLlmMode(params.settings),
        providers,
        operation: "tool.render",
        invoke: (provider) => provider.generate(messages),
        failurePrefix: "No LLM provider could render a tool result."
      });

      return {
        route,
        powerStatus: getPowerStatus(route),
        reply
      };
    },
    async inferToolDecision(userMessage, recentConversation) {
      const messages = buildConversationalIntentMessages({
        userMessage,
        recentConversation,
        mode: (params.settings.get("persona.mode") ?? "sheltered") as PersonaMode,
        balance: (params.settings.get("persona.balance") ?? "balanced") as PersonaBalance,
        settings: params.settings
      });
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

function buildConversationalIntentMessages(params: {
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
      })} ${buildCurrentDateTimeInstruction()} Return only strict JSON with either a respond or execute_tool decision. If you choose respond, the response field must be the final user-facing reply in Dot's normal voice. Do not add markdown fences.`
    },
    ...(params.recentConversation ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: buildToolInferencePrompt(params.userMessage)
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

function buildNewsBriefingMessages(params: {
  userMessage: string;
  evidence: WorldLookupEvidenceRecord[];
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
              `${index + 1}. title=${record.title} | publisher=${record.publisher ?? formatWorldLookupSource(record.source)} | snippet=${record.snippet} | rankingSignals=${record.rankingSignals?.join(",") ?? "none"} | url=${record.url ?? "none"} | publishedAt=${record.publishedAt ?? "unknown"}`
          )
          .join("\n")
      : "No briefing evidence was found.";

  const failureLines =
    params.failures.length > 0
      ? params.failures.map((failure) => `${formatWorldLookupSource(failure.source)}: ${failure.reason}`).join("; ")
      : "none";

  return [
    {
      role: "system",
      content: `${buildSystemPrompt({
        mode: params.mode,
        balance: params.balance,
        settings: params.settings
      })} ${buildCurrentDateTimeInstruction()} You are preparing a concise news briefing. Stay in the active personality profile. Use the supplied external evidence only. Make it clear this information was looked up, not remembered. Give a short list of 4 to 5 headlines when enough evidence exists. Blend major world news with stories that seem especially relevant to the owner's stored interests when the evidence supports that mix. Keep each item brief. Cite the outlet naturally in each item. Each item must name the story itself and why it matters in one sentence. Do not answer with only links or outlet names. Do not dump raw articles or long summaries. If the evidence is weak, say you could not assemble a reliable briefing from the available sources.`
    },
    ...(params.recentConversation ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: [
        `Owner request: ${params.userMessage}`,
        `Lookup outcome: ${params.outcome}`,
        `Selected sources: ${params.selectedSources.map((source) => formatWorldLookupSource(source)).join(", ")}`,
        `Source failures: ${failureLines}`,
        "Briefing evidence:",
        evidenceLines,
        "Answer as a compact shortlist in Dot's normal voice."
      ].join("\n")
    }
  ];
}

function buildStoryFollowUpMessages(params: {
  userMessage: string;
  selectedItem: NewsBrowseSessionItemRecord;
  evidence: WorldLookupEvidenceRecord[];
  articles?: WorldLookupArticleRecord[];
  recentConversation?: ConversationTurnRecord[];
  mode: PersonaMode;
  balance: PersonaBalance;
  settings: SettingsStore;
}): ChatMessage[] {
  const articleLines =
    (params.articles?.length ?? 0) > 0
      ? params.articles
          ?.slice(0, 2)
          .map(
            (article, index) =>
              `${index + 1}. publisher=${article.publisher} | title=${article.title} | publishedAt=${article.publishedAt ?? "unknown"} | url=${article.url} | excerpt=${article.excerpt}`
          )
          .join("\n")
      : "No additional article text could be extracted.";

  return [
    {
      role: "system",
      content: `${buildSystemPrompt({
        mode: params.mode,
        balance: params.balance,
        settings: params.settings
      })} ${buildCurrentDateTimeInstruction()} You are following up on a previously shown news story. Stay in the active personality profile. Make it clear this information was looked up, not remembered. Answer only the requested follow-up. Cite the source naturally in prose. Prefer the supplied article extract over the saved snippet when article text is available. Summarize in your own words and do not dump article text.`
    },
    ...(params.recentConversation ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: [
        `Owner follow-up: ${params.userMessage}`,
        `Selected story: ${params.selectedItem.title}`,
        `Selected publisher: ${params.selectedItem.publisher ?? formatWorldLookupSource(params.selectedItem.source)}`,
        `Selected snippet: ${params.selectedItem.snippet}`,
        "Article extracts:",
        articleLines,
        "Answer in Dot's normal voice and keep it concise."
      ].join("\n")
    }
  ];
}

function buildToolRenderMessages(params: {
  userMessage: string;
  payload: Record<string, unknown>;
  renderInstructions: ToolRenderInstructions;
  recentConversation?: ConversationTurnRecord[];
  mode: PersonaMode;
  balance: PersonaBalance;
  settings: SettingsStore;
}): ChatMessage[] {
  const constraints =
    params.renderInstructions.constraints && params.renderInstructions.constraints.length > 0
      ? params.renderInstructions.constraints.map((constraint) => `- ${constraint}`).join("\n")
      : "- Use only the supplied tool payload.";
  const styleHints =
    params.renderInstructions.styleHints && params.renderInstructions.styleHints.length > 0
      ? params.renderInstructions.styleHints.map((hint) => `- ${hint}`).join("\n")
      : "- Keep the reply concise and natural.";

  return [
    {
      role: "system",
      content: `${buildSystemPrompt({
        mode: params.mode,
        balance: params.balance,
        settings: params.settings
      })} ${buildCurrentDateTimeInstruction()} ${params.renderInstructions.systemPrompt} Render only the supplied tool result. Do not call tools, do not invent facts, and do not broaden into free-form chat.`
    },
    ...(params.recentConversation ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: [
        `Original user message: ${params.userMessage}`,
        "Rendering constraints:",
        constraints,
        "Style hints:",
        styleHints,
        "Tool payload:",
        JSON.stringify(params.payload, null, 2)
      ].join("\n")
    }
  ];
}

function appendGroundedLinks(reply: string, evidence: WorldLookupEvidenceRecord[], maxLinks = 3): string {
  const uniqueLinks = Array.from(
    new Map(
      evidence
        .filter((record): record is WorldLookupEvidenceRecord & { url: string } => typeof record.url === "string" && record.url.length > 0)
        .map((record) => [record.url, record])
    ).values()
  ).slice(0, maxLinks);

  if (uniqueLinks.length === 0) {
    return reply;
  }

  return `${reply.trimEnd()}\n\nLinks:\n${uniqueLinks.map((record) => `- ${record.url}`).join("\n")}`;
}

function formatWorldLookupSource(source: WorldLookupSourceName): string {
  switch (source) {
    case "newsdata":
      return "NewsData.io";
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
