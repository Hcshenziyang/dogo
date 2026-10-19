import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const java =
  process.env.DOGO_JAVA_HOME ||
  process.env.JAVA_HOME ||
  "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(homedir(), "Library/Android/sdk");
if (
  !existsSync(join(java, "bin/java")) ||
  !existsSync(join(sdk, "platforms/android-36/android.jar")) ||
  !existsSync(join(sdk, "build-tools/36.0.0/apksigner"))
) {
  throw new Error(
    "需要 JDK 21、Android SDK platform 36 / build-tools 36.0.0；先按 README 完成安装和 SDK 许可确认。此脚本不会自动接受许可。",
  );
}
const signing = join(homedir(), ".local/share/dogo/android-signing");
mkdirSync(signing, { recursive: true, mode: 0o700 });
chmodSync(signing, 0o700);
const configPath = join(signing, "signing.json");
const keyPath = join(signing, "dogo-mobile.jks");
if (existsSync(keyPath) && !existsSync(configPath))
  throw new Error(
    "签名密钥已存在但缺少配置。为避免破坏更新链，停止构建；请恢复 signing.json。",
  );
if (!existsSync(configPath))
  writeFileSync(
    configPath,
    JSON.stringify({ password: randomBytes(32).toString("base64url") }),
    { mode: 0o600, flag: "wx" },
  );
chmodSync(configPath, 0o600);
const { password } = JSON.parse(readFileSync(configPath, "utf8"));
if (typeof password !== "string" || password.length < 32)
  throw new Error("签名配置损坏，请恢复原文件，不要重建密钥");
const env = {
  ...process.env,
  JAVA_HOME: java,
  ANDROID_HOME: sdk,
  DOGO_KEYSTORE_PATH: keyPath,
  DOGO_KEYSTORE_PASSWORD: password,
};
function run(command, args, cwd = mobile) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} 失败（${result.status}）`);
}
if (!existsSync(keyPath)) {
  run(join(java, "bin/keytool"), [
    "-genkeypair",
    "-keystore",
    keyPath,
    "-storetype",
    "PKCS12",
    "-storepass:env",
    "DOGO_KEYSTORE_PASSWORD",
    "-keypass:env",
    "DOGO_KEYSTORE_PASSWORD",
    "-alias",
    "dogo-mobile",
    "-keyalg",
    "RSA",
    "-keysize",
    "3072",
    "-validity",
    "10000",
    "-dname",
    "CN=DogO Personal Android, OU=Personal, O=DogO",
    "-noprompt",
  ]);
  chmodSync(keyPath, 0o600);
}
run("pnpm", ["--config.verify-deps-before-run=false", "run", "build"]);
run("pnpm", [
  "--config.verify-deps-before-run=false",
  "exec",
  "cap",
  "sync",
  "android",
]);
run(
  join(mobile, "android/gradlew"),
  [
    "--no-daemon",
    "--console=plain",
    "assembleRelease",
    "lintRelease",
    "testDebugUnitTest",
  ],
  join(mobile, "android"),
);
const apk = join(
  mobile,
  "android/app/build/outputs/apk/release/app-release.apk",
);
run(join(sdk, "build-tools/36.0.0/apksigner"), ["verify", "--verbose", apk]);
const version = JSON.parse(
  readFileSync(join(mobile, "package.json"), "utf8"),
).version;
const output = join(mobile, "release");
mkdirSync(output, { recursive: true });
const target = join(output, `DogO-${version}.apk`);
copyFileSync(apk, target);
const hash = createHash("sha256").update(readFileSync(target)).digest("hex");
writeFileSync(
  join(output, `DogO-${version}.sha256`),
  `${hash}  DogO-${version}.apk\n`,
);
console.log(
  `已构建并验证签名：${target}\nSHA-256: ${hash}\n本机签名密钥保存在 ${signing}，请安全备份；不要提交 Git。`,
);
