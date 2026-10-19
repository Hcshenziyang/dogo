import { registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { tool } from 'ai';
import { z } from 'zod';
import { MobileAgent, type AgentTransport } from './agent';
import { native, NativeStore, hub, memoryCall, HubRelay } from './platform';
import { PhoneMemoryMaintenance } from './agent-memory';

export const agentTransport = registerPlugin<AgentTransport & { exportHistory(): Promise<{ saved: boolean }> }>('DogoAgent');
const text = z.string().min(1).max(32000);
const memoryPath = z.string().min(1).max(200);
export const mobileAgent = new MobileAgent(agentTransport, {
  get: async () => (await NativeStore.get({ key: 'dogo.agent.v1' })).value,
  set: async value => { await NativeStore.set({ key: 'dogo.agent.v1', value }); },
}, () => ({
  dogo_devices: tool({ description: '刷新并查询已授权设备、项目及会话基本信息。不访问项目文件。', inputSchema: z.object({}), execute: async () => {
    await hub.refresh(); const s = hub.snapshot();
    return { updatedAt: s.syncedAt, error: s.error, items: s.items.filter(i => ['device', 'project', 'session'].includes(i.type)).slice(0, 200) };
  } }),
  dogo_delegate: tool({ description: '明确委派新任务给指定设备；设备按既定授权自动执行。返回的是投递状态，不是执行结果。',
    inputSchema: z.object({ target: z.string().min(1).max(64), projectId: z.string().uuid().nullable(), title: z.string().max(300), prompt: text }),
    execute: async input => { const id = await hub.send('create', input); return { requestId: id, state: hub.snapshot().outbox.some(p => p.id === id) ? 'pending_confirmation' : 'server_received', message: '请到任务页面查看真实结果；不可声称已执行完成' }; },
  }),
  dogo_followup: tool({ description: '给原设备上的已有任务会话追加指令；不迁移会话，不另建会话。', inputSchema: z.object({ sessionId: z.string().uuid(), prompt: text }),
    execute: async input => { const id = await hub.send('send', input); return { requestId: id, state: hub.snapshot().outbox.some(p => p.id === id) ? 'pending_confirmation' : 'server_received' }; },
  }),
  dogo_note: tool({ description: '保存资料到 DogO 独立资料箱，不触发 Agent 执行。', inputSchema: z.object({ target: z.string().min(1).max(64), title: z.string().max(300), text }),
    execute: async input => { const id = await hub.send('note', input); return { requestId: id, state: hub.snapshot().outbox.some(p => p.id === id) ? 'pending_confirmation' : 'server_received', executed: false }; },
  }),
  dogo_memory_list: tool({ description: '列出专用个人记忆文件夹的文件名，不扫描项目或其他手机目录。', inputSchema: z.object({}), execute: async () => memoryCall({ op: 'status' }) }),
  dogo_memory_read: tool({ description: '读取一个个人记忆文件；内容会交给当前用户配置的模型服务。', inputSchema: z.object({ path: memoryPath }), execute: async args => memoryCall({ op: 'read', args }) }),
  dogo_memory_write: tool({ description: '写入个人记忆，必须提供刚读取的原文 base，新文件为 null。不会静默覆盖已变化的文件。', inputSchema: z.object({ path: memoryPath, base: z.string().max(256000).nullable(), content: z.string().max(64000) }), execute: async args => {
    const result = await memoryCall({ op: 'write', args });
    const status = await memoryCall({ op: 'status' });
    if (status.enabled) { try { await memoryCall({ op: 'sync' }); return { ...result, synced: true }; } catch { return { ...result, synced: false, warning: '本机保存成功，同步待恢复；不要重复写入' }; } }
    return result;
  } }),
}));

export const phoneMaintenance = new PhoneMemoryMaintenance(agentTransport, {
  get: async () => (await NativeStore.get({ key: 'dogo.memory.maintenance.v1' })).value,
  set: async value => { await NativeStore.set({ key: 'dogo.memory.maintenance.v1', value }); },
}, memoryCall, async () => (await HubRelay.status()).device);
if (native) {
  let foreground = true;
  const maintain = () => { if (foreground && !document.hidden && !mobileAgent.snapshot().chats.some(c => c.state === 'running')) void phoneMaintenance.run().catch(() => {}); };
  void App.addListener('appStateChange', ({ isActive }) => { foreground = isActive; if (!isActive) { mobileAgent.stop(); phoneMaintenance.stop(); } else maintain(); });
  setInterval(maintain, 30000);
}
