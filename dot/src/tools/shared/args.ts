export function parseNamedArgs(args: string[]): Record<string, string> {
    const parsed: Record<string, string> = {};

    for (const arg of args) {
        const separatorIndex = arg.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }

        const key = arg.slice(0, separatorIndex).trim();
        const value = arg.slice(separatorIndex + 1).trim();
        if (!key) {
            continue;
        }

        parsed[key] = value;
    }

    return parsed;
}

export function getStringArg(args: string[], key: string): string | null {
    const parsed = parseNamedArgs(args);
    const value = parsed[key];
    return value && value.length > 0 ? value : null;
}

export function getPositiveIntArg(args: string[], key: string): number | null {
    const value = getStringArg(args, key);
    if (!value) {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

export function getBooleanArg(args: string[], key: string): boolean {
    const value = getStringArg(args, key);
    if (!value) {
        return false;
    }

    switch (value.trim().toLowerCase()) {
        case "yes":
        case "y":
        case "true":
        case "1":
        case "confirm":
        case "confirmed":
            return true;
        default:
            return false;
    }
}
