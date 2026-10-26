// Runs the FastAPI backend and the Next.js frontend together. Ctrl+C stops both.
//   npm run dev     development (hot reload)
//   npm run start   production (run `npm run build` first)
//
// Ports default to 8000 (API) and 3000 (web). Busy ports are skipped automatically in dev;
// set API_PORT / WEB_PORT to choose them yourself.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const prod = process.argv.includes("--prod");
const HOST = "127.0.0.1"; // local only: the app holds AWS credentials, so don't expose it to the network
const python = join(root, "backend", ".venv", isWin ? "Scripts/python.exe" : "bin/python");

const fail = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

if (!existsSync(python) || !existsSync(join(root, "frontend", "node_modules"))) {
  fail("Dependencies are missing. Run: npm run setup");
}

/** True when something already accepts connections on the port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: HOST });
    socket.setTimeout(600);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

/** Is a Lemon web app already being served here? (Its /api/health answers with app: "lemon".) */
async function lemonAt(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return body?.ok === true && body.app === "lemon";
  } catch {
    return false;
  }
}

async function choosePort(envName, preferred, label) {
  const explicit = process.env[envName];
  const start = Number(explicit ?? preferred);
  if (!Number.isInteger(start) || start < 1 || start > 65535) fail(`${envName} must be a port number.`);
  if (explicit || prod) {
    if (await portInUse(start)) {
      fail(
        `Port ${start} (${label}) is already in use.` +
          (explicit ? "" : ` Free it, or pick another with ${envName}=<port>${prod ? " and rebuild" : ""}.`),
      );
    }
    return start;
  }
  for (let port = start; port < start + 50; port++) {
    if (!(await portInUse(port))) {
      if (port !== start) console.log(`  Port ${start} is busy, so the ${label} will use ${port}.`);
      return port;
    }
  }
  fail(`No free port found for the ${label} between ${start} and ${start + 49}.`);
}

/** The backend URL a production build proxies /api to (rewrites are fixed at build time). */
function builtBackendPort() {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "frontend", ".next", "routes-manifest.json"), "utf8"));
    const rewrites = [manifest.rewrites].flat().concat(manifest.rewrites?.beforeFiles ?? [], manifest.rewrites?.afterFiles ?? []);
    const dest = rewrites.find((r) => r?.source?.startsWith("/api"))?.destination ?? "";
    const match = /:(\d+)\/api/.exec(dest);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const preferredWeb = Number(process.env.WEB_PORT ?? 3000);
if (await lemonAt(preferredWeb)) {
  console.log(`\n  Lemon is already running → http://localhost:${preferredWeb}\n  (Stop that one first if you want to restart it.)\n`);
  process.exit(0);
}

let apiPort;
if (prod) {
  const built = builtBackendPort();
  if (built === null) fail("No production build found. Run: npm run build");
  if (process.env.API_PORT && Number(process.env.API_PORT) !== built) {
    fail(`This build proxies to port ${built}. Rebuild with BACKEND_URL=http://${HOST}:${process.env.API_PORT}.`);
  }
  process.env.API_PORT = String(built);
  apiPort = await choosePort("API_PORT", built, "API");
} else {
  apiPort = await choosePort("API_PORT", 8000, "API");
}
const webPort = await choosePort("WEB_PORT", 3000, "web app");

const colors = { api: "\x1b[36m", web: "\x1b[35m" };
const children = [];

function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...opts.env } });
  const prefix = `${colors[name]}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) out.write(prefix + line + "\n");
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// uvicorn's reloader restarts its worker on Windows with a console Ctrl+C event, which only works
// when uvicorn owns its terminal (and would also hit Next.js here). On Windows, run the backend in
// its own terminal for auto-reload: see README "Run frontend and backend separately".
const reload = !prod && !isWin;
start(
  "api",
  python,
  ["-m", "uvicorn", "app.main:app", "--host", HOST, "--port", String(apiPort), ...(reload ? ["--reload", "--reload-dir", "app"] : [])],
  { cwd: join(root, "backend"), env: { PYTHONUNBUFFERED: "1" } },
);
// Run the Next.js CLI with node directly: no shell (and no Windows .cmd quoting issues).
const nextBin = join(root, "frontend", "node_modules", "next", "dist", "bin", "next");
start("web", process.execPath, [nextBin, prod ? "start" : "dev", "--hostname", HOST, "--port", String(webPort)], {
  cwd: join(root, "frontend"),
  env: { BACKEND_URL: `http://${HOST}:${apiPort}` },
});

console.log(`\n  ➜ Open http://localhost:${webPort}\n`);
