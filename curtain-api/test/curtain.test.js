'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const { Store, DEFAULT_BATCH_TOTAL_LIMIT_SEC } = require('../store');
const { createServer } = require('../server');

function tmpDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curtain-api-'));
  return path.join(dir, 'db.json');
}

function startServer(dbFile, batchLimit) {
  const store = new Store(dbFile, {
    batchTotalLimitSec: batchLimit != null ? batchLimit : DEFAULT_BATCH_TOTAL_LIMIT_SEC
  });
  return store.load().then(
    () =>
      new Promise((resolve) => {
        const server = createServer(store);
        server.listen(0, '127.0.0.1', () => resolve({ server, store, port: server.address().port }));
      })
  );
}

function api(port, method, urlPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const options = {
    method,
    host: '127.0.0.1',
    port,
    path: urlPath,
    headers: { 'Content-Type': 'application/json' }
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const json = raw ? JSON.parse(raw) : null;
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function seed(port) {
  await api(port, 'POST', '/performances', { id: 'p1', name: '雷雨之夜' });
  await api(port, 'POST', '/performances', { id: 'p2', name: '天鹅湖' });
  await api(port, 'POST', '/curtains', { no: 'C-01', name: '大幕' });
  await api(port, 'POST', '/curtains', { no: 'C-02', name: '二幕' });
}

test('健康检查与基本登记', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile);
  try {
    const health = await api(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.ok, true);

    await seed(port);
    const curtains = await api(port, 'GET', '/curtains');
    assert.equal(curtains.body.data.length, 2);
    assert.equal(curtains.body.data[0].active, true);

    // 重复幕布编号
    const dup = await api(port, 'POST', '/curtains', { no: 'C-01' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'curtain_exists');
  } finally {
    server.close();
  }
});

test('无复核登记进入待复核，同演出同幕布只允许一条待复核', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile);
  try {
    await seed(port);

    const r1 = await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 30
    });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.data.status, 'pending');
    assert.equal(r1.body.data.review, null);

    // 再来一条待复核 => 409
    const r2 = await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 20
    });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error.code, 'pending_conflict');

    // 复核放行
    const reviewed = await api(port, 'POST', `/records/${r1.body.data.id}/review`, {
      reviewer: '王安全',
      note: '限位正常'
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.data.status, 'approved');
    assert.equal(reviewed.body.data.review.reviewer, '王安全');

    // 放行后允许再次登记待复核（同一演出同一幕布可有多条已放行记录）
    const r3 = await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 15
    });
    assert.equal(r3.status, 201);
    assert.equal(r3.body.data.status, 'pending');

    // 已放行记录不能重复复核
    const again = await api(port, 'POST', `/records/${r1.body.data.id}/review`, {
      reviewer: '李复核'
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'not_pending');

    // 非法时长
    const bad = await api(port, 'POST', '/records', {
      performanceId: 'p2',
      curtainNo: 'C-02',
      durationSec: 0
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_duration');
  } finally {
    server.close();
  }
});

test('携带复核登记直接放行', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile);
  try {
    await seed(port);
    const r = await api(port, 'POST', '/records', {
      performanceId: 'p2',
      curtainNo: 'C-02',
      durationSec: 45,
      review: { reviewer: '张工', note: '试运平稳' }
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.status, 'approved');
    assert.equal(r.body.data.reviewedAt !== null, true);
  } finally {
    server.close();
  }
});

test('批量登记成功：全部携带复核且总时长不超限', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile, 100);
  try {
    await seed(port);
    const res = await api(port, 'POST', '/records/batch', {
      items: [
        { performanceId: 'p1', curtainNo: 'C-01', durationSec: 30, review: { reviewer: '甲' } },
        { performanceId: 'p2', curtainNo: 'C-02', durationSec: 60, review: { reviewer: '乙' } }
      ]
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.count, 2);
    assert.equal(res.body.data.totalDurationSec, 90);
    assert.ok(res.body.data.created.every((r) => r.status === 'approved'));

    const list = await api(port, 'GET', '/records');
    assert.equal(list.body.data.length, 2);
  } finally {
    server.close();
  }
});

