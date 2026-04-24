import test from "node:test";
import assert from "node:assert/strict";

import { createOwnerDiscordDirectMessageNotification } from "../src/notifications.js";

test("owner Discord direct-message notification helper creates the canonical outbound request", () => {
  const event = createOwnerDiscordDirectMessageNotification({
    content: "Service alert",
    ownerUserId: "owner-1",
    producerService: "mail-triage-service",
    correlationId: "mail-alert:1",
    actorId: "owner-1",
    deliveryContext: {
      kind: "service_notification",
      service: "mail-triage-service",
      notificationType: "urgent-mail"
    }
  });

  assert.equal(event.eventType, "outbound.message.requested");
  assert.equal(event.producer.service, "mail-triage-service");
  assert.equal(event.routing.transport, "discord");
  assert.equal(event.payload.delivery.kind, "direct-message");
  assert.equal(event.payload.delivery.recipientActorId, "owner-1");
  assert.equal(event.payload.recordConversationTurn, false);
  assert.deepEqual(event.payload.deliveryContext, {
    kind: "service_notification",
    service: "mail-triage-service",
    notificationType: "urgent-mail"
  });
});
