// Frees the backend's dev port before starting, so a leftover process from a
// crashed/forcibly-closed previous run never blocks `npm run start`/`start:dev`
// with EADDRINUSE.
const { execSync } = require("child_process");

const port = process.env.PORT || 3001;

function killWindows(port) {
  let output;
  try {
    output = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
  } catch {
    return;
  }
  const myPid = process.pid;
  const pids = new Set();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (match && Number(match[1]) === Number(port)) {
      const pid = Number(match[2]);
      if (pid && pid !== myPid) pids.add(pid);
    }
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      console.log(`[free-port] killed stale process ${pid} on port ${port}`);
    } catch {
      // process may have already exited
    }
  }
}

function killUnix(port) {
  let pids;
  try {
    pids = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return;
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      console.log(`[free-port] killed stale process ${pid} on port ${port}`);
    } catch {
      // process may have already exited
    }
  }
}

if (process.platform === "win32") {
  killWindows(port);
} else {
  killUnix(port);
}
