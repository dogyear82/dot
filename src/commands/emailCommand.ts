import type { EventBus } from "../eventBus.js";
import type { Persistence } from "../persistence.js";
import { handleEmailCommand } from "../tools/email/command.js";
import type { Command } from "./types.js";

export function createEmailCommand(params: {
    actorId: string;
    bus: EventBus;
    conversationId: string;
    persistence: Persistence;
}): Command {
    return {
        name: "email",
        description: "Handle email commands.",
        matches(input) {
            return input.startsWith("!email");
        },
        execute(input) {
            return handleEmailCommand({
                actorId: params.actorId,
                bus: params.bus,
                content: input,
                conversationId: params.conversationId,
                persistence: params.persistence
            });
        }
    };
}
