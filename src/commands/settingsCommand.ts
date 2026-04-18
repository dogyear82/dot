import { handleSettingsCommand } from "../onboarding.js";
import type { SettingsStore } from "../settings.js";
import type { Command } from "./types.js";

export function createSettingsCommand(settings: SettingsStore): Command {
    return {
        name: "settings",
        description: "Handle settings commands.",
        ownerOnly: true,
        matches(input) {
            return input.startsWith("!settings");
        },
        execute(input) {
            return handleSettingsCommand(settings, input);
        }
    };
}
