import type { Persistence } from "../persistence.js";
import { handlePersonalityCommand } from "../personality.js";
import type { Command } from "./types.js";

export function createPersonalityCommand(persistence: Persistence): Command {
    return {
        name: "personality",
        description: "Handle personality commands.",
        ownerOnly: true,
        matches(input) {
            return input.startsWith("!personality");
        },
        execute(input) {
            return handlePersonalityCommand(persistence, input);
        }
    };
}
