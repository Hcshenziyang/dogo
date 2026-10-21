import { useEffect, useState } from 'react';

import type { AccountCall } from './account-types';
export type { AccountInput, AccountCall } from './account-types';
type Device = { id: string; name: string; platform: string; revoked: boolean; legacyEnabled: boolean; online: boolean; lastSeen: number;
  permissions: { memory: boolean; publishTo: string[] } };

export function AccountSettings({ call, changed, web = false }: { call: AccountCall; changed?: () => Promise<unknown>; web?: boolean }) {
  const [url, setUrl] = useState(''), [username, setUsername] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(web ? '我的浏览器' : '我的设备');
  const [state, setState] = useState<any>({}), [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [recovery, setRecovery] = useState('');
  const [recoverInput, setRecoverInput] = useState(''), [currentPassword, setCurrentPassword] = useState(''), [newPassword, setNewPassword] = useState('');
  async function refresh(target?: string) {
    const next = await call({ op: 'status', ...(target ? { url: target } : {}) }); setState(next);
    if (next.url) setUrl(next.url);
    setDevices(next.authenticated ? (await call({ op: 'devices' })).devices : []);
  }
  useEffect(() => { void refresh().catch(e => setNotice(e.message)); }, [call]);
  async function run(op: string, args: Record<string, unknown> = {}) {
    setBusy(true); setNotice('');
    try {
      const result = await call({ op, ...(url ? { url } : {}), args });
      if (result.recoveryCode) setRecovery(result.recoveryCode);
      setPassword(''); setCurrentPassword(''); setNewPassword(''); setRecoverInput('');
      setNotice(result.warning || (result.signInRequired ? '密码已更新，所有设备需重新登录。请保存新的恢复码。' : '已完成'));
      await refresh(['logout', 'password', 'recover'].includes(op) ? url : undefined);
      await changed?.();
    } catch (e) { setNotice((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="hub-card"><h3>个人账号</h3>
    <p>登录个人账号，自动连接当前设备。你可以管理设备名称、同步权限和任务授权。</p>
    <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0 }}>
      <label>服务地址<input aria-label="账号服务地址" type="url" value={url} readOnly={web} placeholder="https://你的服务域名" onChange={e => setUrl(e.target.value)} /></label>
      <button onClick={() => { setBusy(true); void refresh(url).catch(e => setNotice(e.message)).finally(() => setBusy(false)); }}>检查连接 / 刷新账号</button>
      {state.authenticated ? <>
        <p>已登录：{state.username} · {state.device}</p>
        <button onClick={() => { if (confirm('退出本机账号？本机停止接收远程任务，已保存记录和草稿保留。离线时请另行撤销设备。')) void run('logout'); }}>退出此设备</button>
        <details><summary>设备与授权（新设备默认无任务及记忆权限）</summary>
          {devices.map(device => <DeviceEditor key={device.id + JSON.stringify(device.permissions) + device.revoked} device={device} all={devices} save={args => run('device', args)} revoke={() => {
            if (confirm(`撤销 ${device.name}？它将立即失去所有登录与访问权限，需重新登录授权。`)) void run('revoke', { id: device.id });
          }} />)}
        </details>
        <details><summary>修改密码</summary>
          <label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label>
          <label>新密码（至少 15 个字符）<input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>
          <button disabled={newPassword.length < 15 || !currentPassword} onClick={() => { if (confirm('修改密码会退出所有设备，是否继续？')) void run('password', { currentPassword, password: newPassword }); }}>更新密码并退出所有设备</button>
        </details>
      </> : <>
        {state.legacy && <p>请登录个人账号，程序会自动保留此设备原有记录。</p>}
        {state.initialized === false && <p>服务端尚未配置个人账号，请联系管理员。当前不开放注册。</p>}
        <label>账号<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="3–64 位英文字母、数字或 . _ @ -" /></label>
        <label>密码<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        <label>此设备名称<input value={name} onChange={e => setName(e.target.value)} maxLength={100} /></label>
        <button className="hub-primary" disabled={!url || !username || !password || !name || state.initialized === false} onClick={() => void run('login', { username, password, name })}>登录</button>
        <details><summary>使用恢复码重设密码</summary><p>恢复码仅用一次。重设后所有设备登录失效，必须重新登录。</p>
          <label>恢复码<input type="password" autoComplete="off" value={recoverInput} onChange={e => setRecoverInput(e.target.value)} /></label>
          <label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>
          <button disabled={!username || newPassword.length < 15 || !recoverInput} onClick={() => { if (confirm('确认重设密码并退出所有设备？')) void run('recover', { username, recoveryCode: recoverInput, password: newPassword }); }}>重设密码</button>
        </details>
      </>}
    </fieldset>
    {recovery && <div role="alert"><h4>恢复码仅显示这一次，请保存到密码管理器</h4><p>任何拿到它的人都可以重设账号密码。不要发给 Agent。</p><code style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>{recovery}</code><br /><button onClick={() => { if (confirm('已另行保存恢复码？关闭后无法再次查看。')) setRecovery(''); }}>我已安全保存</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
function DeviceEditor({ device, all, save, revoke }: { device: Device; all: Device[]; save: (args: Record<string, unknown>) => unknown; revoke: () => void }) {
  const [name, setName] = useState(device.name), [memory, setMemory] = useState(device.permissions.memory);
  const [sendTo, setSendTo] = useState(device.permissions.publishTo.map(p => p.slice('/tasks/'.length)));
  return <div className="hub-card"><strong>{device.name} · {device.platform}</strong><p>{device.revoked ? '已撤销' : device.online ? '在线' : '离线'}</p>
    {!device.revoked && <><label>名称<input value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label>
      <label><span><input type="checkbox" style={{ width: 'auto' }} checked={memory} onChange={e => setMemory(e.target.checked)} /> 允许读写个人记忆文件夹</span></label>
      <p>允许发送任务 / 资料到（执行端开启无人值守时会自动执行）：</p>
      {all.filter(d => !d.revoked && d.id !== device.id).map(d => <label key={d.id}><span><input type="checkbox" style={{ width: 'auto' }} checked={sendTo.includes(d.id)} onChange={e => setSendTo(e.target.checked ? [...sendTo, d.id] : sendTo.filter(id => id !== d.id))} /> {d.name}</span></label>)}
      <button onClick={() => { if (confirm('保存此设备的任务路由和个人记忆授权？')) save({ id: device.id, name, memory, sendTo }); }}>保存授权</button><button onClick={revoke}>撤销设备</button>
    </>}
  </div>;
}
