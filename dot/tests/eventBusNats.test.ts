import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createNatsEventBus } from "../src/eventBus.js";
import type { InboundMessageReceivedEvent } from "../src/events.js";

test("nats event bus publishes and subscribes with the canonical event envelope", async (t) => {
  const runtime = findContainerRuntime();
  if (!runtime) {
    t.skip("docker or podman is required for the NATS smoke test");
    return;
  }

  let containerId: string;
  try {
    containerId = startNatsContainer(runtime);
  } catch (error) {
    t.skip(formatError(error));
    return;
  }
  t.after(() => stopContainer(runtime, containerId));

  const port = lookupMappedPort(runtime, containerId);
  const url = `nats://127.0.0.1:${port}`;
  await waitForNats(url);

  const bus = await createNatsEventBus({ servers: url, name: "dot-test" });
  t.after(async () => {
    await bus.close();
  });

  const seen: InboundMessageReceivedEvent[] = [];
  const unsubscribe = bus.subscribe<InboundMessageReceivedEvent>("inbound.message.received", async (event) => {
    seen.push(event);
  });

  await bus.publishInboundMessage({
    eventId: "event-nats-1",
    eventType: "inbound.message.received",
    eventVersion: "1.0.0",
    occurredAt: "2026-04-09T00:00:00.000Z",
    producer: {
      service: "discord-ingress"
    },
    correlation: {
      correlationId: "msg-nats-1",
      causationId: null,
      conversationId: "channel-1",
      actorId: "owner-1"
    },
    routing: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyTo: "msg-nats-1"
    },
    diagnostics: {
      severity: "info",
      category: "discord.inbound"
    },
    payload: {
      messageId: "msg-nats-1",
      sender: {
        actorId: "owner-1",
        displayName: "owner",
        actorRole: "owner"
      },
      content: "hello from nats",
      addressedContent: "hello from nats",
      isDirectMessage: false,
      mentionedBot: true,
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-nats-1"
      }
    }
  });

  await waitFor(() => seen.length === 1, 5000, "timed out waiting for NATS message delivery");

  unsubscribe();

  assert.equal(seen[0]?.eventId, "event-nats-1");
  assert.equal(seen[0]?.correlation.correlationId, "msg-nats-1");
  assert.equal(seen[0]?.payload.messageId, "msg-nats-1");
  assert.equal(seen[0]?.payload.replyRoute.replyTo, "msg-nats-1");
});

function findContainerRuntime(): "docker" | "podman" | null {
  for (const runtime of ["docker", "podman"] as const) {
    const result = spawnSync("bash", ["-lc", `command -v ${runtime}`], { stdio: "ignore" });
    if (result.status === 0) {
      return runtime;
    }
  }

  return null;
}

function startNatsContainer(runtime: "docker" | "podman"): string {
  try {
    return execFileSync(runtime, ["run", "-d", "-P", "nats:2.10-alpine"], {
      encoding: "utf8"
    }).trim();
  } catch (error) {
    throw new Error(`unable to start NATS test container via ${runtime}: ${formatError(error)}`);
  }
}

function lookupMappedPort(runtime: "docker" | "podman", containerId: string): number {
  const output = execFileSync(runtime, ["port", containerId, "4222/tcp"], {
    encoding: "utf8"
  }).trim();
  const port = Number(output.split(":").at(-1));

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`unable to determine mapped NATS port from: ${output}`);
  }

  return port;
}

function stopContainer(runtime: "docker" | "podman", containerId: string) {
  spawnSync(runtime, ["rm", "-f", containerId], {
    stdio: "ignore"
  });
}

async function waitForNats(url: string) {
  await waitFor(async () => {
    try {
      const bus = await createNatsEventBus({ servers: url, name: "dot-readiness-check" });
      await bus.close();
      return true;
    } catch {
      return false;
    }
  }, 10000, `timed out waiting for NATS at ${url}`);
}

async function waitFor(predicate: (() => boolean | Promise<boolean>), timeoutMs: number, errorMessage: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(errorMessage);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
