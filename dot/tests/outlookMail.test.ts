import test from "node:test";
import assert from "node:assert/strict";

import { MicrosoftGraphOutlookMailClient } from "../src/outlookMail.js";

function createMailConfig(overrides: Record<string, unknown> = {}) {
  return {
    OUTLOOK_ACCESS_TOKEN: "token",
    OUTLOOK_CLIENT_ID: "",
    OUTLOOK_TENANT_ID: "common",
    OUTLOOK_OAUTH_SCOPES: "scope",
    OUTLOOK_GRAPH_BASE_URL: "https://graph.microsoft.com/v1.0",
    OUTLOOK_REQUEST_TIMEOUT_MS: 20000,
    ...overrides
  };
}

test("Outlook mail delta follows next links and returns only non-removed messages", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    requests.push(url);

    if (url.includes("/delta?") && !url.includes("$skiptoken=")) {
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "m1",
              subject: "hello",
              receivedDateTime: "2026-04-10T00:00:00.000Z",
              bodyPreview: "preview 1",
              from: { emailAddress: { address: "a@example.com" } }
            }
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        value: [
          {
            id: "m2",
            subject: "bye",
            receivedDateTime: "2026-04-10T00:01:00.000Z",
            bodyPreview: "preview 2",
            from: { emailAddress: { address: "b@example.com" } }
          },
          {
            id: "m3",
            "@removed": { reason: "deleted" },
            receivedDateTime: "2026-04-10T00:02:00.000Z"
          }
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=xyz"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);

    const result = await client.syncInboxDelta();

    assert.equal(requests.length, 2);
    assert.doesNotMatch(requests[0] ?? "", /\$filter=/);
    assert.equal(result.deltaCursor, "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=xyz");
    assert.deepEqual(
      result.messages.map((message) => ({ id: message.id, subject: message.subject, from: message.from })),
      [
        { id: "m1", subject: "hello", from: "a@example.com" },
        { id: "m2", subject: "bye", from: "b@example.com" }
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail delta scopes the initial baseline to the provided lookback timestamp", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=xyz"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);
    await client.syncInboxDelta(null, { receivedAfter: "2026-04-05T00:00:00.000Z" });

    assert.equal(requests.length, 1);
    assert.match(requests[0] ?? "", /%24filter=receivedDateTime\+ge\+2026-04-05T00%3A00%3A00.000Z/);
    assert.match(requests[0] ?? "", /%24orderby=receivedDateTime\+desc/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail ensureFolder returns an existing folder when present", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(
      JSON.stringify({
        value: [{ id: "folder-1", displayName: "Dot Approved" }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);

    const folder = await client.ensureFolder("Dot Approved");
    assert.deepEqual(folder, { id: "folder-1", displayName: "Dot Approved" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail ensureFolder creates the folder when missing", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });

    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ id: "folder-2", displayName: "Dot Approved" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);

    const folder = await client.ensureFolder("Dot Approved");
    assert.deepEqual(folder, { id: "folder-2", displayName: "Dot Approved" });
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "POST"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail ensureFolder follows pagination before creating a folder", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });

    if (url.includes("page=2")) {
      return new Response(
        JSON.stringify({
          value: [{ id: "folder-9", displayName: "Dot Approved" }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        value: [],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders?page=2"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);

    const folder = await client.ensureFolder("Dot Approved");
    assert.deepEqual(folder, { id: "folder-9", displayName: "Dot Approved" });
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "GET"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail requires reauthorization when stored OAuth scopes do not include mail access", async () => {
  const client = new MicrosoftGraphOutlookMailClient(
    createMailConfig({
      OUTLOOK_ACCESS_TOKEN: "",
      OUTLOOK_CLIENT_ID: "client-id",
      OUTLOOK_OAUTH_SCOPES: "offline_access openid profile User.Read Calendars.Read Mail.ReadWrite"
    }),
    {
      async getValidAccessToken() {
        return "token";
      },
      hasStoredToken() {
        return true;
      },
      hasStoredScopes(requiredScopes: string[]) {
        return requiredScopes.includes("Calendars.Read");
      }
    } as never
  );

  await assert.rejects(
    () => client.syncInboxDelta(),
    /Mail\.ReadWrite/
  );
});

test("Outlook mail createDraft posts a draft message and returns the Outlook draft id", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string | null }> = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null
    });

    return new Response(JSON.stringify({ id: "draft-1", webLink: "https://outlook.example/draft-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);
    const draft = await client.createDraft({
      to: "michelle@example.com",
      subject: "Hello",
      body: "Checking in."
    });

    assert.deepEqual(draft, {
      id: "draft-1",
      webLink: "https://outlook.example/draft-1"
    });
    assert.equal(requests[0]?.method, "POST");
    assert.match(requests[0]?.url ?? "", /\/me\/messages$/);
    assert.match(requests[0]?.body ?? "", /michelle@example\.com/);
    assert.match(requests[0]?.body ?? "", /Checking in\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail sendDraft posts to the draft send endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);
    await client.sendDraft("draft-123");

    assert.equal(requests[0]?.method, "POST");
    assert.match(requests[0]?.url ?? "", /\/me\/messages\/draft-123\/send$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail sendDraft requires reauthorization when stored OAuth scopes do not include Mail.Send", async () => {
  const client = new MicrosoftGraphOutlookMailClient(
    createMailConfig({
      OUTLOOK_ACCESS_TOKEN: "",
      OUTLOOK_CLIENT_ID: "client-id",
      OUTLOOK_OAUTH_SCOPES: "offline_access openid profile User.Read Calendars.Read Mail.ReadWrite Mail.Send"
    }),
    {
      async getValidAccessToken() {
        return "token";
      },
      hasStoredToken() {
        return true;
      },
      hasStoredScopes(requiredScopes: string[]) {
        return !requiredScopes.includes("Mail.Send");
      }
    } as never
  );

  await assert.rejects(
    () => client.sendDraft("draft-123"),
    /Mail\.Send/
  );
});

test("Outlook mail still works with legacy OUTLOOK_ACCESS_TOKEN fallback when no OAuth token is stored", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=xyz"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(
      createMailConfig({
        OUTLOOK_ACCESS_TOKEN: "",
        OUTLOOK_CLIENT_ID: "client-id",
        OUTLOOK_OAUTH_SCOPES: "offline_access openid profile User.Read Calendars.Read Mail.ReadWrite"
      }),
      {
        async getValidAccessToken() {
          return "legacy-token";
        },
        hasStoredScopes() {
          return false;
        },
        hasStoredToken() {
          return false;
        }
      } as never
    );

    const result = await client.syncInboxDelta();
    assert.equal(result.deltaCursor, "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=xyz");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook mail move sends the Graph move request", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; method: string; body: string | null } | null = null;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    request = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null
    };

    return new Response(JSON.stringify({ id: "moved" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const client = new MicrosoftGraphOutlookMailClient(createMailConfig(), undefined);

    await client.moveMessageToFolder("msg-1", "folder-1");

    assert.deepEqual(request, {
      url: "https://graph.microsoft.com/v1.0/me/messages/msg-1/move",
      method: "POST",
      body: JSON.stringify({ destinationId: "folder-1" })
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
