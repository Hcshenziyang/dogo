import readline from "node:readline";
import { Engine } from "./engine.mjs";
import { checkReadiness } from './readiness.mjs';

if (!process.env.DOGO_DATA_DIR) throw new Error("DOGO_DATA_DIR is required");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const engine = new Engine(process.env.DOGO_DATA_DIR, (snapshot) =>
  send({ event: "snapshot", snapshot }),
);
const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let request;
  try {
    if (line.length > 33 * 1024 * 1024) throw new Error("请求过大");
    request = JSON.parse(line);
    let result;
    switch (request.method) {
      case "snapshot":
        result = engine.snapshot();
        break;
      case 'executionStatus':
        result = await engine.executionStatus();
        break;
      case 'prepare':
        result = await checkReadiness(engine, request.params); await engine.relay.refresh();
        break;
      case 'openDsh':
        await engine.dsh.ensure(engine.store.settings());
        result = engine.dsh.webUrl;
        break;
      case 'connectRelay':
        result = await engine.relay.connect(request.params);
        break;
      case 'disconnectRelay':
        await engine.relay.disconnect(); result = true;
        break;
      case 'refreshRelay':
        await engine.relay.refresh();
        result = engine.relay.snapshot();
        break;
      case 'acceptRemote':
        result = await engine.relay.accept(request.params);
        break;
      case 'hubAction':
        result = await engine.hub.action(request.params);
        break;
      case 'remotePolicy':
        result = await engine.hub.configure(request.params);
        break;
      case 'registerProject':
        result = await engine.hub.register(request.params.path);
        break;
      case 'updateProject':
        result = await engine.hub.updateProject(request.params);
        break;
      case 'hubCache':
        if (request.params?.value === undefined) result = engine.store.value('hub-ui-cache', null);
        else {
          if (typeof request.params.value !== 'string' || Buffer.byteLength(request.params.value) > 32 * 1024 * 1024) throw new Error('缓存内容过大');
          engine.store.setValue('hub-ui-cache', request.params.value); result = true;
        }
        break;
      case 'memoryConfigure':
        result = await engine.memory.configure(request.params);
        break;
      case 'memorySync':
        await engine.memory.sync(); result = engine.memory.snapshot();
        break;
      case 'memoryAction':
        result = await engine.memory.action(request.params);
        break;
      case 'capabilitiesConfigure':
        result = await engine.capabilities.configure(request.params);
        break;
      case "configure":
        result = engine.configure(request.params);
        break;
      case "create":
        result = engine.create(request.params);
        break;
      case "followup":
        result = engine.followup(request.params.id, request.params.prompt);
        break;
      case "cancel":
        result = await engine.cancel(request.params.id);
        break;
      case "authorizeWorkspace":
        result = await engine.authorizeWorkspace(request.params.path);
        break;
      case "shutdown":
        await engine.close();
        send({ id: request.id, result: true });
        process.exit(0);
        break;
      default:
        throw new Error("未知操作");
    }
    send({ id: request.id, result: result ?? null });
  } catch (error) {
    send({
      id: request?.id,
      error:
        error.issues?.map((issue) => issue.message).join("；") ??
        error.message ??
        "操作失败",
    });
  }
});
input.on("close", async () => {
  await engine.close();
  process.exit(0);
});
