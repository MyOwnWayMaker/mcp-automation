/**
 * Updates FILETRAC_SESSION_JSON, XACTANALYSIS_SESSION_JSON, and GOOGLE_NOTARY_TOKEN_JSON on Railway.
 * Run from mcp-automation folder: node scripts/update-railway-sessions.mjs
 *
 * Why this script is necessary: the auth scripts (auth-filetrac.mjs,
 * auth-xactanalysis.mjs, etc.) write session files locally but the deployed
 * MCP server on Railway reads from env vars. Without pushing the local file
 * up to Railway, the deployed server keeps using the stale session.
 */
import { spawnSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

const files = {
  FILETRAC_SESSION_JSON:     path.join(root, "filetrac_session.json"),
  XACTANALYSIS_SESSION_JSON: path.join(root, "xactanalysis_session.json"),
  GOOGLE_NOTARY_TOKEN_JSON:  path.join(root, "token_notary.json"),
};

// Resolve the absolute path to `railway` once. spawnSync on Windows doesn't
// auto-resolve .exe extensions from PATH the way the cmd shell does, which
// silently failed before with "exit code null" on every call.
//
// On Windows, npm-installed CLIs typically have THREE files alongside each
// other: a no-extension shell script (works in Unix shells), a .cmd batch
// file (the Windows-executable shim), and a .ps1 (PowerShell). `where`
// often returns the no-extension file first, which Windows can't spawn.
// Prefer .cmd on Windows when the resolved file lacks an extension.
function resolveRailway() {
  const cmd = isWin ? "where railway" : "command -v railway";
  try {
    const out = execSync(cmd, { encoding: "utf-8" });
    const candidates = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (candidates.length === 0) throw new Error("`where railway` returned no path");

    if (isWin) {
      // Prefer .cmd (Windows-runnable). If `where` only returned the
      // extension-less shim, append .cmd and verify it exists.
      const cmdPath = candidates.find(p => /\.cmd$/i.test(p))
                   ?? candidates.find(p => /\.exe$/i.test(p));
      if (cmdPath) return cmdPath;

      // Fall back: try appending .cmd to the first candidate
      const guess = candidates[0] + ".cmd";
      if (fs.existsSync(guess)) return guess;
      throw new Error(`No .cmd or .exe variant found alongside ${candidates[0]}`);
    }

    return candidates[0];
  } catch (e) {
    console.error("❌  Could not locate the `railway` CLI on PATH.");
    console.error("    Install: https://docs.railway.com/guides/cli");
    console.error("    Or check PATH includes the directory where railway.exe lives.");
    console.error("    Underlying error:", e.message);
    process.exit(1);
  }
}

const railwayPath = resolveRailway();
console.log(`Using railway at: ${railwayPath}\n`);

let okCount = 0;
let failCount = 0;

for (const [key, filePath] of Object.entries(files)) {
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  Skipping ${key} — file not found at ${filePath}`);
    continue;
  }

  const value = fs.readFileSync(filePath, "utf8").trim();
  console.log(`Updating ${key} (${value.length} chars)...`);

  // Railway CLI v4 syntax: `railway variables --set "KEY=VALUE"`. Old v3
  // used `railway variables set KEY=VALUE`. Try the new syntax first; if
  // it fails with "unknown flag" (still on v3), fall back.
  let result = spawnSync(
    railwayPath,
    ["variables", "--set", `${key}=${value}`],
    { cwd: root, stdio: ["inherit", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 }
  );

  // If --set isn't recognized (older CLI), retry with subcommand syntax.
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : "";
    if (/unknown flag|unexpected argument|unrecognized/i.test(stderr)) {
      console.log(`   (--set syntax not recognized, falling back to "variables set")`);
      result = spawnSync(
        railwayPath,
        ["variables", "set", `${key}=${value}`],
        { cwd: root, stdio: ["inherit", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 }
      );
    }
  }

  if (result.error) {
    console.error(`❌  ${key} — spawn error: ${result.error.message}\n`);
    failCount++;
    continue;
  }
  if (result.status === 0) {
    console.log(`✅  ${key} updated\n`);
    okCount++;
  } else {
    const stdout = result.stdout ? result.stdout.toString().trim() : "";
    const stderr = result.stderr ? result.stderr.toString().trim() : "";
    console.error(`❌  ${key} failed (exit ${result.status})`);
    if (stdout) console.error(`    stdout: ${stdout}`);
    if (stderr) console.error(`    stderr: ${stderr}`);
    console.error("");
    failCount++;
  }
}

console.log(`\nDone. ${okCount} updated, ${failCount} failed.`);
if (failCount > 0) {
  console.log("Common causes:");
  console.log("  - `railway login` not done in this terminal (run: railway login)");
  console.log("  - `railway link` not pointing at the right project (run: railway link)");
  console.log("  - On Windows, value too large for cmd line (rare for sessions <8KB)");
  process.exit(1);
}
console.log("Railway will redeploy automatically (~60s).");
