import type { AppConfig } from "./config.js";
import type { Persistence } from "./persistence.js";
import type { OAuthDeviceFlowRecord, OAuthTokenRecord } from "./types.js";

const MICROSOFT_GRAPH_PROVIDER = "microsoft_graph";
const REFRESH_SKEW_MS = 60_000;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
  message: string;
}

interface TokenSuccessResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

export class OutlookOAuthConfigurationError extends Error {}

export class MicrosoftOutlookOAuthClient {
  constructor(
    private readonly config: Pick<AppConfig, "OUTLOOK_ACCESS_TOKEN" | "OUTLOOK_CLIENT_ID" | "OUTLOOK_TENANT_ID" | "OUTLOOK_OAUTH_SCOPES">,
    private readonly persistence: Persistence
  ) {}

  async startDeviceAuthorization(now = new Date()): Promise<OAuthDeviceFlowRecord> {
    ensureClientId(this.config.OUTLOOK_CLIENT_ID);

    const response = await fetch(this.deviceCodeUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: this.config.OUTLOOK_CLIENT_ID,
        scope: this.config.OUTLOOK_OAUTH_SCOPES
      })
    });

    if (!response.ok) {
      throw new Error(`Microsoft device authorization request failed: ${response.status} ${await response.text()}`.trim());
    }

    const payload = (await response.json()) as DeviceCodeResponse;
    const flow: OAuthDeviceFlowRecord = {
      provider: MICROSOFT_GRAPH_PROVIDER,
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      verificationUriComplete: payload.verification_uri_complete ?? null,
      expiresAt: new Date(now.getTime() + payload.expires_in * 1000).toISOString(),
      intervalSeconds: payload.interval ?? 5,
      message: payload.message
    };

    this.persistence.saveOAuthDeviceFlow(flow);
    return flow;
  }

  async completeDeviceAuthorization(now = new Date()): Promise<string> {
    ensureClientId(this.config.OUTLOOK_CLIENT_ID);
    const flow = this.persistence.getOAuthDeviceFlow(MICROSOFT_GRAPH_PROVIDER);
    if (!flow) {
      return "No Outlook authorization is currently pending. Run `!calendar auth start` first.";
    }

    if (Date.parse(flow.expiresAt) <= now.getTime()) {
      this.persistence.clearOAuthDeviceFlow(MICROSOFT_GRAPH_PROVIDER);
      return "The pending Outlook device code expired. Run `!calendar auth start` to begin again.";
    }

    const response = await fetch(this.tokenUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: this.config.OUTLOOK_CLIENT_ID,
        device_code: flow.deviceCode
      })
    });

    const payload = (await response.json()) as TokenSuccessResponse | TokenErrorResponse;
    if (!response.ok) {
      if ("error" in payload) {
        if (payload.error === "authorization_pending" || payload.error === "slow_down") {
          return `Outlook authorization is still pending. Finish the Microsoft sign-in step, then run \`!calendar auth complete\` again.`;
        }

        if (payload.error === "expired_token" || payload.error === "authorization_declined" || payload.error === "bad_verification_code") {
          this.persistence.clearOAuthDeviceFlow(MICROSOFT_GRAPH_PROVIDER);
          return "The pending Outlook authorization can no longer be completed. Run `!calendar auth start` to begin again.";
        }
      }

      throw new Error(formatMicrosoftAuthError(response.status, payload));
    }

    this.persistence.saveOAuthToken(mapTokenRecord(payload as TokenSuccessResponse, now));
    this.persistence.clearOAuthDeviceFlow(MICROSOFT_GRAPH_PROVIDER);
    return "Outlook authorization complete. Calendar commands can now use durable OAuth tokens.";
  }

  getAuthorizationStatus(now = new Date()): string {
    const token = this.persistence.getOAuthToken(MICROSOFT_GRAPH_PROVIDER);
    if (token) {
      return Date.parse(token.expiresAt) > now.getTime()
        ? `Outlook authorization is active until ${token.expiresAt}.`
        : "Outlook authorization is stored but the current access token is expired and will be refreshed on next use.";
    }

    const flow = this.persistence.getOAuthDeviceFlow(MICROSOFT_GRAPH_PROVIDER);
    if (flow) {
      return `Outlook authorization is pending. Visit ${flow.verificationUri} and enter code ${flow.userCode}, then run \`!calendar auth complete\`.`;
    }

    return "Outlook authorization is not configured. Run `!calendar auth start` after setting `OUTLOOK_CLIENT_ID`.";
  }

  async getValidAccessToken(now = new Date()): Promise<string> {
    ensureClientId(this.config.OUTLOOK_CLIENT_ID);
    const token = this.persistence.getOAuthToken(MICROSOFT_GRAPH_PROVIDER);
    if (!token) {
      if (this.config.OUTLOOK_ACCESS_TOKEN) {
        return this.config.OUTLOOK_ACCESS_TOKEN;
      }

      throw new OutlookOAuthConfigurationError(
        "Outlook calendar integration is not configured. Run `!calendar auth start` after setting `OUTLOOK_CLIENT_ID`."
      );
    }

    if (Date.parse(token.expiresAt) - now.getTime() > REFRESH_SKEW_MS) {
      return token.accessToken;
    }

    if (!token.refreshToken) {
      this.persistence.clearOAuthToken(MICROSOFT_GRAPH_PROVIDER);
      throw new OutlookOAuthConfigurationError(
        "Outlook authorization expired and no refresh token is available. Run `!calendar auth start` to reconnect Microsoft."
      );
    }

    const response = await fetch(this.tokenUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.config.OUTLOOK_CLIENT_ID,
        refresh_token: token.refreshToken,
        scope: this.config.OUTLOOK_OAUTH_SCOPES
      })
    });

    const payload = (await response.json()) as TokenSuccessResponse | TokenErrorResponse;
    if (!response.ok) {
      this.persistence.clearOAuthToken(MICROSOFT_GRAPH_PROVIDER);

      if ("error" in payload && payload.error === "invalid_grant") {
        throw new OutlookOAuthConfigurationError(
          "Outlook authorization was revoked or expired beyond refresh. Run `!calendar auth start` to reconnect Microsoft."
        );
      }

      throw new Error(formatMicrosoftAuthError(response.status, payload));
    }

    const refreshedToken = mapTokenRecord(payload as TokenSuccessResponse, now, token.refreshToken);
    this.persistence.saveOAuthToken(refreshedToken);
    return refreshedToken.accessToken;
  }

  private deviceCodeUrl(): string {
    return `https://login.microsoftonline.com/${this.config.OUTLOOK_TENANT_ID}/oauth2/v2.0/devicecode`;
  }

  private tokenUrl(): string {
    return `https://login.microsoftonline.com/${this.config.OUTLOOK_TENANT_ID}/oauth2/v2.0/token`;
  }
}

function ensureClientId(clientId: string) {
  if (!clientId) {
    throw new OutlookOAuthConfigurationError(
      "Outlook OAuth is not configured. Set `OUTLOOK_CLIENT_ID` before running calendar auth commands."
    );
  }
}

function mapTokenRecord(
  payload: TokenSuccessResponse,
  now: Date,
  fallbackRefreshToken?: string | null
): OAuthTokenRecord {
  return {
    provider: MICROSOFT_GRAPH_PROVIDER,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? fallbackRefreshToken ?? null,
    expiresAt: new Date(now.getTime() + payload.expires_in * 1000).toISOString(),
    scope: payload.scope ?? null,
    tokenType: payload.token_type
  };
}

function formatMicrosoftAuthError(status: number, payload: TokenSuccessResponse | TokenErrorResponse): string {
  if ("error" in payload) {
    return `Microsoft OAuth request failed: ${status} ${payload.error}${payload.error_description ? ` ${payload.error_description}` : ""}`.trim();
  }

  return `Microsoft OAuth request failed: ${status}`;
}
