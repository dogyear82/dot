import type { Logger } from "pino";

import { evaluateAccess } from "./auth.js";
import type { ChatService } from "./chat/modelRouter.js";
import { createOutboundMessageRequestedEvent, type InboundMessageReceivedEvent } from "./events.js";
import type { EventBus } from "./eventBus.js";
import { getOnboardingPrompt, handleOnboardingReply, handleSettingsCommand, isSettingsCommand } from "./onboarding.js";
import { handleCalendarCommand, isCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import { handlePersonalityCommand, isPersonalityCommand } from "./personality.js";
import type { Persistence } from "./persistence.js";
import { handleReminderCommand, isReminderCommand } from "./reminders.js";
import { executeToolDecision } from "./toolInvocation.js";

export function registerMessagePipeline(params: {
  bus: EventBus;
  calendarClient: OutlookCalendarClient;
  chatService: ChatService;
  logger: Logger;
  ownerUserId: string;
  persistence: Persistence;
}): () => void {
  const { bus, calendarClient, chatService, logger, ownerUserId, persistence } = params;

  return bus.subscribeInboundMessage(async (event) => {
    const accessDecision = evaluateAccess({
      authorId: event.sender.actorId,
      ownerUserId,
      isDirectMessage: event.payload.isDirectMessage,
      mentionedBot: event.payload.mentionedBot
    });

    persistence.saveAccessAudit({
      messageId: event.sourceMessageId,
      actorRole: accessDecision.actorRole,
      canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
      decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
      transport: event.transport,
      conversationId: event.conversationId
    });

    logger.info(
      {
        eventId: event.eventId,
        messageId: event.sourceMessageId,
        conversationId: event.conversationId,
        authorId: event.sender.actorId,
        actorRole: accessDecision.actorRole,
        canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
        isDirectMessage: event.payload.isDirectMessage,
        mentionedBot: event.payload.mentionedBot
      },
      "Processing inbound message event"
    );

    if (accessDecision.canUsePrivilegedFeatures) {
      if (!event.payload.isDirectMessage && !event.payload.mentionedBot) {
        return;
      }

      const content = event.payload.addressedContent.trim();

      if (!persistence.settings.hasCompletedOnboarding()) {
        const response = content
          ? handleOnboardingReply(persistence.settings, content)
          : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
        await publishReply(bus, event, response.reply);
        return;
      }

      if (isSettingsCommand(content)) {
        await publishReply(bus, event, handleSettingsCommand(persistence.settings, content));
        return;
      }

      if (isPersonalityCommand(content)) {
        await publishReply(bus, event, handlePersonalityCommand(persistence, content));
        return;
      }

      if (isReminderCommand(content)) {
        const reply = handleReminderCommand(persistence, content);
        persistence.saveToolExecutionAudit({
          messageId: event.sourceMessageId,
          toolName: normalizeExplicitToolName(content),
          invocationSource: "explicit",
          status: "executed",
          provider: null,
          detail: content
        });
        await publishReply(bus, event, reply);
        return;
      }

      if (isCalendarCommand(content)) {
        const reply = await handleCalendarCommand({
          calendarClient,
          content,
          persistence
        });
        persistence.saveToolExecutionAudit({
          messageId: event.sourceMessageId,
          toolName: normalizeExplicitToolName(content),
          invocationSource: "explicit",
          status: "executed",
          provider: null,
          detail: content
        });
        await publishReply(bus, event, reply);
        return;
      }

      if (!content) {
        return;
      }

      try {
        try {
          const inferred = await chatService.inferToolDecision(content);
          if (inferred.decision.decision === "clarify") {
            persistence.saveToolExecutionAudit({
              messageId: event.sourceMessageId,
              toolName: inferred.decision.toolName,
              invocationSource: "inferred",
              status: "clarify",
              provider: inferred.provider,
              detail: inferred.decision.reason
            });
            await publishReply(bus, event, inferred.decision.question);
            return;
          }

          if (inferred.decision.decision === "execute") {
            const reply = await executeToolDecision({
              calendarClient,
              decision: inferred.decision,
              persistence
            });
            persistence.saveToolExecutionAudit({
              messageId: event.sourceMessageId,
              toolName: inferred.decision.toolName,
              invocationSource: "inferred",
              status: "executed",
              provider: inferred.provider,
              detail: inferred.decision.reason
            });
            logger.info(
              { provider: inferred.provider, messageId: event.sourceMessageId, toolName: inferred.decision.toolName },
              "Executed inferred tool decision"
            );
            await publishReply(bus, event, reply);
            return;
          }

          persistence.saveToolExecutionAudit({
            messageId: event.sourceMessageId,
            toolName: "none",
            invocationSource: "inferred",
            status: "skipped",
            provider: inferred.provider,
            detail: inferred.decision.reason
          });
        } catch (error) {
          persistence.saveToolExecutionAudit({
            messageId: event.sourceMessageId,
            toolName: "inference-error",
            invocationSource: "inferred",
            status: "failed",
            provider: null,
            detail: error instanceof Error ? error.message : "unknown inference failure"
          });
          logger.warn({ err: error, messageId: event.sourceMessageId }, "Tool inference failed; falling back to chat");
        }

        const response = await chatService.generateOwnerReply(content);
        logger.info({ provider: response.provider, messageId: event.sourceMessageId }, "Generated owner chat response");
        await publishReply(bus, event, response.reply);
      } catch (error) {
        logger.error({ err: error, messageId: event.sourceMessageId }, "Failed to generate owner chat response");
        await publishReply(
          bus,
          event,
          "I couldn't generate a response from the configured model provider. Check the model settings or provider configuration."
        );
      }

      return;
    }

    if (accessDecision.shouldReply && accessDecision.responseMessage) {
      await publishReply(bus, event, accessDecision.responseMessage);
    }
  });
}

async function publishReply(bus: EventBus, event: InboundMessageReceivedEvent, content: string) {
  await bus.publishOutboundMessage(
    createOutboundMessageRequestedEvent({
      inboundEvent: event,
      content
    })
  );
}

function normalizeExplicitToolName(content: string): string {
  if (content.startsWith("!reminder add ") || content.startsWith("!remind ")) {
    return "reminder.add";
  }

  if (content.startsWith("!reminder ack ")) {
    return "reminder.ack";
  }

  if (content.startsWith("!reminder show") || content === "!reminder") {
    return "reminder.show";
  }

  if (content.startsWith("!calendar remind ")) {
    return "calendar.remind";
  }

  if (content.startsWith("!calendar show") || content === "!calendar") {
    return "calendar.show";
  }

  if (content.startsWith("!settings")) {
    return "settings";
  }

  if (content.startsWith("!personality")) {
    return "personality";
  }

  return "explicit-command";
}
