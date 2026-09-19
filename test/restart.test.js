"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");

function boot(dataFile, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SERVER],
      {
        env: { ...process.env, DATA_FILE: dataFile, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`启动超时\nstderr: ${stderr}`));
    }, 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.trim().split("\n").pop();
      try {
        const parsed = JSON.parse(line);
        if (parsed.msg === "stage-curtain-scheduler-api listening") {
          clearTimeout(timer);
          resolve({ child, parsed, stdout });
        }
      } catch {
        /* 等待下一行 */
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`服务异常退出 code=${code}\n${stderr}`));
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

test("跨进程重启：数据写入本地文件，重启后仍在", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curtain-restart-"));
  const dataFile = path.join(dir, "db.json");
  const port = 3100 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;

  // 第一次启动：登记 + 放行 + 停用幕布
  let { child } = await boot(dataFile, port);
  try {
    let res = await fetch(`${base}/performances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "p1", name: "歌剧魅影" })
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/curtains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "c1", name: "主幕" })
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        performanceId: "p1",
        curtainId: "c1",
        durationSec: 55,
        safetyReview: { reviewer: "安叔", note: "钢丝绳磨损在允许范围" }
      })
    });
    assert.equal(res.status, 201);
    const recordId = (await res.json()).data.id;

    res = await fetch(`${base}/registrations/${recordId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approver: "舞台监督" })
    });
    assert.equal(res.status, 200);
  } finally {
    await stop(child);
  }

  // 文件确实落在本地
  const onDisk = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(onDisk.registrations.length, 1);
  assert.equal(onDisk.registrations[0].status, "approved");

  // 第二次启动：数据仍可读，且唯一性规则仍然生效
  ({ child } = await boot(dataFile, port));
  try {
    let res = await fetch(`${base}/registrations?performanceId=p1`);
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].durationSec, 55);
    assert.equal(json.data[0].approver, "舞台监督");

    res = await fetch(`${base}/stats`);
    json = await res.json();
    assert.equal(json.data.counts.total, 1);
    assert.equal(json.data.counts.approved, 1);
    assert.equal(json.data.counts.approvedDurationSec, 55);
  } finally {
    await stop(child);
  }
});
