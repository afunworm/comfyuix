#!/usr/bin/env node
"use strict";

const WebSocket = require("ws");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");

const VERSION = require("./package.json").version;

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL = (process.env.COMFYUIX_SERVER_URL || "").replace(/^https?:\/\//, "").replace(/\/+$/, ""); // e.g. yourserver.com or https://yourserver.com
const IS_SECURE =
	!/^(localhost|host\.docker\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$/.test(
		SERVER_URL,
	);
const WS_SCHEME = IS_SECURE ? "wss" : "ws";
const TOKEN = process.env.COMFYUIX_TOKEN;
const COMFY_HOST = process.env.COMFY_HOST || "127.0.0.1";
const COMFY_PORT = parseInt(process.env.COMFY_PORT || "8188", 10);
const MODELS_PATH = path.resolve(process.env.MODELS_PATH || "/models");

// ── Logging ───────────────────────────────────────────────────────────────────
function ts() {
	return new Date().toISOString();
}
function log(...args) {
	console.log(`[${ts()}] [Tunnel]`, ...args);
}
function err(...args) {
	console.error(`[${ts()}] [Tunnel][ERROR]`, ...args);
}

log("=== comfyuix-tunnel starting ===");
log(
	`  Connecting to ComfyUIX server : ${SERVER_URL ? `${WS_SCHEME === "wss" ? "https" : "http"}://${SERVER_URL}` : "(not set)"}`,
);
log(`  ComfyUI running at            : ${COMFY_HOST}:${COMFY_PORT}`);
log(`  Models path                   : ${MODELS_PATH}`);
log(
	`  Token                         : ${TOKEN ? TOKEN.slice(0, 8) + "…" + TOKEN.slice(-4) + ` (${TOKEN.length} chars)` : "(not set)"}`,
);

if (!SERVER_URL || !TOKEN) {
	err("COMFYUIX_SERVER_URL and COMFYUIX_TOKEN are required");
	process.exit(1);
}

// ── Startup precheck ──────────────────────────────────────────────────────────
function precheck() {
	return new Promise((resolve) => {
		log(`Precheck: reaching ComfyUI at http://${COMFY_HOST}:${COMFY_PORT}/system_stats …`);
		const req = http.request(
			{ hostname: COMFY_HOST, port: COMFY_PORT, path: "/system_stats", method: "GET", timeout: 5000 },
			(res) => {
				res.resume();
				log(`Precheck: ComfyUI responded with HTTP ${res.statusCode} ✓`);
				resolve();
			},
		);
		req.on("timeout", () => {
			req.destroy();
			err(`Precheck: timed out connecting to ComfyUI at ${COMFY_HOST}:${COMFY_PORT} — is it running?`);
			resolve();
		});
		req.on("error", (e) => {
			err(`Precheck: cannot reach ComfyUI at ${COMFY_HOST}:${COMFY_PORT} — ${e.message}`);
			err(
				`  Hint: if running in Docker on Windows/macOS, set COMFY_HOST=host.docker.internal and remove network_mode`,
			);
			err(`  Hint: if running in Docker on Linux, set network_mode: host and COMFY_HOST=127.0.0.1`);
			resolve();
		});
		req.end();
	});
}

// ── Path allowlist ────────────────────────────────────────────────────────────
const ALLOWED_PREFIXES = [
	"/prompt",
	"/queue",
	"/history",
	"/interrupt",
	"/upload/",
	"/view",
	"/api/view",
	"/system_stats",
	"/free",
	"/ws",
	"/object_info",
	"/embeddings",
	"/extensions",
	"/models",
	"/samplers",
	"/schedulers",
];

function isAllowedPath(path) {
	const bare = path.split("?")[0];
	return ALLOWED_PREFIXES.some((p) => bare === p || bare.startsWith(p));
}

// ── State ─────────────────────────────────────────────────────────────────────
const RECONNECT_INTERVAL = 2000;

let ws = null;
let connectAttempt = 0;
let reconnectScheduled = false;

function scheduleReconnect() {
	if (reconnectScheduled) return;
	reconnectScheduled = true;
	log(`Reconnecting in ${RECONNECT_INTERVAL / 1000}s…`);
	setTimeout(() => {
		reconnectScheduled = false;
		connect();
	}, RECONNECT_INTERVAL);
}
const wsSessions = new Map(); // tunnelId → WebSocket (to ComfyUI)
const activeFetches = new Map(); // fetchId → { dest, percent }

// ── Send helper ───────────────────────────────────────────────────────────────
function send(msg) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

// ── Fetch progress helper ────────────────────────────────────────────────────
function sendFetchProgress(fetchId, percent, done, errorMsg, bytes) {
	if (done) {
		activeFetches.delete(fetchId);
	} else {
		const entry = activeFetches.get(fetchId);
		if (entry) {
			entry.percent = percent;
			if (bytes !== undefined) entry.bytes = bytes;
		}
	}
	const msg = { type: "fs_fetch_progress", fetchId, percent, done: !!done };
	if (errorMsg) msg.error = errorMsg;
	if (bytes !== undefined) msg.bytes = bytes;
	send(msg);
}

// ── Message handlers ──────────────────────────────────────────────────────────
function handleHttpRequest(msg) {
	const { requestId, method, path, headers, body } = msg;
	log(`HTTP  → ${method} ${path}  [req ${requestId.slice(0, 8)}]`);

	if (!isAllowedPath(path)) {
		err(`HTTP  → ${method} ${path} BLOCKED (not in allowlist)`);
		send({ type: "http_error", requestId, message: "Path not allowed" });
		return;
	}

	const bodyBuf = body ? Buffer.from(body, "base64") : null;

	const cleanHeaders = Object.assign({}, headers);
	delete cleanHeaders["host"];
	delete cleanHeaders["connection"];
	delete cleanHeaders["transfer-encoding"];
	if (bodyBuf) cleanHeaders["content-length"] = bodyBuf.length;

	const req = http.request(
		{
			hostname: COMFY_HOST,
			port: COMFY_PORT,
			path,
			method,
			headers: cleanHeaders,
		},
		(res) => {
			log(`HTTP  ← ${res.statusCode} ${method} ${path}  [req ${requestId.slice(0, 8)}]`);
			const responseHeaders = Object.assign({}, res.headers);
			delete responseHeaders["transfer-encoding"];
			delete responseHeaders["connection"];

			send({
				type: "http_response_head",
				requestId,
				status: res.statusCode,
				headers: responseHeaders,
			});

			let bytesSent = 0;
			res.on("data", (chunk) => {
				bytesSent += chunk.length;
				send({
					type: "http_chunk",
					requestId,
					data: chunk.toString("base64"),
				});
			});

			res.on("end", () => {
				log(`HTTP  ↓ end  ${method} ${path}  ${bytesSent}b  [req ${requestId.slice(0, 8)}]`);
				send({ type: "http_end", requestId });
			});

			res.on("error", (e) => {
				err(`HTTP  ↓ response error  ${method} ${path}: ${e.message}  [req ${requestId.slice(0, 8)}]`);
				send({ type: "http_error", requestId, message: e.message });
			});
		},
	);

	req.on("error", (e) => {
		err(`HTTP  → request error  ${method} ${path}: ${e.message}  [req ${requestId.slice(0, 8)}]`);
		send({ type: "http_error", requestId, message: e.message });
	});

	if (bodyBuf) {
		log(`HTTP  → sending body  ${bodyBuf.length}b  [req ${requestId.slice(0, 8)}]`);
		req.write(bodyBuf);
	}
	req.end();
}

function handleWsOpen(msg) {
	const { tunnelId, path } = msg;
	log(`WS    → open  tunnelId=${tunnelId.slice(0, 8)}  path=${path}`);

	if (!isAllowedPath(path)) {
		err(`WS    → open BLOCKED  path=${path}  tunnelId=${tunnelId.slice(0, 8)}`);
		send({ type: "ws_closed", tunnelId, code: 1008 });
		return;
	}

	const comfyUrl = `ws://${COMFY_HOST}:${COMFY_PORT}${path}`;
	log(`WS    → connecting to ComfyUI at ${comfyUrl}  tunnelId=${tunnelId.slice(0, 8)}`);
	const comfyWs = new WebSocket(comfyUrl);
	wsSessions.set(tunnelId, comfyWs);

	comfyWs.on("open", () => {
		log(`WS    ↔ ComfyUI connected  tunnelId=${tunnelId.slice(0, 8)}`);
	});

	comfyWs.on("message", (data, isBinary) => {
		log(
			`WS    ← ComfyUI message  ${isBinary ? "binary" : "text"}  ${data.length}b  tunnelId=${tunnelId.slice(0, 8)}`,
		);
		send({
			type: "ws_message",
			tunnelId,
			data: isBinary ? data.toString("base64") : data.toString(),
			isBinary,
		});
	});

	comfyWs.on("close", (code, reason) => {
		log(
			`WS    ↓ ComfyUI closed  code=${code}  reason=${reason?.toString() || ""}  tunnelId=${tunnelId.slice(0, 8)}`,
		);
		wsSessions.delete(tunnelId);
		send({ type: "ws_closed", tunnelId, code });
	});

	comfyWs.on("error", (e) => {
		err(`WS    ↓ ComfyUI error: ${e.message}  tunnelId=${tunnelId.slice(0, 8)}`);
		wsSessions.delete(tunnelId);
		send({ type: "ws_closed", tunnelId, code: 1011 });
	});
}

// ── Filesystem helpers ────────────────────────────────────────────────────────
function resolveSafe(relPath) {
	const resolved = path.resolve(MODELS_PATH, relPath || "");
	const base = MODELS_PATH.endsWith(path.sep) ? MODELS_PATH : MODELS_PATH + path.sep;
	if (resolved !== MODELS_PATH && !resolved.startsWith(base)) {
		throw new Error("Path traversal not allowed");
	}
	return resolved;
}

async function listDir(dir, baseDir, recursive) {
	const dirents = await fsp.readdir(dir, { withFileTypes: true });
	const entries = [];
	for (const d of dirents) {
		const fullPath = path.join(dir, d.name);
		const stat = await fsp.stat(fullPath).catch(() => null);
		entries.push({
			name: d.name,
			path: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
			type: d.isDirectory() ? "directory" : "file",
			size: stat ? stat.size : 0,
			mtime: stat ? stat.mtime.toISOString() : null,
		});
		if (recursive && d.isDirectory()) {
			const sub = await listDir(fullPath, baseDir, true);
			entries.push(...sub);
		}
	}
	return entries;
}

async function handleFsList(msg) {
	const { requestId, path: relPath, recursive } = msg;
	try {
		const dir = resolveSafe(relPath);
		const entries = await listDir(dir, dir, !!recursive);
		send({ type: "fs_list_response", requestId, entries });
	} catch (e) {
		send({ type: "fs_list_response", requestId, error: e.message });
	}
}

async function handleFsDelete(msg) {
	const { requestId, path: relPath } = msg;
	try {
		const absPath = resolveSafe(relPath);
		await fsp.rm(absPath, { recursive: true, force: true });
		send({ type: "fs_delete_response", requestId });
	} catch (e) {
		send({ type: "fs_delete_response", requestId, error: e.message });
	}
}

async function handleFsMkdir(msg) {
	const { requestId, path: relPath } = msg;
	try {
		const absPath = resolveSafe(relPath);
		await fsp.mkdir(absPath, { recursive: true });
		send({ type: "fs_mkdir_response", requestId });
	} catch (e) {
		send({ type: "fs_mkdir_response", requestId, error: e.message });
	}
}

async function handleFsRename(msg) {
	const { requestId, from, to } = msg;
	try {
		const absFrom = resolveSafe(from);
		const absTo = resolveSafe(to);
		await fsp.rename(absFrom, absTo);
		send({ type: "fs_rename_response", requestId });
	} catch (e) {
		send({ type: "fs_rename_response", requestId, error: e.message });
	}
}

function doDownload(url, absPath, fetchId, redirectsLeft, extraHeaders) {
	if (redirectsLeft <= 0) {
		sendFetchProgress(fetchId, 0, true, "Too many redirects");
		return;
	}
	let urlObj;
	try {
		urlObj = new URL(url);
	} catch (e) {
		sendFetchProgress(fetchId, 0, true, "Invalid URL: " + url);
		return;
	}
	const proto = urlObj.protocol === "https:" ? https : http;
	const reqHeaders = Object.assign({ "User-Agent": "comfyuix-tunnel/1.0" }, extraHeaders || {});
	const req = proto.get(url, { headers: reqHeaders }, (res) => {
		if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
			res.resume();
			const location = res.headers.location || "";
			let redirectUrl;
			try {
				redirectUrl = new URL(location, url).href;
			} catch (e) {
				sendFetchProgress(fetchId, 0, true, "Invalid redirect URL: " + location);
				return;
			}
			doDownload(redirectUrl, absPath, fetchId, redirectsLeft - 1, extraHeaders);
			return;
		}
		if (res.statusCode !== 200) {
			res.resume();
			sendFetchProgress(fetchId, 0, true, `HTTP ${res.statusCode}`);
			return;
		}
		const total = parseInt(res.headers["content-length"] || "0", 10);
		let received = 0;
		let lastPercent = -1;
		const fileStream = fs.createWriteStream(absPath);
		let lastBytesMark = 0;
		const BYTES_INTERVAL = 2 * 1024 * 1024; // send update every 2 MB when size unknown
		res.on("data", (chunk) => {
			received += chunk.length;
			if (total > 0) {
				const percent = Math.floor((received / total) * 100);
				if (percent !== lastPercent) {
					lastPercent = percent;
					sendFetchProgress(fetchId, percent, false, undefined, received);
				}
			} else if (received - lastBytesMark >= BYTES_INTERVAL) {
				lastBytesMark = received;
				sendFetchProgress(fetchId, 0, false, undefined, received);
			}
		});
		res.pipe(fileStream);
		fileStream.on("finish", () => {
			log(`FS    ↓ fetch done  fetchId=${fetchId.slice(0, 8)}  dest=${absPath}`);
			sendFetchProgress(fetchId, 100, true);
		});
		fileStream.on("error", (e) => {
			sendFetchProgress(fetchId, 0, true, e.message);
		});
		res.on("error", (e) => {
			sendFetchProgress(fetchId, 0, true, e.message);
		});
	});
	const entry = activeFetches.get(fetchId);
	if (entry)
		entry.abort = () => {
			entry.cancelled = true;
			req.destroy();
		};
	req.on("error", (e) => {
		if (activeFetches.get(fetchId)?.cancelled) {
			const cancelEntry = activeFetches.get(fetchId);
			if (cancelEntry?.absPath) {
				try {
					fs.unlinkSync(cancelEntry.absPath);
				} catch {}
			}
			sendFetchProgress(fetchId, 0, true, "Cancelled");
		} else {
			sendFetchProgress(fetchId, 0, true, e.message);
		}
	});
}

async function handleFsReadMeta(msg) {
	const { requestId, path: relPath } = msg;
	try {
		const absPath = resolveSafe(relPath);
		const ext = absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase();
		if (ext !== "safetensors") {
			send({ type: "fs_meta_response", requestId, meta: null });
			return;
		}
		const fd = await fsp.open(absPath, "r");
		try {
			const lenBuf = Buffer.alloc(8);
			await fd.read(lenBuf, 0, 8, 0);
			const headerLen = Number(lenBuf.readBigUInt64LE(0));
			if (headerLen > 100 * 1024 * 1024) {
				send({ type: "fs_meta_response", requestId, error: "Header too large" });
				return;
			}
			const headerBuf = Buffer.alloc(headerLen);
			await fd.read(headerBuf, 0, headerLen, 8);
			const header = JSON.parse(headerBuf.toString("utf-8"));
			const userMeta = header.__metadata__ ?? {};
			const tensorKeys = Object.keys(header).filter((k) => k !== "__metadata__");
			const dtypeCounts = {};
			for (const k of tensorKeys) {
				const dtype = header[k]?.dtype;
				if (dtype) dtypeCounts[dtype] = (dtypeCounts[dtype] || 0) + 1;
			}
			send({
				type: "fs_meta_response",
				requestId,
				meta: {
					...userMeta,
					_tensor_count: tensorKeys.length,
					_dtype_counts: dtypeCounts,
				},
			});
		} finally {
			await fd.close();
		}
	} catch (e) {
		send({ type: "fs_meta_response", requestId, error: e.message });
	}
}

async function handleFsFetchUrl(msg) {
	const { fetchId, url, dest, headers } = msg;
	log(`FS    → fetch  fetchId=${fetchId.slice(0, 8)}  url=${url}  dest=${dest}`);
	activeFetches.set(fetchId, { dest, percent: 0, cancelled: false, abort: null, absPath: null });
	try {
		const absPath = resolveSafe(dest);
		activeFetches.get(fetchId).absPath = absPath;
		await fsp.mkdir(path.dirname(absPath), { recursive: true });
		doDownload(url, absPath, fetchId, 5, headers || {});
	} catch (e) {
		sendFetchProgress(fetchId, 0, true, e.message);
	}
}

// ── Message handlers ──────────────────────────────────────────────────────────
function handleMessage(msg) {
	switch (msg.type) {
		case "ping":
			log(`PING  ← server  → sending pong`);
			send({ type: "pong" });
			break;

		case "http_request":
			handleHttpRequest(msg);
			break;

		case "ws_open":
			handleWsOpen(msg);
			break;

		case "ws_message": {
			const session = wsSessions.get(msg.tunnelId);
			if (!session || session.readyState !== WebSocket.OPEN) {
				err(`WS    → message for unknown/closed session  tunnelId=${msg.tunnelId?.slice(0, 8)}`);
				break;
			}
			log(`WS    → client message  ${msg.isBinary ? "binary" : "text"}  tunnelId=${msg.tunnelId.slice(0, 8)}`);
			const data = msg.isBinary ? Buffer.from(msg.data, "base64") : msg.data;
			session.send(data, { binary: !!msg.isBinary });
			break;
		}

		case "ws_close": {
			const session = wsSessions.get(msg.tunnelId);
			log(
				`WS    → close request  code=${msg.code}  tunnelId=${msg.tunnelId?.slice(0, 8)}  session=${session ? "found" : "not found"}`,
			);
			if (session) {
				session.close(msg.code || 1000);
				wsSessions.delete(msg.tunnelId);
			}
			break;
		}

		case "fs_list":
			handleFsList(msg);
			break;

		case "fs_delete":
			handleFsDelete(msg);
			break;

		case "fs_rename":
			handleFsRename(msg);
			break;

		case "fs_mkdir":
			handleFsMkdir(msg);
			break;

		case "fs_fetch_url":
			handleFsFetchUrl(msg);
			break;

		case "fs_read_meta":
			handleFsReadMeta(msg);
			break;

		case "fs_fetch_cancel": {
			const entry = activeFetches.get(msg.fetchId);
			if (entry?.abort) {
				entry.abort();
			} else {
				sendFetchProgress(msg.fetchId, 0, true, "Cancelled");
			}
			break;
		}

		default:
			log(`MSG   ← unknown type: ${msg.type}`);
	}
}

// ── Connection ────────────────────────────────────────────────────────────────
function connect() {
	connectAttempt++;
	const maskedToken = TOKEN.slice(0, 8) + "…" + TOKEN.slice(-4);
	const url = `${WS_SCHEME}://${SERVER_URL}/tunnel?token=${TOKEN}`;
	const displayUrl = `${WS_SCHEME}://${SERVER_URL}/tunnel?token=${maskedToken}`;
	log(`Connecting (attempt #${connectAttempt})  url=${displayUrl}`);

	ws = new WebSocket(url);

	ws.on("open", () => {
		log(`Tunnel established  readyState=${ws.readyState}  attempt=#${connectAttempt}`);
		send({ type: "sidecar_info", platform: os.platform(), version: VERSION });
		if (activeFetches.size > 0) {
			log(`Reporting ${activeFetches.size} active download(s) to server`);
			const fetches = [...activeFetches.entries()].map(([fetchId, info]) => ({
				fetchId,
				dest: info.dest,
				percent: info.percent,
			}));
			send({ type: "fs_fetch_active", fetches });
		}
	});

	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch (e) {
			err(`Failed to parse message: ${e.message}  raw=${data.toString().slice(0, 200)}`);
			return;
		}
		if (msg.type !== "ping") {
			log(`MSG   ← type=${msg.type}`);
		}
		try {
			handleMessage(msg);
		} catch (e) {
			err(`Failed to handle message type=${msg.type}: ${e.message}`);
		}
	});

	ws.on("unexpected-response", (req, res) => {
		err(`Unexpected HTTP response: ${res.statusCode} ${res.statusMessage}`);
		let body = "";
		res.on("data", (chunk) => {
			body += chunk.toString();
		});
		res.on("end", () => {
			if (body) err(`Response body: ${body.slice(0, 500)}`);
			scheduleReconnect();
		});
	});

	ws.on("close", (code, reason) => {
		const reasonStr = reason?.toString() || "";
		log(`Disconnected  code=${code}  reason=${reasonStr || "(none)"}  active_ws_sessions=${wsSessions.size}`);
		for (const [id, session] of wsSessions) {
			log(`Closing orphaned WS session  tunnelId=${id.slice(0, 8)}`);
			try {
				session.close();
			} catch {}
		}
		wsSessions.clear();
		scheduleReconnect();
	});

	ws.on("error", (e) => {
		err(`Connection error: ${e.message}  (code=${e.code || "n/a"})`);
	});
}

precheck().then(() => connect());