test('批量登记：任一缺复核整批拒绝且原数据不变', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile);
  try {
    await seed(port);
    const before = await api(port, 'GET', '/records');
    assert.equal(before.body.data.length, 0);

    const res = await api(port, 'POST', '/records/batch', {
      items: [
        { performanceId: 'p1', curtainNo: 'C-01', durationSec: 10, review: { reviewer: '甲' } },
        { performanceId: 'p2', curtainNo: 'C-02', durationSec: 20 } // 缺复核
      ]
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'batch_rejected');
    assert.equal(res.body.error.details.errors.length, 1);
    assert.equal(res.body.error.details.errors[0].index, 1);
    assert.equal(res.body.error.details.errors[0].code, 'review_required');

    const after = await api(port, 'GET', '/records');
    assert.equal(after.body.data.length, 0, '被拒绝的批量不应写入任何记录');
  } finally {
    server.close();
  }
});

test('批量登记：总时长超限整批拒绝，即使所有单项都合法', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile, 100);
  try {
    await seed(port);
    const res = await api(port, 'POST', '/records/batch', {
      items: [
        { performanceId: 'p1', curtainNo: 'C-01', durationSec: 60, review: { reviewer: '甲' } },
        { performanceId: 'p2', curtainNo: 'C-02', durationSec: 50, review: { reviewer: '乙' } }
      ]
    });
    assert.equal(res.status, 422);
    const errors = res.body.error.details.errors;
    assert.ok(errors.some((e) => e.code === 'total_duration_exceeded'));
    assert.equal(res.body.error.details.totalDurationSec, 110);
    assert.equal(res.body.error.details.limitSec, 100);

    const after = await api(port, 'GET', '/records');
    assert.equal(after.body.data.length, 0);
  } finally {
    server.close();
  }
});

test('批量登记：缺复核与超时长同时存在时错误全部返回，仍不写入', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile, 30);
  try {
    await seed(port);
    const res = await api(port, 'POST', '/records/batch', {
      items: [
        { performanceId: 'p1', curtainNo: 'C-01', durationSec: 20, review: { reviewer: '甲' } },
        { performanceId: 'p2', curtainNo: 'C-02', durationSec: 20 } // 缺复核
      ]
    });
    assert.equal(res.status, 422);
    const codes = res.body.error.details.errors.map((e) => e.code).sort();
    assert.deepEqual(codes, ['review_required', 'total_duration_exceeded']);
  } finally {
    server.close();
  }
});

test('停用幕布：待复核自动取消、已放行保留，停用后不能再登记，重复停用幂等', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile);
  try {
    await seed(port);

    // C-01 一条已放行 + 一条待复核
    const approved = await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 10,
      review: { reviewer: '甲' }
    });
    const pending = await api(port, 'POST', '/records', {
      performanceId: 'p2',
      curtainNo: 'C-01',
      durationSec: 20
    });
    assert.equal(pending.body.data.status, 'pending');

    const deact = await api(port, 'POST', '/curtains/C-01/deactivate', {});
    assert.equal(deact.status, 200);
    assert.equal(deact.body.data.curtain.active, false);
    assert.deepEqual(deact.body.data.cancelledRecordIds, [pending.body.data.id]);

    // 待复核已取消，已放行仍在
    const list = await api(port, 'GET', '/records?curtainNo=C-01');
    const byId = Object.fromEntries(list.body.data.map((r) => [r.id, r]));
    assert.equal(byId[pending.body.data.id].status, 'cancelled');
    assert.equal(byId[pending.body.data.id].cancelReason, 'curtain_deactivated');
    assert.equal(byId[approved.body.data.id].status, 'approved');

    // 停用幕布不能再登记
    const denied = await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 5
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'curtain_inactive');

    // 重复停用幂等，不再取消任何记录
    const again = await api(port, 'POST', '/curtains/C-01/deactivate', {});
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.data.cancelledRecordIds, []);

    // 已取消记录不能复核
    const reviewCancelled = await api(port, 'POST', `/records/${pending.body.data.id}/review`, {
      reviewer: '甲'
    });
    assert.equal(reviewCancelled.status, 409);
  } finally {
    server.close();
  }
});

