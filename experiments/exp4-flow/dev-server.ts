import { watch } from "fs";
import { resolve } from "path";
import { readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import type { ServerWebSocket } from "bun";

const PORT = 8082;
const JS_DIR = resolve(__dirname, "js");
const ENTRY_FILE = resolve(JS_DIR, "main.tsx");
const OUT_DIR = resolve(JS_DIR, "dist");
const JS_OUT = resolve(OUT_DIR, "main.js");
const HBC_OUT = resolve(OUT_DIR, "screen.hbc");
const ASSETS_HBC = resolve(__dirname, "app/src/main/assets/screen.hbc");
const HERMESC_PATH = "C:\\work\\projects\\my-rn-app\\node_modules\\hermes-compiler\\hermesc\\win64-bin\\hermesc.exe";

const clients = new Set<ServerWebSocket<unknown>>();

async function compileBytecode(): Promise<Uint8Array | null> {
  const start = performance.now();
  try {
    // 1. In-process Bun build (ultra-fast, < 5ms)
    const buildResult = await Bun.build({
      entrypoints: [ENTRY_FILE],
      outdir: OUT_DIR,
      target: "browser",
      minify: false,
    });

    if (!buildResult.success) {
      console.error("[DEV_SERVER] ❌ Bun build errors:", buildResult.logs);
      return null;
    }

    const bunMs = performance.now() - start;

    // 2. Hermes compilation to bytecode
    const hStart = performance.now();
    const hermesRes = spawnSync(HERMESC_PATH, ["-O", "-emit-binary", "-out", HBC_OUT, JS_OUT]);
    if (hermesRes.status !== 0) {
      console.error("[DEV_SERVER] ❌ hermesc compilation failed:", hermesRes.stderr?.toString());
      return null;
    }
    const hermesMs = performance.now() - hStart;

    // Copy to assets as well so fresh cold starts also have it
    const bytecode = readFileSync(HBC_OUT);
    Bun.write(ASSETS_HBC, bytecode);

    const totalMs = performance.now() - start;
    console.log(`[DEV_SERVER] ⚡ Built bytecode in ${totalMs.toFixed(1)}ms (Bun: ${bunMs.toFixed(1)}ms, Hermes: ${hermesMs.toFixed(1)}ms) - ${bytecode.length} bytes`);
    return bytecode;
  } catch (err) {
    console.error("[DEV_SERVER] Error compiling bytecode:", err);
    return null;
  }
}

// Start WebSocket server
let latestBytecode: Uint8Array | null = null;

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) {
      return; // upgraded to websocket
    }
    return new Response("Zero-Native Fast Refresh Dev Server Running on :8082");
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`[DEV_SERVER] 📱 Device connected! (Total clients: ${clients.size})`);
      // Immediately push latest bytecode on connection
      if (latestBytecode) {
        ws.send(latestBytecode);
        console.log(`[DEV_SERVER] Pushed initial bytecode (${latestBytecode.length} bytes) to new device.`);
      }
    },
    message(ws, msg) {
      console.log(`[DEV_SERVER] Message from device:`, msg);
    },
    close(ws) {
      clients.delete(ws);
      console.log(`[DEV_SERVER] 📱 Device disconnected. (Remaining clients: ${clients.size})`);
    },
  },
});

console.log(`\n========================================================`);
console.log(`  ⚡ ZERO-NATIVE FAST REFRESH DEV SERVER (BUN + HERMES)`);
console.log(`  Listening on ws://127.0.0.1:${PORT}`);
console.log(`========================================================\n`);

// Compile initial bytecode
compileBytecode().then((bc) => {
  latestBytecode = bc;
});

// Watch directory for changes
let debounceTimer: Timer | null = null;
let isBuilding = false;

watch(JS_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  // Ignore output files and node_modules
  if (filename.includes("dist") || filename.includes("node_modules") || filename.endsWith(".hbc") || filename.endsWith(".js")) {
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (isBuilding) return;
    isBuilding = true;
    console.log(`\n[WATCHER] 📝 File changed: ${filename}`);
    const bc = await compileBytecode();
    if (bc && clients.size > 0) {
      latestBytecode = bc;
      const sendStart = performance.now();
      for (const client of clients) {
        client.send(bc);
      }
      const sendMs = performance.now() - sendStart;
      console.log(`[DEV_SERVER] 🚀 Broadcasted ${bc.length} bytes to ${clients.size} client(s) in ${sendMs.toFixed(2)}ms`);
    }
    isBuilding = false;
  }, 25);
});

