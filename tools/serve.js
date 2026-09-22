#!/usr/bin/env node
/**
 * Zero-dependency static server for local development.
 *
 * Camera access needs a secure context, and `localhost` counts as one — so plain
 * HTTP is fine on this machine. Testing on a phone over the LAN does not count,
 * so `--https` generates a self-signed certificate (via openssl) and serves TLS;
 * you accept the browser warning once per device.
 *
 *   node tools/serve.js              # http://localhost:8080
 *   node tools/serve.js --https      # https://<lan-ip>:8443, for phones
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const useTls = process.argv.includes("--https");
const port = Number(process.env.PORT) || (useTls ? 8443 : 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function handler(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  });
}

function ensureCert() {
  const dir = path.join(ROOT, ".cert");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };

  fs.mkdirSync(dir, { recursive: true });
  const ips = lanAddresses();
  const san = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((ip) => `IP:${ip}`)].join(",");
  console.log("자체 서명 인증서를 만드는 중…");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
    "-subj", "/CN=sontop-dev",
    "-addext", `subjectAltName=${san}`,
    "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

const server = useTls ? https.createServer(ensureCert(), handler) : http.createServer(handler);

server.listen(port, () => {
  const scheme = useTls ? "https" : "http";
  console.log(`\n  ${scheme}://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`  ${scheme}://${ip}:${port}   ← 같은 와이파이의 폰에서`);
  if (!useTls) console.log("\n  폰에서 테스트하려면 --https 로 실행하세요 (카메라는 보안 컨텍스트 필요).");
  console.log("");
});
