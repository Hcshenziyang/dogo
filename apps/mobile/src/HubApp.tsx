import { useState, useEffect, useSyncExternalStore } from 'react';
import { HubView } from '@dogo/hub-ui';
import { hub, HubRelay, native, webClient, accountCall, memoryCall, registerBack } from './platform';
import { App as LegacyApp } from './App';
import { MemoryManager } from '@dogo/hub-ui/memory';
import { AccountSettings } from '@dogo/hub-ui/account';
import { AgentView, AgentSettings } from './AgentView';


export function HubApp() {
  const hubState = useSyncExternalStore(hub.subscribe, hub.snapshot);
  const memoryScope = `${hubState.origin}|${hubState.device}`;
  const [legacy, setLegacy] = useState(false);
  const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState({ enabled: false, active: false, permission: false });
  useEffect(() => { if (native) void HubRelay.notificationStatus().then(setNotifications).catch(() => {}); }, []);
  useEffect(() => { if (webClient) return webClient.watch(() => void hub.refresh()); }, []);
  if (legacy) return <><button className="hub-return" onClick={() => setLegacy(false)}>← 返回新版会话与资料箱</button><LegacyApp /></>;
  return <HubView client={hub} registerBack={registerBack} onBack={() => setLegacy(true)} assistant={native ? <AgentView /> : undefined} settings={<>
    {native && <AgentSettings />}
    {(native || webClient) && <AccountSettings call={accountCall} changed={() => hub.refresh()} web={!!webClient} />}
    <section className="hub-card"><h3>个人设备连接</h3><p>{hubState.origin || '尚未连接'}<br />{native ? '登录个人账号后自动连接此设备。' : '网页登录后自动连接此设备。'}</p>
      {notice && <p role="status">{notice}</p>}{!native && <p>{webClient ? '网页登录后可发送任务、接续原设备会话和投递资料。' : '这是浏览器开发预览；正式网页与服务同源部署。'}</p>}
    </section>
    {native && <section className="hub-card"><h3>后台消息通知</h3><p>通过原生连接接收完成、失败、待确认和记忆冲突通知；开启时通知栏会保留连接提示。系统强制停止或省电限制可能中断连接，重新打开会补读。</p>
      <button disabled={!native} onClick={async () => { try { setNotifications(await HubRelay.notifications({ enabled: !notifications.enabled })); } catch (e) { setNotice((e as Error).message); } }}>{notifications.enabled ? '关闭后台通知' : '开启后台通知'}</button>
      <p>{notifications.enabled ? notifications.permission ? '通知权限已允许' : '请允许系统通知权限' : '当前关闭'}</p>
    </section>}
    {(native || webClient) && <MemoryManager key={memoryScope} call={memoryCall} scope={memoryScope} devices={hubState.items.filter(i => i.type === 'device').map(d => ({ id: d.owner!, name: d.name! }))} />}
    <section className="hub-card"><h3>DogO 0.4.0</h3><p>任务自动投递到原设备；资料只存入独立资料箱。离线和未确认发送的内容保存在本机。</p></section>
  </>} />;
}
