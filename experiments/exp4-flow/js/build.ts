import { spawnSync } from "child_process";
import { resolve } from "path";
import { statSync } from "fs";

const HERMESC_PATH = "C:\\work\\projects\\my-rn-app\\node_modules\\hermes-compiler\\hermesc\\win64-bin\\hermesc.exe";
const JS_OUT = resolve(__dirname, "dist/screen.js");
const HBC_OUT = resolve(__dirname, "../app/src/main/assets/screen.hbc");

console.log("==> 1. Bundling main.tsx with Bun...");
const bundleRes = spawnSync("bun", ["build", "./main.tsx", "--outfile", JS_OUT], {
  cwd: __dirname,
  stdio: "inherit",
});
if (bundleRes.status !== 0) {
  console.error("Bun bundle failed!");
  process.exit(1);
}

console.log("==> 2. Compiling bytecode with hermesc -O...");
const hermesRes = spawnSync(HERMESC_PATH, ["-O", "-emit-binary", "-out", HBC_OUT, JS_OUT], {
  stdio: "inherit",
});
if (hermesRes.status !== 0) {
  console.error("hermesc compilation failed!");
  process.exit(1);
}

const stats = statSync(HBC_OUT);
console.log(`==> Success! screen.hbc generated: ${stats.size} bytes (${(stats.size / 1024).toFixed(2)} KB)`);
