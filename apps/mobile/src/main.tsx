import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HubApp as App } from "./HubApp.tsx";
import { native, repository } from "./platform.ts";
import "./styles.css";

if (native) document.documentElement.classList.add("native-app");
const root = createRoot(document.getElementById("root")!);
async function boot() {
  try {
    await repository.load();
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    root.render(
      <main className="startup-error">
        <h1>暂时无法打开工作台</h1>
        <p>
          {error instanceof Error
            ? error.message
            : "本地存储不可用。请检查设备空间后重试。"}
        </p>
        <button className="primary" onClick={() => void boot()}>
          重试，不清除数据
        </button>
      </main>,
    );
  }
}
void boot();
