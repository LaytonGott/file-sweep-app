const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const chokidar = require("chokidar");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const HOME = os.homedir();
const PLATFORM = os.platform(); // "win32", "darwin", "linux"
const VAULT = path.join(HOME, "FileVault", "collected");
const DEFAULT_PORT = 3777;

// === CROSS-PLATFORM WATCH FOLDERS ===
function getWatchFolders() {
  const folders = [path.join(HOME, "Downloads")];

  if (PLATFORM === "win32") {
    folders.push(path.join(HOME, "Pictures"));
    folders.push(path.join(HOME, "Pictures", "Screenshots"));
  } else if (PLATFORM === "darwin") {
    folders.push(path.join(HOME, "Pictures"));
    folders.push(path.join(HOME, "Desktop")); // Mac screenshots default to Desktop
    // Check for custom screenshot location
    const macScreenshots = path.join(HOME, "Screenshots");
    if (fs.existsSync(macScreenshots)) folders.push(macScreenshots);
  } else {
    folders.push(path.join(HOME, "Pictures"));
    const linuxScreenshots = path.join(HOME, "Pictures", "Screenshots");
    if (fs.existsSync(linuxScreenshots)) folders.push(linuxScreenshots);
  }

  return folders.filter((f) => fs.existsSync(f));
}

const WATCH_FOLDERS = getWatchFolders();

// === PERSISTENCE ===
const STATS_FILE = path.join(HOME, "FileVault", "stats.json");

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
  } catch {
    return { totalBytesFreed: 0 };
  }
}

function saveStats() {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify({ totalBytesFreed }, null, 2));
  } catch {}
}

// === STATE ===
let delayMs = 5 * 60 * 1000;
let watching = false;
let watcher = null;
const pending = new Map();
const history = [];
let idCounter = 0;
let totalBytesFreed = loadStats().totalBytesFreed;

const EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".heic", ".avif",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".mp3", ".wav", ".flac", ".ogg",
  ".zip", ".rar", ".7z", ".tar", ".gz",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".avif"]);

function getSubfolder(ext) {
  if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".heic", ".avif"].includes(ext)) return "Images";
  if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv"].includes(ext)) return "Documents";
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) return "Videos";
  if ([".mp3", ".wav", ".flac", ".ogg"].includes(ext)) return "Audio";
  if ([".zip", ".rar", ".7z", ".tar", ".gz"].includes(ext)) return "Archives";
  return "Other";
}

function uniquePath(destDir, filename) {
  let dest = path.join(destDir, filename);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let i = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(destDir, `${base}_${i}${ext}`);
    i++;
  }
  return dest;
}

function formatBytes(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb.toFixed(2) + " GB";
}

function getThumbnail(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  try {
    const stats = fs.statSync(filePath);
    // Skip thumbnails for files over 10MB to avoid memory issues
    if (stats.size > 10 * 1024 * 1024) return null;
    const buf = fs.readFileSync(filePath);
    const mime = ext === ".png" ? "image/png"
      : ext === ".gif" ? "image/gif"
      : ext === ".webp" ? "image/webp"
      : ext === ".bmp" ? "image/bmp"
      : ext === ".avif" ? "image/avif"
      : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function getFileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

// Cross-platform friendly folder name for display
function shortPath(fullPath) {
  return fullPath.split(path.sep).slice(-2).join("/");
}

function getQueueList() {
  return [...pending.values()].map((p) => ({
    id: p.id,
    filename: p.filename,
    detectedAt: p.detectedAt,
    sweepAt: p.sweepAt,
    source: shortPath(path.dirname(p.filePath)),
    thumbnail: p.thumbnail,
    size: p.size,
  }));
}

function sweepFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!EXTENSIONS.has(ext)) return;
  if (filePath.endsWith(".crdownload") || filePath.endsWith(".part") || filePath.endsWith(".tmp")) return;

  const id = ++idCounter;
  const filename = path.basename(filePath);
  const now = Date.now();
  const sweepAt = now + delayMs;
  const thumbnail = getThumbnail(filePath);
  const size = getFileSize(filePath);

  const timer = setTimeout(() => {
    pending.delete(id);

    const subfolder = getSubfolder(ext);
    const destDir = path.join(VAULT, subfolder);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = uniquePath(destDir, filename);

    try {
      if (!fs.existsSync(filePath)) {
        io.emit("swept", { id, filename, status: "gone", dest: null });
        return;
      }
      const fileSize = getFileSize(filePath);
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
      totalBytesFreed += fileSize;
      saveStats();
      const destRel = path.relative(HOME, dest).split(path.sep).join("/");
      const entry = {
        id, filename, dest: destRel, destFull: dest,
        originalPath: filePath, time: new Date().toISOString(),
        subfolder, size: fileSize, thumbnail,
      };
      history.unshift(entry);
      if (history.length > 50) history.pop();
      io.emit("swept", { id, filename, status: "ok", dest: destRel });
      io.emit("queue", getQueueList());
      io.emit("history", history);
      io.emit("stats", { totalBytesFreed, formatted: formatBytes(totalBytesFreed) });
    } catch {
      setTimeout(() => {
        try {
          if (!fs.existsSync(filePath)) return;
          const fileSize = getFileSize(filePath);
          fs.copyFileSync(filePath, dest);
          fs.unlinkSync(filePath);
          totalBytesFreed += fileSize;
          saveStats();
          const destRel = path.relative(HOME, dest).split(path.sep).join("/");
          const entry = {
            id, filename, dest: destRel, destFull: dest,
            originalPath: filePath, time: new Date().toISOString(),
            subfolder, size: fileSize, thumbnail,
          };
          history.unshift(entry);
          if (history.length > 50) history.pop();
          io.emit("swept", { id, filename, status: "ok", dest: destRel });
          io.emit("queue", getQueueList());
          io.emit("history", history);
          io.emit("stats", { totalBytesFreed, formatted: formatBytes(totalBytesFreed) });
        } catch {
          io.emit("swept", { id, filename, status: "error", dest: null });
        }
      }, 3000);
    }
  }, delayMs);

  pending.set(id, { id, filePath, filename, detectedAt: now, sweepAt, timer, thumbnail, size });
  io.emit("detected", { id, filename, sweepAt, thumbnail, size });
  io.emit("queue", getQueueList());
}

