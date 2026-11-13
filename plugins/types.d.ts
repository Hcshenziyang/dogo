// DSH supplies these at runtime; narrow structural APIs are verified against the installed Host.
declare module '@deepseek-ai/dsh-client-connection' {
  export const Peer: any;
  export const OperatorPeer: any;
}
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(value: any): any;
}
declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(value: any): any;
}
declare module '@deepseek-ai/dsh-mcp-client' {
  export const name: string;
  export const inject: string[];
  export const Config: any;
  export function apply(ctx: any, config: any): Promise<void>;
}
