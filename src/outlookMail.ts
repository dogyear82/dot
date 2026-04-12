import type { AppConfig } from "./config.js";
import { MicrosoftOutlookOAuthClient, OutlookOAuthConfigurationError } from "./outlookOAuth.js";
import type { OutlookMailFolder, OutlookMailMessage } from "./types.js";

interface GraphListResponse<TValue> {
  value?: TValue[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface GraphEmailAddress {
  address?: string | null;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

interface GraphMessage {
  id?: string | null;
  subject?: string | null;
  from?: GraphRecipient | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  parentFolderId?: string | null;
  webLink?: string | null;
  "@removed"?: {
    reason?: string;
  } | null;
}

interface GraphMailFolder {
  id?: string | null;
  displayName?: string | null;
}

interface GraphDraftMessage {
  id?: string | null;
  webLink?: string | null;
}

export interface OutlookMailDeltaResult {
  messages: OutlookMailMessage[];
  deltaCursor: string | null;
}

export interface OutlookMailDraft {
  id: string;
  webLink: string | null;
}

export interface OutlookMailClient {
  syncInboxDelta(deltaCursor?: string | null, options?: { receivedAfter?: string | null }): Promise<OutlookMailDeltaResult>;
  ensureFolder(displayName: string): Promise<OutlookMailFolder>;
  moveMessageToFolder(messageId: string, destinationFolderId: string): Promise<void>;
  createDraft(params: { to: string; subject: string; body: string }): Promise<OutlookMailDraft>;
  sendDraft(messageId: string): Promise<void>;
}

export class OutlookMailConfigurationError extends Error {}
export class OutlookMailDeltaCursorError extends Error {}

export class MicrosoftGraphOutlookMailClient implements OutlookMailClient {
  constructor(
    private readonly config: Pick<
      AppConfig,
      | "OUTLOOK_ACCESS_TOKEN"
      | "OUTLOOK_GRAPH_BASE_URL"
      | "OUTLOOK_CLIENT_ID"
      | "OUTLOOK_TENANT_ID"
      | "OUTLOOK_OAUTH_SCOPES"
      | "OUTLOOK_REQUEST_TIMEOUT_MS"
    >,
    private readonly oauthClient?: MicrosoftOutlookOAuthClient
  ) {}

  async syncInboxDelta(deltaCursor?: string | null, options: { receivedAfter?: string | null } = {}): Promise<OutlookMailDeltaResult> {
    const accessToken = await this.resolveAccessToken();
    let url = deltaCursor
      ? new URL(deltaCursor)
      : buildInitialDeltaUrl(this.config.OUTLOOK_GRAPH_BASE_URL, options.receivedAfter ?? null);
    const messages: OutlookMailMessage[] = [];
    let deltaLink: string | null = null;

    while (true) {
      const payload = await this.fetchJson<GraphListResponse<GraphMessage>>(url, accessToken, {
        deltaCursorRequest: Boolean(deltaCursor),
        headers: {
          Prefer: "odata.maxpagesize=100"
        }
      });

      for (const message of payload.value ?? []) {
        const mapped = mapGraphMessage(message);
        if (mapped) {
          messages.push(mapped);
        }
      }

      if (payload["@odata.nextLink"]) {
        url = new URL(payload["@odata.nextLink"]);
        continue;
      }

      deltaLink = payload["@odata.deltaLink"] ?? deltaCursor ?? null;
      break;
    }

    return {
      messages,
      deltaCursor: deltaLink
    };
  }

  async ensureFolder(displayName: string): Promise<OutlookMailFolder> {
    const accessToken = await this.resolveAccessToken();
    const encodedName = displayName.replace(/'/g, "''");
    let lookupUrl = new URL(`${this.config.OUTLOOK_GRAPH_BASE_URL}/me/mailFolders`);
    lookupUrl.searchParams.set("$filter", `displayName eq '${encodedName}'`);
    lookupUrl.searchParams.set("$select", "id,displayName");

    while (true) {
      const lookup = await this.fetchJson<GraphListResponse<GraphMailFolder>>(lookupUrl, accessToken);
      const existing = lookup.value?.map(mapGraphMailFolder).find((folder): folder is OutlookMailFolder => folder != null);
      if (existing) {
        return existing;
      }

      if (!lookup["@odata.nextLink"]) {
        break;
      }

      lookupUrl = new URL(lookup["@odata.nextLink"]);
    }

    const response = await fetch(`${this.config.OUTLOOK_GRAPH_BASE_URL}/me/mailFolders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      signal: createTimeoutSignal(this.config.OUTLOOK_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ displayName })
    });

    if (!response.ok) {
      throw new Error(`Outlook mail folder create request failed: ${response.status} ${await response.text()}`.trim());
    }

    const created = mapGraphMailFolder((await response.json()) as GraphMailFolder);
    if (!created) {
      throw new Error("Outlook mail folder create request returned an invalid folder payload");
    }

    return created;
  }

  async moveMessageToFolder(messageId: string, destinationFolderId: string): Promise<void> {
    const accessToken = await this.resolveAccessToken(["Mail.ReadWrite"]);
    const response = await fetch(`${this.config.OUTLOOK_GRAPH_BASE_URL}/me/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      signal: createTimeoutSignal(this.config.OUTLOOK_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ destinationId: destinationFolderId })
    });

    if (!response.ok) {
      throw new Error(`Outlook mail move request failed: ${response.status} ${await response.text()}`.trim());
    }
  }

  async createDraft(params: { to: string; subject: string; body: string }): Promise<OutlookMailDraft> {
    const accessToken = await this.resolveAccessToken(["Mail.ReadWrite"]);
    const response = await fetch(`${this.config.OUTLOOK_GRAPH_BASE_URL}/me/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      signal: createTimeoutSignal(this.config.OUTLOOK_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        subject: params.subject,
        body: {
          contentType: "Text",
          content: params.body
        },
        toRecipients: [
          {
            emailAddress: {
              address: params.to
            }
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Outlook mail draft create request failed: ${response.status} ${await response.text()}`.trim());
    }

    const draft = mapGraphDraftMessage((await response.json()) as GraphDraftMessage);
    if (!draft) {
      throw new Error("Outlook mail draft create request returned an invalid draft payload");
    }

    return draft;
  }

  async sendDraft(messageId: string): Promise<void> {
    const accessToken = await this.resolveAccessToken(["Mail.Send"]);
    const response = await fetch(`${this.config.OUTLOOK_GRAPH_BASE_URL}/me/messages/${encodeURIComponent(messageId)}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      signal: createTimeoutSignal(this.config.OUTLOOK_REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Outlook mail send request failed: ${response.status} ${await response.text()}`.trim());
    }
  }

