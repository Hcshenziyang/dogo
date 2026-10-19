export type AccountInput = { op: string; url?: string; args?: Record<string, unknown> };
export type AccountCall = (value: AccountInput) => Promise<any>;
