// A value that crosses to the page as JSON.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
