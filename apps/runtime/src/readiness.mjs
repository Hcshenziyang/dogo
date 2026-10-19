export async function checkReadiness(engine, system = {}, fetcher = fetch) {
  const checks = [], add = (id, ok, message) => checks.push({ id, ok, message });
  const settings = engine.store.settings();
  try {
    if (!settings.model) throw new Error('尚未配置模型');
    const response = await fetcher(settings.endpoint.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}`);
    let text = '', bytes = 0; const decoder = new TextDecoder();
    if (!response.body) throw new Error('模型列表为空');
    for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 1024 * 1024) throw new Error('模型列表超过安全大小'); text += decoder.decode(chunk, { stream: true }); }
    text += decoder.decode();
    if (!JSON.parse(text).data?.some(m => m.id === settings.model)) throw new Error('模型列表中没有所选模型');
    add('model', true, '模型服务可达，模型已登记；不代表已完成加载或速度验收');
  } catch (error) { add('model', false, `模型检查失败：${error.message}`); }
  try {
    await engine.dsh.ensure(settings); const health = await engine.dsh.request('/health');
    add('dsh', health.ready, 'DSH ' + health.version);
    add('memory-plugin', !!health.plugins.memory, '跨会话记忆插件' + (health.plugins.memory ? '已加载' : '未加载'));
    add('codex-provider', !!health.plugins.codex, 'Codex 订阅路由' + (health.plugins.codex ? '已加载；登录与编码委派单独检查' : '未加载'));
  } catch (error) { add('dsh', false, 'DSH 不可用：' + error.message.slice(0, 300)); }
  add('screen', system.screen === 'granted', '屏幕录制：' + (system.screen ?? '未检测，请从 Mac 设置检查'));
  add('accessibility', system.accessibility === true, '点击和输入：' + (system.accessibility ? '辅助功能已授权' : '需要系统辅助功能授权'));
  add('unattended', engine.hub.policy.autoExecute, engine.hub.policy.autoExecute ? '已允许授权设备无人值守任务' : '无人值守未启用，远程任务暂存');
  add('computer-tool', engine.capabilities.policy.computer && !!process.env.DOGO_MAC_HELPER, engine.capabilities.policy.computer ? '电脑操作已启用；同时需要系统权限和支持图像的模型' : '电脑操作开关未启用');
  if (engine.capabilities.policy.codex) {
    try { const r = await engine.capabilities.run('codex', ['login', 'status'], { timeout: 5000, limit: 16000 }); add('codex-cli', r.code === 0, r.code === 0 ? 'Codex CLI 已登录；实际编码/测试需单独验收' : 'Codex CLI 未登录或凭据不可用'); }
    catch { add('codex-cli', false, 'Codex CLI 不可用，请安装并登录'); }
  } else add('codex-cli', false, 'Codex 编码委派未启用');
  add('ssh', engine.capabilities.policy.sshHosts.length > 0, engine.capabilities.policy.sshHosts.length ? `SSH 已授权 ${engine.capabilities.policy.sshHosts.length} 个别名；连接和主机密钥需逐个验收` : '尚未授权 SSH 目标');
  const value = { at: Date.now(), checks }; engine.readiness = value; engine.changed(); return value;
}
