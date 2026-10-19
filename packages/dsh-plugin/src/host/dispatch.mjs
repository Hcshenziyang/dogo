import { checkReadiness } from './readiness.mjs';
import { hostRequest } from '@dogo/contracts/host';
export async function dispatch(host, input) {
  const { method, params } = hostRequest.parse(input);
  if (host.closing && method !== 'shutdown') throw new Error('DogO 插件正在退出');
  const scope = host.relay.key ? `${host.relay.key.url}|${host.relay.key.device}` : 'local';
  if (params?.scope !== undefined && params.scope !== scope) throw new Error('连接身份已改变，请刷新后重试');
  switch (method) {
    case 'snapshot': return host.snapshot();
    case 'executionStatus': return host.executionStatus();
    case 'heartbeat': await host.capabilities.refresh?.(); return { ok: true };
    case 'prepare': return checkReadiness(host, params);
    case 'connectRelay': return host.relay.connect(params);
    case 'disconnectRelay': await host.relay.disconnect(); return true;
    case 'refreshRelay': await host.relay.refresh(); return host.relay.snapshot();
    case 'acceptRemote': return host.relay.accept(params);
    case 'hubAction': return host.hub.action({ op: params.op, args: params.args });
    case 'remotePolicy': return host.hub.configure(params);
    case 'registerProject': return host.hub.register(params.path);
    case 'updateProject': return host.hub.updateProject(params);
    case 'hubCache': {
      const key = 'hub-ui-cache:' + scope;
      if (params?.value === undefined) return host.store.value(key, null);
      if (typeof params.value !== 'string' || Buffer.byteLength(params.value) > 32 * 1024 * 1024) throw new Error('缓存内容过大');
      host.store.setValue(key, params.value); return true;
    }
    case 'memoryConfigure': return host.memory.configure(params);
    case 'memorySync': await host.memory.sync(); return host.memory.snapshot();
    case 'memoryAction': return host.memory.action(params);
    case 'configure': return host.configure(params);
    case 'create': return host.create(params);
    case 'followup': return host.followup(params.id, params.prompt);
    case 'cancel': return host.cancel(params.id);
    case 'authorizeWorkspace': return host.authorizeWorkspace(params.path);
    case 'shutdown': await host.close(); return true;
    default: throw new Error('未知或不允许的插件操作');
  }
}
