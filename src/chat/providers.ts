export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatProvider {
  name: string;
  isAvailable(): boolean;
  generate(messages: ChatMessage[]): Promise<string>;
}

export class OllamaChatProvider implements ChatProvider {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  isAvailable(): boolean {
    return Boolean(this.baseUrl && this.model);
  }

  async generate(messages: ChatMessage[]): Promise<string> {
    const response = await withTimeout(
      this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
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

export class OpenAiCompatibleChatProvider implements ChatProvider {
  readonly name = "1minai";

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

  async generate(messages: ChatMessage[]): Promise<string> {
    const response = await withTimeout(
      this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages
        })
      }),
      this.timeoutMs
    );

    if (!response.ok) {
      throw new Error(`Hosted chat request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("Hosted provider returned an empty response");
    }

    return content;
  }
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
