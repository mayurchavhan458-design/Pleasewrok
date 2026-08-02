"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 5000;
const USERNAME = process.env.KAY_USER || "KAY";
const PASSWORD = process.env.KAY_PASS || "1010";

const BASE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const SERVERS_DIR = path.join(BASE_DIR, "servers");
const METADATA_FILE = path.join(BASE_DIR, "servers.json");

if (!fs.existsSync(SERVERS_DIR)) fs.mkdirSync(SERVERS_DIR, { recursive: true });
if (!fs.existsSync(METADATA_FILE)) fs.writeFileSync(METADATA_FILE, JSON.stringify([]));

function getServers() {
  try { return JSON.parse(fs.readFileSync(METADATA_FILE)); } 
  catch { return []; }
}

function saveServers(servers) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(servers, null, 2));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const serverId = req.params.serverId;
    const dest = path.join(SERVERS_DIR, serverId);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET || "kay_host_cyber_secret_9988",
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect("/login");
}

const runningProcesses = {}; 

function ensureInstanceExists(serverId) {
  if (!runningProcesses[serverId]) {
    runningProcesses[serverId] = { process: null, logs: [], status: "STOPPED", port: null };
  }
  return runningProcesses[serverId];
}

function broadcastToApp(serverId, data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.serverId === serverId) {
      client.send(JSON.stringify(data));
    }
  });
}

function addLog(serverId, message) {
  const instance = ensureInstanceExists(serverId);
  const formatted = `[${new Date().toLocaleTimeString()}] ${message}`;
  instance.logs.push(formatted);
  if (instance.logs.length > 500) instance.logs.shift();
  broadcastToApp(serverId, { type: "log", data: formatted });
}

// ================= ROUTES =================

app.get("/login", (req, res) => res.render("login", { error: null }));

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    req.session.authenticated = true;
    res.redirect("/");
  } else {
    res.render("login", { error: "Invalid Credentials!" });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

app.get("/", requireAuth, (req, res) => {
  const servers = getServers();
  if (servers.length === 0) return res.redirect("/create-server");
  res.redirect(`/server/${servers[0].id}`);
});

app.get("/create-server", requireAuth, (req, res) => {
  res.render("create-server", { servers: getServers() });
});

app.post("/create-server", requireAuth, (req, res) => {
  const { name, assignedPort } = req.body;
  const servers = getServers();
  const serverId = "srv-" + Date.now();

  const newServer = {
    id: serverId,
    name: name || `Server-${servers.length + 1}`,
    port: assignedPort || (3000 + servers.length).toString(),
    created: new Date().toLocaleDateString(),
  };

  servers.push(newServer);
  saveServers(servers);

  const serverPath = path.join(SERVERS_DIR, serverId);
  if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });

  ensureInstanceExists(serverId);
  runningProcesses[serverId].port = newServer.port;
  res.redirect(`/server/${serverId}`);
});

app.get("/server/:serverId", requireAuth, (req, res) => {
  const servers = getServers();
  const currentServer = servers.find((s) => s.id === req.params.serverId);
  if (!currentServer) return res.redirect("/");

  const instance = ensureInstanceExists(currentServer.id);
  res.render("dashboard", { servers, currentServer, status: instance.status });
});

app.get("/server/:serverId/files", requireAuth, (req, res) => {
  const servers = getServers();
  const currentServer = servers.find((s) => s.id === req.params.serverId);
  if (!currentServer) return res.redirect("/");

  const dirPath = path.join(SERVERS_DIR, currentServer.id);
  fs.readdir(dirPath, (err, files) => {
    const fileList = (files || []).map((file) => {
      const stats = fs.statSync(path.join(dirPath, file));
      return {
        name: file,
        size: (stats.size / 1024).toFixed(2) + " KB",
        updated: stats.mtime.toLocaleString(),
      };
    });
    res.render("files", { servers, currentServer, files: fileList });
  });
});

app.post("/server/:serverId/files/upload", requireAuth, (req, res) => {
  upload.array("file")(req, res, (err) => {
    if (!err) addLog(req.params.serverId, `[System] File(s) Uploaded Successfully.`);
    res.redirect(`/server/${req.params.serverId}/files`);
  });
});

app.post("/server/:serverId/files/delete", requireAuth, (req, res) => {
  const { filenames } = req.body;
  const serverPath = path.join(SERVERS_DIR, req.params.serverId);

  if (Array.isArray(filenames)) {
    filenames.forEach((file) => {
      const target = path.join(serverPath, file);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    });
    addLog(req.params.serverId, `[System] Deleted file(s): ${filenames.join(", ")}`);
  }
  res.json({ success: true });
});