  private async resolveAccessToken(requiredScopes: string[] = ["Mail.ReadWrite"]): Promise<string> {
    if (this.oauthClient) {
      try {
        const token = await this.oauthClient.getValidAccessToken();
        if (this.oauthClient.hasStoredToken() && !this.oauthClient.hasStoredScopes(requiredScopes)) {
          throw new OutlookMailConfigurationError(
            `Outlook mail access requires reauthorization with \`${requiredScopes.join("`, `")}\`. Run \`!calendar auth start\` and \`!calendar auth complete\` again.`
          );
        }
        return token;
      } catch (error) {
        if (!(error instanceof OutlookOAuthConfigurationError)) {
          throw error;
        }

        if (!this.config.OUTLOOK_ACCESS_TOKEN) {
          throw new OutlookMailConfigurationError(error.message);
        }
      }
    }

    if (this.config.OUTLOOK_ACCESS_TOKEN) {
      return this.config.OUTLOOK_ACCESS_TOKEN;
    }

    throw new OutlookMailConfigurationError(
      "Outlook mail integration is not configured. Run `!calendar auth start` after setting `OUTLOOK_CLIENT_ID`."
    );
  }

  private async fetchJson<TPayload>(
    url: URL,
    accessToken: string,
    options: { deltaCursorRequest?: boolean; headers?: Record<string, string> } = {}
  ): Promise<TPayload> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers ?? {})
      },
      signal: createTimeoutSignal(this.config.OUTLOOK_REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const detail = await response.text();
      if (options.deltaCursorRequest && [400, 404, 410].includes(response.status)) {
        throw new OutlookMailDeltaCursorError(`Outlook mail delta cursor is no longer valid: ${response.status} ${detail}`.trim());
      }

      throw new Error(`Outlook mail request failed: ${response.status} ${detail}`.trim());
    }

    return (await response.json()) as TPayload;
  }
}

function buildInitialDeltaUrl(baseUrl: string, receivedAfter: string | null): URL {
  const url = new URL(`${baseUrl}/me/mailFolders/inbox/messages/delta`);
  url.searchParams.set("$select", "id,subject,from,receivedDateTime,bodyPreview,parentFolderId,webLink");
  url.searchParams.set("$orderby", "receivedDateTime desc");
  if (receivedAfter) {
    url.searchParams.set("$filter", `receivedDateTime ge ${receivedAfter}`);
  }
  return url;
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function mapGraphMessage(message: GraphMessage): OutlookMailMessage | null {
  if (message["@removed"] || !message.id || !message.receivedDateTime) {
    return null;
  }

  return {
    id: message.id,
    subject: message.subject ?? "",
    from: message.from?.emailAddress?.address ?? null,
    receivedAt: message.receivedDateTime,
    bodyPreview: message.bodyPreview ?? "",
    parentFolderId: message.parentFolderId ?? null,
    webLink: message.webLink ?? null
  };
}

function mapGraphMailFolder(folder: GraphMailFolder): OutlookMailFolder | null {
  if (!folder.id || !folder.displayName) {
    return null;
  }

  return {
    id: folder.id,
    displayName: folder.displayName
  };
}

function mapGraphDraftMessage(message: GraphDraftMessage): OutlookMailDraft | null {
  if (!message.id) {
    return null;
  }

  return {
    id: message.id,
    webLink: message.webLink ?? null
  };
}
