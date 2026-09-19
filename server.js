"use strict";

const http = require("http");
const { Store, DomainError, RECORD_STATUS } = require("./store");

const PORT = Number(process.env.PORT || 3019);
const DATA_FILE = process.env.DATA_FILE || `${__dirname}/data/db.json`;
const MAX_BATCH_DURATION_SEC = Number(process.env.MAX_BATCH_DURATION_SEC || 600);
const MAX_BODY_BYTES = 1024 * 1024;

const ALLOWED_STATUSES = new Set(Object.values(RECORD_STATUS));

const STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  SAFETY_REVIEW_MISSING: 400,
  EMPTY_BATCH: 400,
  INVALID_ITEM: 400,
  DUPLICATE_IN_BATCH: 400,
  BATCH_DURATION_LIMIT_EXCEEDED: 400,
  INVALID_JSON: 400,
  PERFORMANCE_EXISTS: 409,
  CURTAIN_EXISTS: 409,
  PENDING_RECORD_EXISTS: 409,
  RECORD_ALREADY_APPROVED: 409,
  RECORD_CANCELLED: 409,
  CURTAIN_NOT_ACTIVE: 409,
  CURTAIN_INACTIVE: 409,
  PERFORMANCE_NOT_FOUND: 404,
  CURTAIN_NOT_FOUND: 404,
  RECORD_NOT_FOUND: 404,
  BATCH_REJECTED: 400
};

const routes = [
  "GET  /health",
  "POST /performances",
  "GET  /performances",
  "POST /curtains",
  "GET  /curtains",
  "POST /curtains/:id/deactivate",
  "POST /registrations",
  "POST /registrations/batch",
  "GET  /registrations?performanceId=&curtainId=&status=",
  "POST /registrations/:id/approve",
  "GET  /stats?performanceId=&curtainId="
];

function statusFor(code) {
  if (Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code)) {
    return STATUS_BY_CODE[code];
  }
  return 400;
}

function errorBody(error) {
  const body = { error: { code: error.code || "INTERNAL_ERROR", message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;
  return body;
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      throw new DomainError("BODY_TOO_LARGE", "请求体超过 1MB 上限");
    }
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError("INVALID_JSON", "请求体必须是合法 JSON");
  }
}

/**
 * @param {import("./store").Store} store
 * @returns {import("http").Server}
 */
function createApp(store) {
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const { pathname, searchParams } = url;
    const method = req.method;
    const json = () => parseBody(req);
    const ok = (res, status, data) => send(res, status, { data });

    if (method === "GET" && pathname === "/health") {
      return ok(res, 200, {
        ok: true,
        service: "stage-curtain-scheduler-api",
        maxBatchDurationSec: store.maxBatchDurationSec,
        routes
      });
    }

    // ---------- 演出 ----------

    if (method === "POST" && pathname === "/performances") {
      return ok(res, 201, await store.createPerformance(await json()));
    }
    if (method === "GET" && pathname === "/performances") {
      return ok(res, 200, store.listPerformances());
    }

    // ---------- 幕布 ----------

    if (method === "POST" && pathname === "/curtains") {
      return ok(res, 201, await store.createCurtain(await json()));
    }
    if (method === "GET" && pathname === "/curtains") {
      return ok(res, 200, store.listCurtains());
    }
    const deactivateMatch = pathname.match(/^\/curtains\/([^/]+)\/deactivate$/);
    if (deactivateMatch) {
      if (method !== "POST") {
        throw new DomainError("METHOD_NOT_ALLOWED", `该接口仅支持 POST，收到 ${method}`);
      }
      await json();
      return ok(res, 200, await store.deactivateCurtain(deactivateMatch[1]));
    }

    // ---------- 登记 ----------

    if (method === "POST" && pathname === "/registrations") {
      return ok(res, 201, await store.registerOne(await json()));
    }
    if (method === "POST" && pathname === "/registrations/batch") {
      return ok(res, 201, await store.register(await json()));
    }
    if (method === "GET" && pathname === "/registrations") {
      const status = searchParams.get("status");
      if (status && !ALLOWED_STATUSES.has(status)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `status 必须是 ${[...ALLOWED_STATUSES].join(" / ")}`,
          { field: "status" }
        );
      }
      return ok(
        res,
        200,
        store.listRegistrations({
          performanceId: searchParams.get("performanceId") || undefined,
          curtainId: searchParams.get("curtainId") || undefined,
          status: status || undefined
        })
      );
    }
    const approveMatch = pathname.match(/^\/registrations\/([^/]+)\/approve$/);
    if (approveMatch) {
      if (method !== "POST") {
        throw new DomainError("METHOD_NOT_ALLOWED", `该接口仅支持 POST，收到 ${method}`);
      }
      return ok(res, 200, await store.approve(approveMatch[1], await json()));
    }

    // ---------- 统计 ----------

    if (method === "GET" && pathname === "/stats") {
      return ok(
        res,
        200,
        store.stats({
          performanceId: searchParams.get("performanceId") || undefined,
          curtainId: searchParams.get("curtainId") || undefined
        })
      );
    }

    throw new DomainError("NOT_FOUND", "接口不存在", { routes });
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof DomainError) {
        const status = error.code === "NOT_FOUND" ? 404 : statusFor(error.code);
        return send(res, status, errorBody(error));
      }
      // eslint-disable-next-line no-console
      console.error("[server]", error);
      send(res, 500, { error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
    });
  });
}

async function main() {
  const store = new Store({ file: DATA_FILE, maxBatchDurationSec: MAX_BATCH_DURATION_SEC });
  await store.init();
  const server = createApp(store);
  await new Promise((resolve) => server.listen(PORT, resolve));
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: "stage-curtain-scheduler-api listening",
      port: PORT,
      dataFile: DATA_FILE,
      maxBatchDurationSec: MAX_BATCH_DURATION_SEC
    })
  );

  const shutdown = (signal) => {
    server.close(() => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ msg: "shutting down", signal }));
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[fatal]", error);
    process.exit(1);
  });
}

module.exports = { createApp };