// ================= PROCESS CONTROL =================

function startServerProcess(serverId) {
  const serverPath = path.join(SERVERS_DIR, serverId);
  const instance = ensureInstanceExists(serverId);

  if (instance.process) {
    addLog(serverId, "[System] Process is already running!");
    return;
  }

  const hasIndex = fs.existsSync(path.join(serverPath, "index.js"));
  const hasPkg = fs.existsSync(path.join(serverPath, "package.json"));

  if (!hasIndex) {
    addLog(serverId, "[Error] index.js missing! Upload it from File Option.");
    return;
  }

  if (hasPkg) {
    addLog(serverId, "[System] Running 'npm install'...");
    instance.status = "BUILDING";
    broadcastToApp(serverId, { type: "status", status: "BUILDING" });

    const installer = spawn("npm", ["install"], { cwd: serverPath, shell: true });
    installer.stdout.on("data", (d) => addLog(serverId, `[npm] ${d.toString().trim()}`));
    installer.stderr.on("data", (d) => addLog(serverId, `[npm ERR] ${d.toString().trim()}`));

    installer.on("close", (code) => {
      if (code === 0) {
        addLog(serverId, "[System] Build completed. Launching script...");
        launchScript(serverId, serverPath);
      } else {
        addLog(serverId, "[Error] Build failed!");
        instance.status = "STOPPED";
        broadcastToApp(serverId, { type: "status", status: "STOPPED" });
      }
    });
  } else {
    launchScript(serverId, serverPath);
  }
}

function launchScript(serverId, serverPath) {
  const instance = ensureInstanceExists(serverId);
  instance.status = "RUNNING";
  broadcastToApp(serverId, { type: "status", status: "RUNNING" });

  const servers = getServers();
  const current = servers.find((s) => s.id === serverId);
  const assignedPort = current ? current.port : "3000";
  const envVars = { ...process.env, PORT: assignedPort };

  instance.port = assignedPort;

  instance.process = spawn("node", ["index.js"], { 
    cwd: serverPath, 
    shell: true, 
    env: envVars 
  });

  instance.process.stdout.on("data", (d) => addLog(serverId, d.toString().trim()));
  instance.process.stderr.on("data", (d) => addLog(serverId, `[STDERR] ${d.toString().trim()}`));

  instance.process.on("close", (code) => {
    addLog(serverId, `[System] Process terminated (Code: ${code})`);
    instance.process = null;
    instance.status = "STOPPED";
    broadcastToApp(serverId, { type: "status", status: "STOPPED" });
  });
}

function stopServerProcess(serverId, callback) {
  const instance = ensureInstanceExists(serverId);
  addLog(serverId, "[System] Force Stopping Process...");

  if (instance.process) {
    try { 
      instance.process.kill("SIGKILL"); 
      if (instance.process.pid) process.kill(-instance.process.pid, "SIGKILL");
    } catch (e) {}
    instance.process = null;
  }

  if (instance.port) {
    exec(`fuser -k -9 ${instance.port}/tcp || pkill -f "node index.js" || true`, () => {
      addLog(serverId, `[System] Process cleared on port ${instance.port}.`);
      instance.status = "STOPPED";
      broadcastToApp(serverId, { type: "status", status: "STOPPED" });
      if (callback) callback();
    });
  } else {
    instance.status = "STOPPED";
    broadcastToApp(serverId, { type: "status", status: "STOPPED" });
    if (callback) callback();
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === "REGISTER") {
        ws.serverId = msg.serverId;
        const instance = ensureInstanceExists(msg.serverId);
        ws.send(JSON.stringify({ type: "history", logs: instance.logs }));
        ws.send(JSON.stringify({ type: "status", status: instance.status }));
      }
      if (msg.action === "START") startServerProcess(ws.serverId);
      if (msg.action === "STOP") stopServerProcess(ws.serverId);
      if (msg.action === "RESTART") {
        addLog(ws.serverId, "[System] Restarting server...");
        stopServerProcess(ws.serverId, () => {
          setTimeout(() => startServerProcess(ws.serverId), 1500);
        });
      }
    } catch (e) {
      console.error("WebSocket Message Error:", e);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`KAY HOST Multi-Server live on port ${PORT}`));