function startWatching() {
  if (watcher) watcher.close();
  watcher = chokidar.watch(WATCH_FOLDERS, {
    ignoreInitial: true,
    depth: 0,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });
  watcher.on("add", (fp) => sweepFile(fp));
  watching = true;
}

function stopWatching() {
  if (watcher) { watcher.close(); watcher = null; }
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
  watching = false;
}

// === ROUTES ===
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/vault-thumb/:subfolder/:filename", (req, res) => {
  const filePath = path.join(VAULT, req.params.subfolder, req.params.filename);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(VAULT))) return res.status(403).end();
  if (!fs.existsSync(resolved)) return res.status(404).end();
  res.sendFile(resolved);
});

// === SOCKET ===
io.on("connection", (socket) => {
  socket.emit("state", {
    watching, delayMs,
    queue: getQueueList(),
    history,
    vault: VAULT,
    folders: WATCH_FOLDERS.map(shortPath),
    stats: { totalBytesFreed, formatted: formatBytes(totalBytesFreed) },
  });

  socket.on("setDelay", (mins) => {
    delayMs = mins * 60 * 1000;
    io.emit("delayChanged", { delayMs });
  });

  socket.on("setDelayMs", (ms) => {
    delayMs = ms;
    io.emit("delayChanged", { delayMs });
  });

  socket.on("start", () => { startWatching(); io.emit("watchStatus", true); });
  socket.on("stop", () => { stopWatching(); io.emit("watchStatus", false); io.emit("queue", []); });

  socket.on("cancel", (id) => {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
      io.emit("cancelled", { id, filename: entry.filename });
      io.emit("queue", getQueueList());
    }
  });

  socket.on("cancelAll", () => {
    for (const [, p] of pending) clearTimeout(p.timer);
    pending.clear();
    io.emit("queue", []);
  });

  socket.on("undo", (historyId) => {
    const idx = history.findIndex((h) => h.id === historyId);
    if (idx === -1) return socket.emit("undoResult", { ok: false, msg: "Not found in history" });

    const entry = history[idx];
    const vaultPath = entry.destFull || path.join(HOME, entry.dest);

    if (!fs.existsSync(vaultPath)) {
      return socket.emit("undoResult", { ok: false, msg: "File no longer in vault" });
    }

    try {
      const originalDir = path.dirname(entry.originalPath);
      fs.mkdirSync(originalDir, { recursive: true });
      const restoreTo = uniquePath(originalDir, entry.filename);
      fs.copyFileSync(vaultPath, restoreTo);
      fs.unlinkSync(vaultPath);

      totalBytesFreed = Math.max(0, totalBytesFreed - (entry.size || 0));
      saveStats();
      history.splice(idx, 1);

      io.emit("history", history);
      io.emit("stats", { totalBytesFreed, formatted: formatBytes(totalBytesFreed) });
      socket.emit("undoResult", { ok: true, filename: entry.filename, restoredTo: path.basename(restoreTo) });
    } catch (err) {
      socket.emit("undoResult", { ok: false, msg: "Failed to restore: " + err.message });
    }
  });
});

// === START WITH PORT FALLBACK ===
function tryListen(port) {
  server.listen(port, () => {
    console.log(`Running at http://localhost:${port}`);
    import("open").then((m) => m.default(`http://localhost:${port}`)).catch(() => {});
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < DEFAULT_PORT + 10) {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      server.removeAllListeners("error");
      tryListen(port + 1);
    } else {
      console.error("Could not start server:", err.message);
      process.exit(1);
    }
  });
}

tryListen(DEFAULT_PORT);
