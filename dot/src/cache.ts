const cache = new Map<string, any>();

export function set(key: string, value: any): void {
    cache.set(key, value);
}

export function get(key: string): any {
    return cache.get(key);
}
