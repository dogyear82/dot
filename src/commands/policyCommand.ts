import type { Persistence } from "../persistence.js";
import { handlePolicyCommand } from "../contacts.js";
import type { Command } from "./types.js";

export function createPolicyCommand(persistence: Persistence, conversationId: string): Command {
    return {
        name: "policy",
        description: "Handle policy commands.",
        ownerOnly: true,
        matches(input) {
            return input.startsWith("!policy");
        },
        execute(input) {
            return handlePolicyCommand({
                content: input,
                conversationId,
                persistence
            });
        }
    };
}
