"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { Store, RECORD_STATUS } = require("../store");
const { createApp } = require("../server");

async function startServer(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curtain-http-"));
  const file = path.join(dir, "db.json");
  const store = new Store({
    file,
    maxBatchDurationSec: options.maxBatchDurationSec ?? 100
  });
  await store.init();
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, server, store, file };
}

async function request(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  return { status: response.status, json };
}

test("HTTP 端到端：登记 -> 重复拒绝 -> 批量原子拒绝 -> 停用联动 -> 统计", async (t) => {
  const { base, server } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // health
  let res = await request(base, "GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.data.ok, true);

  // 演出与幕布
  res = await request(base, "POST", "/performances", { id: "perf-1", name: "仲夏夜" });
  assert.equal(res.status, 201);
  res = await request(base, "POST", "/curtains", { id: "cur-1", name: "大幕" });
  assert.equal(res.status, 201);
  res = await request(base, "POST", "/curtains", { id: "cur-2", name: "二道幕" });
  assert.equal(res.status, 201);

  const good = {
    performanceId: "perf-1",
    curtainId: "cur-1",
    durationSec: 40,
    safetyReview: { reviewer: "safe-A", note: "制动器正常" }
  };

  // 单条登记成功
  res = await request(base, "POST", "/registrations", good);
  assert.equal(res.status, 201);
  const recordId = res.json.data.id;
  assert.equal(res.json.data.status, RECORD_STATUS.PENDING);

  // 同一演出同一幕布再次待复核 -> 409
  res = await request(base, "POST", "/registrations", good);
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "PENDING_RECORD_EXISTS");

  // 缺复核 -> 400
  res = await request(base, "POST", "/registrations", {
    performanceId: "perf-1",
    curtainId: "cur-2",
    durationSec: 30
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "SAFETY_REVIEW_MISSING");

  // 批量：一条缺复核，整批拒绝，cur-2 不应留下数据
  res = await request(base, "POST", "/registrations/batch", [
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 30, safetyReview: { reviewer: "a" } },
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 30 }
  ]);
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "BATCH_REJECTED");
  assert.equal(res.json.error.details.errors[0].index, 1);

  // 总时长超上限（上限 100）-> 整批拒绝
  res = await request(base, "POST", "/registrations/batch", [
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 60, safetyReview: { reviewer: "a" } },
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 60, safetyReview: { reviewer: "b" } }
  ]);
  assert.equal(res.status, 400);
  assert.equal(
    res.json.error.details.errors.at(-1).code,
    "BATCH_DURATION_LIMIT_EXCEEDED"
  );

  // 合法批量成功（cur-2 上两条不同幕布？这里只能 cur-2 一条；再建 cur-3）
  res = await request(base, "POST", "/curtains", { id: "cur-3", name: "天幕" });
  assert.equal(res.status, 201);
  res = await request(base, "POST", "/registrations/batch", [
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 30, safetyReview: { reviewer: "a" } },
    { performanceId: "perf-1", curtainId: "cur-3", durationSec: 60, safetyReview: { reviewer: "b" } }
  ]);
  assert.equal(res.status, 201);
  assert.equal(res.json.data.length, 2);

  // 放行
  res = await request(base, "POST", `/registrations/${recordId}/approve`, { approver: "导演" });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, RECORD_STATUS.APPROVED);
  res = await request(base, "POST", `/registrations/${recordId}/approve`, {});
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "RECORD_ALREADY_APPROVED");

  // 停用 cur-2：其待复核记录自动取消
  res = await request(base, "POST", "/curtains/cur-2/deactivate", {});
  assert.equal(res.status, 200);
  assert.equal(res.json.data.cancelledRecordIds.length, 1);

  // 停用幕布上不能再登记
  res = await request(base, "POST", "/registrations", {
    performanceId: "perf-1",
    curtainId: "cur-2",
    durationSec: 10,
    safetyReview: { reviewer: "a" }
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "CURTAIN_INACTIVE");

  // 过滤查询
  res = await request(base, "GET", "/registrations?status=cancelled");
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 1);

  // 统计：有效记录 = 已放行(cur-1,40s) + 待复核(cur-3,60s)；cur-2 已取消不计
  res = await request(base, "GET", "/stats");
  assert.equal(res.status, 200);
  const { counts } = res.json.data;
  assert.equal(counts.total, 2);
  assert.equal(counts.pending, 1);
  assert.equal(counts.approved, 1);
  assert.equal(counts.totalDurationSec, 100);
  assert.equal(counts.pendingDurationSec, 60);
  assert.equal(counts.approvedDurationSec, 40);
});

test("HTTP 错误处理：非法 JSON、未知路由、错误的方法", async (t) => {
  const { base, server } = await startServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let response = await fetch(`${base}/registrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad json"
  });
  let json = await response.json();
  assert.equal(response.status, 400);
  assert.equal(json.error.code, "INVALID_JSON");

  response = await fetch(`${base}/nope`);
  json = await response.json();
  assert.equal(response.status, 404);
  assert.equal(json.error.code, "NOT_FOUND");

  response = await fetch(`${base}/curtains/cur-1/deactivate`, { method: "GET" });
  json = await response.json();
  assert.equal(response.status, 400);
  assert.equal(json.error.code, "METHOD_NOT_ALLOWED");
});
