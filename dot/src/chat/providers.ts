export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatProvider {
  name: string;
  route: "local" | "hosted";
  isAvailable(): boolean;
  generate(messages: ChatMessage[], model?: string): Promise<string>;
}

export class OllamaChatProvider implements ChatProvider {
  readonly name = "ollama";
  readonly route = "local";

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  isAvailable(): boolean {
    return Boolean(this.baseUrl && this.model);
  }

  async generate(messages: ChatMessage[], model?: string): Promise<string> {
    const response = await withTimeout(
      this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model ?? this.model,
          stream: false,
          messages
        })
      }),
      this.timeoutMs
    );

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { message?: { content?: string } };
    const content = payload.message?.content?.trim();

    if (!content) {
      throw new Error("Ollama returned an empty response");
    }

    return content;
  }
}

export class OneMinAiChatProvider implements ChatProvider {
  readonly name = "1minai";
  readonly route = "hosted";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  isAvailable(): boolean {
    return Boolean(this.baseUrl && this.apiKey && this.model);
  }

  async generate(messages: ChatMessage[], model?: string): Promise<string> {
    const response = await withTimeout(
      this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/chat-with-ai`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-KEY": this.apiKey
        },
        body: JSON.stringify({
          type: "UNIFY_CHAT_WITH_AI",
          model: model ?? this.model,
          promptObject: {
            prompt: formatOneMinAiPrompt(messages)
          }
        })
      }),
      this.timeoutMs
    );

    if (!response.ok) {
      throw new Error(`1minAI request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      aiRecord?: {
        aiRecordDetail?: {
          resultObject?: string[];
        };
      };
    };
    const content = payload.aiRecord?.aiRecordDetail?.resultObject?.join("\n").trim();

    if (!content) {
      throw new Error("1minAI returned an empty response");
    }

    return content;
  }
}

function formatOneMinAiPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n")
    .trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
