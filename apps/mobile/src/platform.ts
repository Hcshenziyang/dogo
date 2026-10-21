import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { App as NativeApp } from "@capacitor/app";
import { Clipboard } from "@capacitor/clipboard";
import { Share } from "@capacitor/share";
import { WorkspaceRepository } from "./workspace.ts";
import { RelaySession } from './relay.ts';
import type { NativeRelayTransport } from './relay.ts';
import { HubSession, type HubTransport } from '@dogo/hub-ui/client';
import { BrowserHub } from '@dogo/hub-ui/browser';

export const native = Capacitor.isNativePlatform();
export const webClient = !native && !import.meta.env.DEV ? new BrowserHub(location.origin, localStorage) : undefined;
export const NativeStore = registerPlugin<{
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
}>("DogoStore");
export const repository = new WorkspaceRepository({
  async get(key) {
    return (
      await (native ? NativeStore.get({ key }) : Preferences.get({ key }))
    ).value;
  },
  async set(key, value) {
    await (native
      ? NativeStore.set({ key, value })
      : Preferences.set({ key, value }));
  },
});
const NativeRelay = registerPlugin<NativeRelayTransport>('DogoRelay');
export const HubRelay = registerPlugin<NativeRelayTransport & HubTransport & {
  account(value: import('@dogo/hub-ui/account').AccountInput): Promise<any>;
  memory(value: { op: string; args?: Record<string, unknown> }): Promise<any>;
  notificationStatus(): Promise<{ enabled: boolean; active: boolean; permission: boolean }>;
  notifications(value: { enabled: boolean }): Promise<{ enabled: boolean; active: boolean; permission: boolean }>;
}>('DogoRelay');
const unavailable = async (): Promise<never> => { throw new Error('请在 Android App 中登录账号；网页预览不连接真实服务'); };
export const relay = new RelaySession(repository, native ? NativeRelay : {
  status: async () => ({ configured: false, url: '', device: '' }),
  importPairing: unavailable, identity: unavailable, publish: unavailable, read: unavailable,
});
export const accountCall = (value: import('@dogo/hub-ui/account').AccountInput) => native ? HubRelay.account(value) : webClient ? webClient.account(value) : unavailable();
export const memoryCall = (value: { op: string; args?: Record<string, unknown> }) => native ? HubRelay.memory(value) : webClient ? webClient.memory(value) : unavailable();
export const hub = new HubSession(native ? HubRelay : webClient ?? {
  status: async () => ({ configured: false, url: '', device: '' }), hub: unavailable,
}, {
  async get() { return (await (native ? NativeStore.get({ key: 'dogo.hub.v2' }) : Preferences.get({ key: 'dogo.hub.v2' }))).value; },
  async set(value) { await (native ? NativeStore.set({ key: 'dogo.hub.v2', value }) : Preferences.set({ key: 'dogo.hub.v2', value })); },
});
export async function copyText(value: string) {
  await Clipboard.write({ string: value });
}
export async function shareText(title: string, text: string) {
  if (native || (await Share.canShare()).value)
    await Share.share({ title, text, dialogTitle: "分享任务记录" });
  else {
    await copyText(text);
    return "已复制，可粘贴到其他应用";
  }
  return "已打开系统分享";
}
export async function registerBack(handler: () => void) {
  if (!native) return { remove: async () => {} };
  return NativeApp.addListener("backButton", handler);
}
export async function minimize() {
  if (native) {
    await repository.flush();
    await NativeApp.minimizeApp();
  }
}
