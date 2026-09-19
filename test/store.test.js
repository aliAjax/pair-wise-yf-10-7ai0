"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("node:path");
const os = require("node:os");

const { Store, DomainError, RECORD_STATUS } = require("../store");

let counter = 0;
async function freshStore(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curtain-store-"));
  const file = path.join(dir, `db-${++counter}.json`);
  const store = new Store({
    file,
    maxBatchDurationSec: options.maxBatchDurationSec ?? 600,
    clock:
      options.clock ||
      (() => "2026-09-19T10:00:00.000Z")
  });
  await store.init();
  return { store, file, dir };
}

const review = (reviewer = "safeguard-A") => ({ reviewer, note: "机械与电气检查通过" });

async function seed(store) {
  const performance = await store.createPerformance({ id: "perf-1", name: "仲夏夜" });
  const curtain = await store.createCurtain({ id: "cur-1", name: "大幕" });
  const curtain2 = await store.createCurtain({ id: "cur-2", name: "二道幕" });
  return { performance, curtain, curtain2 };
}

test("基本登记：演出+幕布+切换时长+安全复核，初始为待复核", async () => {
  const { store } = await freshStore();
  await seed(store);
  const records = await store.register([
    {
      performanceId: "perf-1",
      curtainId: "cur-1",
      durationSec: 45,
      safetyReview: review()
    }
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, RECORD_STATUS.PENDING);
  assert.equal(records[0].durationSec, 45);
  assert.equal(records[0].safetyReview.reviewer, "safeguard-A");
});

test("同一演出同一幕布只能有一条待复核记录", async () => {
  const { store } = await freshStore();
  await seed(store);
  await store.registerOne({
    performanceId: "perf-1",
    curtainId: "cur-1",
    durationSec: 30,
    safetyReview: review()
  });
  await assert.rejects(
    () =>
      store.registerOne({
        performanceId: "perf-1",
        curtainId: "cur-1",
        durationSec: 20,
        safetyReview: review()
      }),
    (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "PENDING_RECORD_EXISTS");
      return true;
    }
  );
});

test("放行后同一演出同一幕布可再次登记", async () => {
  const { store } = await freshStore();
  await seed(store);
  const first = await store.registerOne({
    performanceId: "perf-1",
    curtainId: "cur-1",
    durationSec: 30,
    safetyReview: review()
  });
  await store.approve(first.id, { approver: "director-1" });
  const second = await store.registerOne({
    performanceId: "perf-1",
    curtainId: "cur-1",
    durationSec: 25,
    safetyReview: review()
  });
  assert.equal(second.status, RECORD_STATUS.PENDING);
  const approved = store
    .listRegistrations({ performanceId: "perf-1" })
    .filter((record) => record.status === RECORD_STATUS.APPROVED);
  assert.equal(approved.length, 1);
});

test("缺少安全复核 -> 拒绝（单条与批量均如此）", async () => {
  const { store } = await freshStore();
  await seed(store);
  await assert.rejects(
    () =>
      store.registerOne({
        performanceId: "perf-1",
        curtainId: "cur-1",
        durationSec: 30
      }),
    /SAFETY_REVIEW_MISSING|缺少安全复核/
  );
  await assert.rejects(
    () =>
      store.register([
        { performanceId: "perf-1", curtainId: "cur-1", durationSec: 10, safetyReview: review() },
        { performanceId: "perf-1", curtainId: "cur-2", durationSec: 10 }
      ]),
    (error) => {
      assert.equal(error.code, "BATCH_REJECTED");
      assert.deepEqual(
        error.details.errors.map((entry) => entry.code),
        ["SAFETY_REVIEW_MISSING"]
      );
      assert.equal(error.details.errors[0].index, 1);
      return true;
    }
  );
  // 整批拒绝，原数据不变
  assert.equal(store.listRegistrations().length, 0);
});

test("批量总时长超过上限 -> 整批拒绝且原数据不变", async () => {
  const { store } = await freshStore({ maxBatchDurationSec: 100 });
  await seed(store);
  await assert.rejects(
    () =>
      store.register([
        { performanceId: "perf-1", curtainId: "cur-1", durationSec: 60, safetyReview: review() },
        { performanceId: "perf-1", curtainId: "cur-2", durationSec: 60, safetyReview: review() }
      ]),
    (error) => {
      assert.equal(error.code, "BATCH_REJECTED");
      assert.ok(
        error.details.errors.some(
          (entry) => entry.code === "BATCH_DURATION_LIMIT_EXCEEDED"
        )
      );
      assert.equal(error.details.totalDurationSec, 120);
      return true;
    }
  );
  assert.equal(store.listRegistrations().length, 0);
});

test("批量恰好等于上限可以通过", async () => {
  const { store } = await freshStore({ maxBatchDurationSec: 100 });
  await seed(store);
  const records = await store.register([
    { performanceId: "perf-1", curtainId: "cur-1", durationSec: 40, safetyReview: review() },
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 60, safetyReview: review() }
  ]);
  assert.equal(records.length, 2);
});

test("批内同一演出同一幕布重复 -> 整批拒绝", async () => {
  const { store } = await freshStore();
  await seed(store);
  await assert.rejects(
    () =>
      store.register([
        { performanceId: "perf-1", curtainId: "cur-1", durationSec: 10, safetyReview: review() },
        { performanceId: "perf-1", curtainId: "cur-1", durationSec: 20, safetyReview: review() }
      ]),
    (error) => {
      assert.equal(error.details.errors[0].index, 1);
      assert.equal(error.details.errors[0].code, "DUPLICATE_IN_BATCH");
      return true;
    }
  );
});

