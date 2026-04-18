import type { Persistence } from "../persistence.js";
import { handleContactCommand } from "../contacts.js";
import type { Command } from "./types.js";

export function createContactCommand(persistence: Persistence, conversationId: string): Command {
    return {
        name: "contact",
        description: "Handle contact commands.",
        ownerOnly: true,
        matches(input) {
            return input.startsWith("!contact");
        },
        execute(input) {
            return handleContactCommand({
                content: input,
                conversationId,
                persistence
            });
        }
    };
}
