'use strict';

const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const { Store, ApiError, DEFAULT_BATCH_TOTAL_LIMIT_SEC } = require('./store');

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, 'data', 'db.json');
const BATCH_TOTAL_LIMIT_SEC = Number(
  process.env.BATCH_TOTAL_LIMIT_SEC || DEFAULT_BATCH_TOTAL_LIMIT_SEC
);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const ROUTES = [
  'GET    /health',
  'GET    /performances',
  'POST   /performances',
  'GET    /curtains',
  'POST   /curtains',
  'POST   /curtains/:no/deactivate',
  'GET    /records',
  'POST   /records',
  'POST   /records/batch',
  'POST   /records/:id/review',
  'POST   /records/:id/cancel',
  'GET    /stats'
];

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function ok(res, status, data) {
  send(res, status, { data });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'body_too_large', '请求体超过 2 MiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ApiError(400, 'invalid_body', '请求体必须是 JSON 对象');
        }
        resolve(parsed);
      } catch (err) {
        if (err instanceof ApiError) return reject(err);
        reject(new ApiError(400, 'invalid_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(store) {
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;

    // GET /health
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      return ok(res, 200, {
        ok: true,
        service: 'curtain-schedule-api',
        dbFile: store.filePath,
        batchTotalLimitSec: store.batchTotalLimitSec,
        routes: ROUTES
      });
    }

    // /performances
    if (segments.length === 1 && segments[0] === 'performances') {
      if (method === 'GET') return ok(res, 200, store.listPerformances());
      if (method === 'POST') {
        const body = await readJsonBody(req);
        return ok(res, 201, await store.createPerformance(body));
      }
    }

    // /curtains
    if (segments.length === 1 && segments[0] === 'curtains') {
      if (method === 'GET') return ok(res, 200, store.listCurtains());
      if (method === 'POST') {
        const body = await readJsonBody(req);
        return ok(res, 201, await store.registerCurtain(body));
      }
    }

    // /curtains/:no/deactivate
    if (
      segments.length === 3 &&
      segments[0] === 'curtains' &&
      segments[2] === 'deactivate' &&
      method === 'POST'
    ) {
      const result = await store.deactivateCurtain(segments[1]);
      return ok(res, 200, result);
    }

    // /records
    if (segments.length === 1 && segments[0] === 'records') {
      if (method === 'GET') {
        return ok(
          res,
          200,
          store.listRecords({
            performanceId: url.searchParams.get('performanceId') || undefined,
            curtainNo: url.searchParams.get('curtainNo') || undefined,
            status: url.searchParams.get('status') || undefined
          })
        );
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        return ok(res, 201, await store.createRecord(body));
      }
    }

    // /records/batch（放在 :id 路由之前匹配）
    if (
      segments.length === 2 &&
      segments[0] === 'records' &&
      segments[1] === 'batch' &&
      method === 'POST'
    ) {
      const body = await readJsonBody(req);
      return ok(res, 201, await store.createRecordBatch(body));
    }

    // /records/:id/review | /records/:id/cancel
    if (segments.length === 3 && segments[0] === 'records') {
      if (segments[2] === 'review' && method === 'POST') {
        const body = await readJsonBody(req);
        return ok(res, 200, await store.reviewRecord(segments[1], body));
      }
      if (segments[2] === 'cancel' && method === 'POST') {
        const body = await readJsonBody(req);
        return ok(res, 200, await store.cancelRecord(segments[1], body));
      }
    }

    // /stats
    if (segments.length === 1 && segments[0] === 'stats' && method === 'GET') {
      return ok(
        res,
        200,
        store.stats({
          curtainActive: url.searchParams.get('curtainActive') === '1'
        })
      );
    }

    throw new ApiError(404, 'not_found', '接口不存在', { routes: ROUTES });
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ApiError) {
        return send(res, err.status, {
          error: { code: err.code, message: err.message, details: err.details }
        });
      }
      // eslint-disable-next-line no-console
      console.error(err);
      send(res, 500, { error: { code: 'internal_error', message: '服务器内部错误' } });
    });
  });
}

async function main() {
  const store = new Store(DB_FILE, { batchTotalLimitSec: BATCH_TOTAL_LIMIT_SEC });
  await store.load();
  const server = createServer(store);
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Curtain schedule API running at http://127.0.0.1:${PORT} (db: ${DB_FILE}, 批量总时长上限 ${BATCH_TOTAL_LIMIT_SEC}s)`
    );
  });
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer };
