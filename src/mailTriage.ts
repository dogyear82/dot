import { SpanKind } from "@opentelemetry/api";

import type { AppConfig } from "./config.js";
import { startLlmTimer, withSpan } from "./observability.js";
import type { SettingsStore } from "./settings.js";
import type { MailTriageOutcome, MailTriageSource, OutlookMailMessage } from "./types.js";
import { getLlmMode, orderProvidersForMode, type LlmRoute } from "./chat/modelRouter.js";
import { OllamaChatProvider, OneMinAiChatProvider, type ChatMessage, type ChatProvider } from "./chat/providers.js";

export interface MailTriageDecision {
  outcome: MailTriageOutcome;
  source: MailTriageSource;
  reason: string;
  route: LlmRoute;
}

export interface MailTriageService {
  triageMessage(message: OutlookMailMessage): Promise<MailTriageDecision>;
}

export function createMailTriageService(params: {
  config: AppConfig;
  settings: SettingsStore;
  providers?: ChatProvider[];
}): MailTriageService {
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
  const whitelist = parseWhitelist(params.config.OUTLOOK_MAIL_WHITELIST);

  return {
    async triageMessage(message) {
      const deterministicDecision = classifyDeterministically(message, whitelist);
      if (deterministicDecision) {
        return deterministicDecision;
      }

      try {
        return await classifyWithLlm({
          message,
          providers,
          settings: params.settings
        });
      } catch (error) {
        return {
          outcome: "needs_attention",
          source: "fallback",
          reason: `LLM triage fallback: ${formatError(error)}`,
          route: "none"
        };
      }
    }
  };
}

export function parseWhitelist(value: string): Set<string> {
  return new Set(
    value
      .split(/[,\n]/)
      .map((entry) => normalizeEmail(entry))
      .filter((entry): entry is string => Boolean(entry))
  );
}

export function classifyDeterministically(
  message: OutlookMailMessage,
  whitelist: ReadonlySet<string>
): MailTriageDecision | null {
  const sender = normalizeEmail(message.from);
  if (sender && whitelist.has(sender)) {
    return {
      outcome: "dot_approved",
      source: "whitelist",
      reason: `Trusted sender whitelist match for ${sender}`,
      route: "deterministic"
    };
  }

  const suspiciousReason = detectSuspiciousMail(message);
  if (suspiciousReason) {
    return {
      outcome: "needs_attention",
      source: "heuristic",
      reason: suspiciousReason,
      route: "deterministic"
    };
  }

  const marketingReason = detectMarketingMail(message);
  if (marketingReason) {
    return {
      outcome: "ignore",
      source: "heuristic",
      reason: marketingReason,
      route: "deterministic"
    };
  }

  return null;
}

async function classifyWithLlm(params: {
  message: OutlookMailMessage;
  providers: ChatProvider[];
  settings: SettingsStore;
}): Promise<MailTriageDecision> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You triage Outlook email for a personal assistant. Return only strict JSON with keys outcome and reason. " +
        "Valid outcome values are exactly: dot_approved, needs_attention, ignore. " +
        "Policy: dot_approved is only for legitimate, personally relevant, non-marketing mail. " +
        "needs_attention is for suspicious, phishing-like, risky, or ambiguous mail. " +
        "ignore is only for obvious low-value marketing, newsletters, promotions, or bulk mail. " +
        "Be conservative. If unsure, choose needs_attention."
    },
    {
      role: "user",
      content: buildMailTriagePrompt(params.message)
    }
  ];

  const result = await executeProviderRequest({
    mode: getLlmMode(params.settings),
    providers: params.providers,
    operation: "mail.triage",
    invoke: async (provider) => parseMailTriageDecision(await provider.generate(messages)),
    failurePrefix: "No LLM provider could classify Outlook mail."
  });

  return {
    ...result.reply,
    route: result.route
  };
}

function buildMailTriagePrompt(message: OutlookMailMessage): string {
  return [
    "Classify this Outlook message.",
    `From: ${message.from ?? "(missing sender)"}`,
    `Subject: ${message.subject || "(no subject)"}`,
    `ReceivedAt: ${message.receivedAt}`,
    `BodyPreview: ${message.bodyPreview || "(empty)"}`,
    "Return strict JSON like {\"outcome\":\"needs_attention\",\"reason\":\"...\"}."
  ].join("\n");
}

function parseMailTriageDecision(raw: string): Omit<MailTriageDecision, "route"> {
  const candidate = extractJsonObject(raw);
  const payload = JSON.parse(candidate) as {
    outcome?: string;
    reason?: string;
  };

  if (
    payload.outcome !== "dot_approved" &&
    payload.outcome !== "needs_attention" &&
    payload.outcome !== "ignore"
  ) {
    throw new Error("LLM mail triage returned an invalid outcome");
  }

  return {
    outcome: payload.outcome,
    source: "llm",
    reason: sanitizeReason(payload.reason)
  };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("LLM mail triage did not return JSON");
  }

  return match[0];
}

function sanitizeReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, 240) : "LLM triage decision";
}

async function executeProviderRequest<T>(params: {
  mode: ReturnType<typeof getLlmMode>;
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

function detectMarketingMail(message: OutlookMailMessage): string | null {
  const haystack = `${message.subject}\n${message.bodyPreview}`.toLowerCase();
  const keywords = [
    "unsubscribe",
    "manage preferences",
    "view in browser",
    "newsletter",
    "sale",
    "discount",
    "% off",
    "limited time",
    "special offer",
    "promo",
    "promotion",
    "coupon",
    "shop now",
    "deals"
  ];

  const matches = keywords.filter((keyword) => haystack.includes(keyword));
  if (matches.length === 0) {
    return null;
  }

  if (haystack.includes("unsubscribe") || matches.length >= 2) {
    return `Deterministic marketing/bulk signal: ${matches.slice(0, 3).join(", ")}`;
  }

  return null;
}

function detectSuspiciousMail(message: OutlookMailMessage): string | null {
  const haystack = `${message.subject}\n${message.bodyPreview}`.toLowerCase();
  const urgentKeywords = ["urgent", "immediately", "action required", "final notice", "suspended", "verify", "confirm"];
  const credentialKeywords = ["password", "login", "account", "payment", "bank", "gift card", "wire transfer", "invoice"];
  const suspiciousPhrases = [
    "verify your account",
    "confirm your password",
    "account suspended",
    "unusual activity",
    "click the link below",
    "payment declined",
    "gift card",
    "wire transfer"
  ];
  const sender = normalizeEmail(message.from);
  const suspiciousSenderPattern = sender ? /[a-z][01][a-z]|rn|vv/.test(sender.split("@")[0] ?? "") : false;

  const urgencyHits = urgentKeywords.filter((keyword) => haystack.includes(keyword));
  const credentialHits = credentialKeywords.filter((keyword) => haystack.includes(keyword));
  const phraseHits = suspiciousPhrases.filter((phrase) => haystack.includes(phrase));

  if (phraseHits.length > 0 || (urgencyHits.length > 0 && credentialHits.length > 0)) {
    return `Deterministic suspicious-mail signal: ${[...phraseHits, ...urgencyHits, ...credentialHits].slice(0, 3).join(", ")}`;
  }

  if (suspiciousSenderPattern && urgencyHits.length > 0) {
    return `Sender address and urgency signal look suspicious: ${sender}`;
  }

  return null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
