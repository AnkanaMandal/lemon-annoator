// One-time setup: Python venv + backend deps, frontend node_modules, .env files.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const backend = join(root, "backend");
const frontend = join(root, "frontend");
const venvPython = join(backend, ".venv", isWin ? "Scripts/python.exe" : "bin/python");

/**
 * Executables run without a shell, so paths with spaces stay intact. Only npm needs one on
 * Windows (it's a .cmd script); its arguments here are plain words, so nothing needs quoting.
 */
function exec(cmd, args, opts) {
  if (isWin && cmd === "npm") return spawnSync(`npm ${args.join(" ")}`, { ...opts, shell: true });
  return spawnSync(cmd, args, opts);
}

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const res = exec(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`\n✖ Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

function findPython() {
  for (const candidate of isWin ? ["py", "python", "python3"] : ["python3", "python"]) {
    const args = candidate === "py" ? ["-3", "--version"] : ["--version"];
    const res = exec(candidate, args, { encoding: "utf8" });
    const match = /Python (\d+)\.(\d+)/.exec(`${res.stdout}${res.stderr}`);
    if (res.status === 0 && match && (Number(match[1]) > 3 || Number(match[2]) >= 10)) {
      return candidate === "py" ? ["py", ["-3"]] : [candidate, []];
    }
  }
  console.error("✖ Python 3.10+ is required. Install it from https://www.python.org/downloads/");
  process.exit(1);
}

if (!existsSync(venvPython)) {
  const [py, pre] = findPython();
  run(py, [...pre, "-m", "venv", ".venv"], backend);
}
run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], backend);
run(venvPython, ["-m", "pip", "install", "-r", "requirements.txt"], backend);
run("npm", ["install"], frontend);

for (const [example, target] of [
  [join(backend, ".env.example"), join(backend, ".env")],
  [join(frontend, ".env.example"), join(frontend, ".env.local")],
]) {
  if (!existsSync(target)) {
    copyFileSync(example, target);
    console.log(`Created ${target}`);
  }
}

console.log(
  "\n✔ Setup complete. Fill in the Supabase values in backend/.env and frontend/.env.local (see README),\n" +
    "  then start the app with: npm run dev\n",
);
