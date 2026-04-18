import type { Persistence } from "../persistence.js";
import { handleNewsPreferencesCommand } from "../tools/shared/newsPreferences.js";
import type { Command } from "./types.js";

export function createNewsPreferencesCommand(persistence: Persistence): Command {
    return {
        name: "news.preferences",
        description: "Handle news preference commands.",
        matches(input) {
            return input.startsWith("!news");
        },
        execute(input) {
            return handleNewsPreferencesCommand(persistence, input);
        }
    };
}
