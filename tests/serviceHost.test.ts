import assert from "node:assert/strict";
import test from "node:test";

import { createServiceCoordinator, createServiceHost } from "../src/runtime/serviceHost.js";

test("service coordinator starts hosts in order and stops them in reverse order", async () => {
  const events: string[] = [];
  const coordinator = createServiceCoordinator([
    createServiceHost({
      name: "first",
      start() {
        events.push("start:first");
      },
      stop() {
        events.push("stop:first");
      }
    }),
    createServiceHost({
      name: "second",
      start() {
        events.push("start:second");
      },
      stop() {
        events.push("stop:second");
      }
    })
  ]);

  await coordinator.startAll();
  assert.deepEqual(
    coordinator.getStatuses().map((status) => ({ name: status.name, readiness: status.readiness })),
    [
      { name: "first", readiness: "ready" },
      { name: "second", readiness: "ready" }
    ]
  );

  await coordinator.stopAll();

  assert.deepEqual(events, ["start:first", "start:second", "stop:second", "stop:first"]);
  assert.deepEqual(
    coordinator.getStatuses().map((status) => ({ name: status.name, readiness: status.readiness })),
    [
      { name: "first", readiness: "stopped" },
      { name: "second", readiness: "stopped" }
    ]
  );
});

test("service coordinator rolls back previously started hosts when startup fails", async () => {
  const events: string[] = [];
  const coordinator = createServiceCoordinator([
    createServiceHost({
      name: "first",
      start() {
        events.push("start:first");
      },
      stop() {
        events.push("stop:first");
      }
    }),
    createServiceHost({
      name: "second",
      start() {
        events.push("start:second");
        throw new Error("boom");
      },
      stop() {
        events.push("stop:second");
      }
    })
  ]);

  await assert.rejects(() => coordinator.startAll(), /boom/);

  assert.deepEqual(events, ["start:first", "start:second", "stop:first"]);
  assert.deepEqual(
    coordinator.getStatuses().map((status) => ({ name: status.name, readiness: status.readiness, detail: status.detail })),
    [
      { name: "first", readiness: "stopped", detail: null },
      { name: "second", readiness: "error", detail: "boom" }
    ]
  );
});

test("service host captures stop failures as error status", async () => {
  const host = createServiceHost({
    name: "failing-stop",
    stop() {
      throw new Error("stop failed");
    }
  });

  await host.start();
  await assert.rejects(() => host.stop(), /stop failed/);

  assert.deepEqual(host.getStatus(), {
    name: "failing-stop",
    readiness: "error",
    detail: "stop failed"
  });
});
