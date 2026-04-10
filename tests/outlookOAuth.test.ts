import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { MicrosoftOutlookOAuthClient, OutlookOAuthConfigurationError } from "../src/outlookOAuth.js";
import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-outlook-oauth-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test("startDeviceAuthorization stores the pending Microsoft device flow", async () => {
  const { persistence, cleanup } = createPersistence();
  const fetchMock = mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(String(input), "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode");
    assert.equal(init?.method, "POST");

    return new Response(
      JSON.stringify({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
        message: "Open the page and enter the code."
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const client = new MicrosoftOutlookOAuthClient(
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_OWNER_USER_ID: "owner",
        OUTLOOK_CLIENT_ID: "client-123"
      }),
      persistence
    );

    const flow = await client.startDeviceAuthorization(new Date("2026-04-09T00:00:00.000Z"));
    assert.equal(flow.userCode, "ABCD-EFGH");
    assert.equal(persistence.getOAuthDeviceFlow("microsoft_graph")?.deviceCode, "device-code");
  } finally {
    fetchMock.mock.restore();
    cleanup();
  }
});

test("completeDeviceAuthorization stores durable tokens", async () => {
  const { persistence, cleanup } = createPersistence();
  persistence.saveOAuthDeviceFlow({
    provider: "microsoft_graph",
    deviceCode: "device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://microsoft.com/devicelogin",
    verificationUriComplete: null,
    expiresAt: "2026-04-09T01:00:00.000Z",
    intervalSeconds: 5,
    message: "Open the page and enter the code."
  });

  const fetchMock = mock.method(globalThis, "fetch", async () => {
    return new Response(
      JSON.stringify({
        access_token: "access-123",
        refresh_token: "refresh-123",
        expires_in: 3600,
        scope: "Calendars.Read",
        token_type: "Bearer"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const client = new MicrosoftOutlookOAuthClient(
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_OWNER_USER_ID: "owner",
        OUTLOOK_CLIENT_ID: "client-123"
      }),
      persistence
    );

    const reply = await client.completeDeviceAuthorization(new Date("2026-04-09T00:00:00.000Z"));
    assert.match(reply, /authorization complete/i);
    assert.equal(persistence.getOAuthToken("microsoft_graph")?.accessToken, "access-123");
    assert.equal(persistence.getOAuthDeviceFlow("microsoft_graph"), null);
  } finally {
    fetchMock.mock.restore();
    cleanup();
  }
});

test("getValidAccessToken refreshes expired OAuth tokens", async () => {
  const { persistence, cleanup } = createPersistence();
  persistence.saveOAuthToken({
    provider: "microsoft_graph",
    accessToken: "expired-token",
    refreshToken: "refresh-123",
    expiresAt: "2026-04-09T00:00:00.000Z",
    scope: "Calendars.Read",
    tokenType: "Bearer"
  });

  const fetchMock = mock.method(globalThis, "fetch", async () => {
    return new Response(
      JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-456",
        expires_in: 3600,
        scope: "Calendars.Read",
        token_type: "Bearer"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const client = new MicrosoftOutlookOAuthClient(
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_OWNER_USER_ID: "owner",
        OUTLOOK_CLIENT_ID: "client-123"
      }),
      persistence
    );

    const token = await client.getValidAccessToken(new Date("2026-04-09T00:05:00.000Z"));
    assert.equal(token, "fresh-token");
    assert.equal(persistence.getOAuthToken("microsoft_graph")?.refreshToken, "refresh-456");
  } finally {
    fetchMock.mock.restore();
    cleanup();
  }
});

test("getValidAccessToken reports a clear recovery path when OAuth is unconfigured", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const client = new MicrosoftOutlookOAuthClient(
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_OWNER_USER_ID: "owner"
      }),
      persistence
    );

    await assert.rejects(
      client.getValidAccessToken(),
      (error: unknown) =>
        error instanceof OutlookOAuthConfigurationError && /OUTLOOK_CLIENT_ID/.test(error.message)
    );
  } finally {
    cleanup();
  }
});
