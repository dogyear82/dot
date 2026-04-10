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

export interface OutlookMailDeltaResult {
  messages: OutlookMailMessage[];
  deltaCursor: string | null;
}

export interface OutlookMailClient {
  syncInboxDelta(deltaCursor?: string | null): Promise<OutlookMailDeltaResult>;
  ensureFolder(displayName: string): Promise<OutlookMailFolder>;
  moveMessageToFolder(messageId: string, destinationFolderId: string): Promise<void>;
}

export class OutlookMailConfigurationError extends Error {}
export class OutlookMailDeltaCursorError extends Error {}

export class MicrosoftGraphOutlookMailClient implements OutlookMailClient {
  constructor(
    private readonly config: Pick<
      AppConfig,
      "OUTLOOK_ACCESS_TOKEN" | "OUTLOOK_GRAPH_BASE_URL" | "OUTLOOK_CLIENT_ID" | "OUTLOOK_TENANT_ID" | "OUTLOOK_OAUTH_SCOPES"
    >,
    private readonly oauthClient?: MicrosoftOutlookOAuthClient
  ) {}

  async syncInboxDelta(deltaCursor?: string | null): Promise<OutlookMailDeltaResult> {
    const accessToken = await this.resolveAccessToken();
    let url = deltaCursor
      ? new URL(deltaCursor)
      : new URL(
          `${this.config.OUTLOOK_GRAPH_BASE_URL}/me/mailFolders/inbox/messages/delta?$select=id,subject,from,receivedDateTime,bodyPreview,parentFolderId,webLink`
        );
    const messages: OutlookMailMessage[] = [];
    let deltaLink: string | null = null;

    while (true) {
      const payload = await this.fetchJson<GraphListResponse<GraphMessage>>(url, accessToken, {
        deltaCursorRequest: Boolean(deltaCursor)
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
    const accessToken = await this.resolveAccessToken();
    const response = await fetch(`${this.config.OUTLOOK_GRAPH_BASE_URL}/me/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ destinationId: destinationFolderId })
    });

    if (!response.ok) {
      throw new Error(`Outlook mail move request failed: ${response.status} ${await response.text()}`.trim());
    }
  }

  private async resolveAccessToken(): Promise<string> {
    if (this.oauthClient) {
      try {
        const token = await this.oauthClient.getValidAccessToken();
        if (this.oauthClient.hasStoredToken() && !this.oauthClient.hasStoredScopes(["Mail.ReadWrite"])) {
          throw new OutlookMailConfigurationError(
            "Outlook mail access requires reauthorization with `Mail.ReadWrite`. Run `!calendar auth start` and `!calendar auth complete` again."
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
    options: { deltaCursorRequest?: boolean } = {}
  ): Promise<TPayload> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
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