test("非正整数时长 / 空数组 / 引用不存在 / 停用幕布登记 都被拒绝", async () => {
  const { store } = await freshStore();
  await seed(store);
  await store.deactivateCurtain("cur-2");

  await assert.rejects(() => store.register([]), (error) => {
    assert.equal(error.code, "BATCH_REJECTED");
    assert.equal(error.details.errors[0].code, "EMPTY_BATCH");
    return true;
  });

  await assert.rejects(
    () =>
      store.register([
        { performanceId: "perf-1", curtainId: "cur-1", durationSec: 0, safetyReview: review() }
      ]),
    (error) => {
      assert.equal(error.code, "BATCH_REJECTED");
      assert.equal(error.details.errors[0].code, "VALIDATION_ERROR");
      assert.equal(error.details.errors[0].field, "durationSec");
      return true;
    }
  );
  await assert.rejects(
    () =>
      store.register([
        { performanceId: "perf-x", curtainId: "cur-1", durationSec: 10, safetyReview: review() }
      ]),
    (error) => error.details.errors[0].code === "PERFORMANCE_NOT_FOUND"
  );
  await assert.rejects(
    () =>
      store.register([
        { performanceId: "perf-1", curtainId: "cur-2", durationSec: 10, safetyReview: review() }
      ]),
    (error) => error.details.errors[0].code === "CURTAIN_INACTIVE"
  );
});

test("停用幕布：待复核自动取消，已放行保留", async () => {
  const { store } = await freshStore();
  await seed(store);
  const [approvedRec] = await store.register([
    { performanceId: "perf-1", curtainId: "cur-1", durationSec: 10, safetyReview: review("r1") }
  ]);
  await store.approve(approvedRec.id, { approver: "boss" });
  // 放行后同一演出同一幕布可再登记一条待复核
  const pendingRec = await store.registerOne({
    performanceId: "perf-1",
    curtainId: "cur-1",
    durationSec: 20,
    safetyReview: review("r3")
  });
  const [otherRec] = await store.register([
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 10, safetyReview: review("r2") }
  ]);

  const result = await store.deactivateCurtain("cur-1");
  assert.deepEqual(result.cancelledRecordIds, [pendingRec.id]);

  const records = store.listRegistrations();
  const kept = records.find((item) => item.id === approvedRec.id);
  const cancelled = records.find((item) => item.id === pendingRec.id);
  const unaffected = records.find((item) => item.id === otherRec.id);
  assert.equal(kept.status, RECORD_STATUS.APPROVED);
  assert.equal(cancelled.status, RECORD_STATUS.CANCELLED);
  assert.equal(cancelled.cancelReason, "curtain_deactivated");
  assert.ok(cancelled.cancelledAt);
  assert.equal(unaffected.status, RECORD_STATUS.PENDING);
  // 重复停用报错
  await assert.rejects(() => store.deactivateCurtain("cur-1"), (error) => {
    assert.equal(error.code, "CURTAIN_NOT_ACTIVE");
    return true;
  });
});

test("已取消记录不能放行；重复放行报错", async () => {
  const { store } = await freshStore();
  await seed(store);
  const [record] = await store.register([
    { performanceId: "perf-1", curtainId: "cur-1", durationSec: 10, safetyReview: review() }
  ]);
  await store.deactivateCurtain("cur-1");
  await assert.rejects(() => store.approve(record.id), (error) => {
    assert.equal(error.code, "RECORD_CANCELLED");
    return true;
  });

  const [record2] = await store.register([
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 10, safetyReview: review() }
  ]);
  await store.approve(record2.id);
  await assert.rejects(() => store.approve(record2.id), (error) => {
    assert.equal(error.code, "RECORD_ALREADY_APPROVED");
    return true;
  });
});

test("统计只算有效记录（取消不计入）", async () => {
  const { store } = await freshStore();
  await seed(store);
  await store.register([
    { performanceId: "perf-1", curtainId: "cur-1", durationSec: 30, safetyReview: review() },
    { performanceId: "perf-1", curtainId: "cur-2", durationSec: 70, safetyReview: review() }
  ]);
  const pending = store.listRegistrations({ curtainId: "cur-1" })[0];
  await store.approve(pending.id, { approver: "boss" });
  await store.deactivateCurtain("cur-1"); // 已放行的保留
  const pendingOnly = store.listRegistrations({ curtainId: "cur-2" })[0];
  await store.deactivateCurtain("cur-2"); // 待复核自动取消

  const stats = store.stats();
  assert.equal(stats.counts.total, 1);
  assert.equal(stats.counts.approved, 1);
  assert.equal(stats.counts.pending, 0);
  assert.equal(stats.counts.totalDurationSec, 30);
  assert.equal(stats.counts.approvedDurationSec, 30);

  assert.equal(pendingOnly.status, RECORD_STATUS.CANCELLED);
});

test("重启后数据保留（同文件重新加载 Store）", async () => {
  const { store, file } = await freshStore();
  await seed(store);
  const [record] = await store.register([
    { performanceId: "perf-1", curtainId: "cur-1", durationSec: 30, safetyReview: review() }
  ]);
  await store.approve(record.id, { approver: "boss" });

  const reopened = new Store({ file });
  await reopened.init();
  const records = reopened.listRegistrations();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, RECORD_STATUS.APPROVED);
  assert.equal(records[0].approver, "boss");
  assert.equal(reopened.listCurtains()[0].id, "cur-1");

  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(raw.registrations[0].id, record.id);
});

test("损坏数据文件自动备份并以空库启动，不覆盖原文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "curtain-corrupt-"));
  const file = path.join(dir, "db.json");
  await fs.writeFile(file, "{ not json");
  const store = new Store({ file });
  await store.init();
  assert.equal(store.listRegistrations().length, 0);
  const files = await fs.readdir(dir);
  assert.ok(files.some((name) => name.startsWith("db.json.corrupt-")));
});