test('统计只算有效记录（取消不计，已放行保留计入）', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile);
  try {
    await seed(port);
    await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 100,
      review: { reviewer: '甲' }
    });
    const p = await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 40
    });
    await api(port, 'POST', '/records', {
      performanceId: 'p2',
      curtainNo: 'C-02',
      durationSec: 200,
      review: { reviewer: '乙' }
    });
    await api(port, 'POST', '/curtains/C-01/deactivate', {});

    const stats = await api(port, 'GET', '/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.body.data.total, 2, '取消的待复核记录不计入');
    assert.equal(stats.body.data.approved, 2);
    assert.equal(stats.body.data.pending, 0);
    assert.equal(stats.body.data.cancelledExcluded, 1);
    assert.equal(stats.body.data.approvedDurationSec, 300);
    // 已放行记录即使其幕布已停用仍保留并计入
    assert.equal(stats.body.data.byCurtain['C-01'].approved, 1);
    assert.equal(stats.body.data.byPerformance['p1'].approved, 1);

    // p 的取消状态确认
    const rec = await api(port, 'GET', `/records?performanceId=p1`);
    const cancelled = rec.body.data.find((r) => r.id === p.body.data.id);
    assert.equal(cancelled.status, 'cancelled');
  } finally {
    server.close();
  }
});

test('引用不存在的演出 / 幕布返回 404，错误路由返回 404', async () => {
  const dbFile = tmpDbFile();
  const { server, port } = await startServer(dbFile);
  try {
    await seed(port);
    const noPerf = await api(port, 'POST', '/records', {
      performanceId: 'nope',
      curtainNo: 'C-01',
      durationSec: 10
    });
    assert.equal(noPerf.status, 404);
    assert.equal(noPerf.body.error.code, 'performance_not_found');

    const noCurtain = await api(port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'NOPE',
      durationSec: 10
    });
    assert.equal(noCurtain.status, 404);

    const notFound = await api(port, 'GET', '/nope');
    assert.equal(notFound.status, 404);

    const badJson = await new Promise((resolve) => {
      const req = http.request(
        { method: 'POST', host: '127.0.0.1', port, path: '/performances', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }
      );
      req.end('{not json');
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'invalid_json');
  } finally {
    server.close();
  }
});

test('重启后数据保留', async () => {
  const dbFile = tmpDbFile();
  const s1 = await startServer(dbFile);
  try {
    await seed(s1.port);
    await api(s1.port, 'POST', '/records', {
      performanceId: 'p1',
      curtainNo: 'C-01',
      durationSec: 12,
      review: { reviewer: '甲' }
    });
    const pending = await api(s1.port, 'POST', '/records', {
      performanceId: 'p2',
      curtainNo: 'C-02',
      durationSec: 34
    });
    assert.equal(pending.body.data.status, 'pending');
  } finally {
    s1.server.close();
  }

  // 用同一个数据文件启动新实例
  const s2 = await startServer(dbFile);
  try {
    const performances = await api(s2.port, 'GET', '/performances');
    assert.equal(performances.body.data.length, 2);
    const records = await api(s2.port, 'GET', '/records');
    assert.equal(records.body.data.length, 2);
    const statuses = records.body.data.map((r) => r.status).sort();
    assert.deepEqual(statuses, ['approved', 'pending']);

    const stats = await api(s2.port, 'GET', '/stats');
    assert.equal(stats.body.data.total, 2);
    assert.equal(stats.body.data.pendingDurationSec, 34);
  } finally {
    s2.server.close();
  }
});

test('Store 层：并发批量登记不会互相破坏原子性', async () => {
  const dbFile = tmpDbFile();
  const store = new Store(dbFile, { batchTotalLimitSec: 1000 });
  await store.load();
  await store.createPerformance({ id: 'p1', name: 'p' });
  for (const no of ['C-01', 'C-02', 'C-03']) {
    await store.registerCurtain({ no });
  }

  const batchA = store.createRecordBatch({
    items: [
      { performanceId: 'p1', curtainNo: 'C-01', durationSec: 100, review: { reviewer: 'a' } },
      { performanceId: 'p1', curtainNo: 'C-02', durationSec: 100, review: { reviewer: 'a' } }
    ]
  });
  const batchB = store
    .createRecordBatch({
      items: [
        { performanceId: 'p1', curtainNo: 'C-03', durationSec: 100, review: { reviewer: 'b' } }
      ]
    })
    .catch((e) => e);

  const [resultA, resultB] = await Promise.all([batchA, batchB]);
  assert.equal(resultA.count, 2);
  assert.equal(resultB.count, 1);
  assert.equal(store.state.records.length, 3);

  // 文件中也是完整 JSON
  const onDisk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.equal(onDisk.records.length, 3);
});
