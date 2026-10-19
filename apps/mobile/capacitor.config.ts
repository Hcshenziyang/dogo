import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.dogo.mobile",
  appName: "DogO",
  webDir: "dist",
  android: { backgroundColor: "#f7f8f4", allowMixedContent: false },
  plugins: { SystemBars: { style: "LIGHT", insetsHandling: "css" } },
};
export default config;
