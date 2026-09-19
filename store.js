"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

/**
 * 领域错误：code 供 HTTP 层映射状态码，details 承载批量校验等结构化信息。
 */
class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const RECORD_STATUS = Object.freeze({
  PENDING: "pending", // 待复核（待放行）
  APPROVED: "approved", // 已放行
  CANCELLED: "cancelled" // 已取消（幕布停用联动）
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function defaultClock() {
  return new Date().toISOString();
}

function emptyData() {
  return { performances: [], curtains: [], registrations: [] };
}

function isValidShape(parsed) {
  return (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.performances) &&
    Array.isArray(parsed.curtains) &&
    Array.isArray(parsed.registrations)
  );
}

async function loadOrInit(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyData();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!isValidShape(parsed)) throw new Error("数据结构不符合预期");
  } catch {
    // 不静默销毁损坏数据：改名备份后以空库启动
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(file, backup);
    } catch {
      /* 备份失败也继续启动空库 */
    }
    console.warn(`[store] 数据文件损坏，已备份到 ${backup}，以空库启动`);
    return emptyData();
  }
  return parsed;
}

class Store {
  /**
   * @param {object} options
   * @param {string} options.file 本地 JSON 数据文件路径
   * @param {number} [options.maxBatchDurationSec=600] 单批切换总时长上限（秒）
   * @param {() => string} [options.clock] 可注入时钟，便于测试
   */
  constructor(options = {}) {
    if (!isNonEmptyString(options.file)) throw new Error("Store 需要 file 数据文件路径");
    this.file = options.file;
    this.maxBatchDurationSec = Number.isFinite(options.maxBatchDurationSec)
      ? options.maxBatchDurationSec
      : 600;
    this.clock = options.clock || defaultClock;
    this.data = emptyData();
    // 所有写操作串行化，保证并发登记下“先全部校验、后统一提交”的原子性
    this.writeQueue = Promise.resolve();
    this.tmpSeq = 0;
  }

  async init() {
    this.data = await loadOrInit(this.file);
    await this.persist();
  }

  // ---- 写操作串行化：校验与提交在同一个串行任务内完成 ----
  enqueueWrite(task) {
    const result = this.writeQueue.then(() => task());
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  // 临时文件 + rename，崩溃时不会留下写了一半的 db.json
  async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${++this.tmpSeq}`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
    await fs.rename(tmp, this.file);
  }

  // ---------- 演出 ----------

  async createPerformance(input = {}) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) {
      throw new DomainError("VALIDATION_ERROR", "演出名称 name 不能为空", { field: "name" });
    }
    if (input.id !== undefined && !isNonEmptyString(input.id)) {
      throw new DomainError("VALIDATION_ERROR", "演出 id 必须是非空字符串", { field: "id" });
    }
    return this.enqueueWrite(async () => {
      const id = isNonEmptyString(input.id) ? input.id.trim() : `perf_${crypto.randomUUID()}`;
      if (this.data.performances.some((item) => item.id === id)) {
        throw new DomainError("PERFORMANCE_EXISTS", `演出 ${id} 已存在`, { conflictId: id });
      }
      const performance = { id, name, createdAt: this.clock() };
      this.data.performances.push(performance);
      await this.persist();
      return performance;
    });
  }

  listPerformances() {
    return this.data.performances.slice();
  }

  // ---------- 幕布 ----------

  async createCurtain(input = {}) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) {
      throw new DomainError("VALIDATION_ERROR", "幕布名称 name 不能为空", { field: "name" });
    }
    if (input.id !== undefined && !isNonEmptyString(input.id)) {
      throw new DomainError("VALIDATION_ERROR", "幕布编号 id 必须是非空字符串", { field: "id" });
    }
    return this.enqueueWrite(async () => {
      const id = isNonEmptyString(input.id) ? input.id.trim() : `cur_${crypto.randomUUID()}`;
      if (this.data.curtains.some((item) => item.id === id)) {
        throw new DomainError("CURTAIN_EXISTS", `幕布 ${id} 已存在`, { conflictId: id });
      }
      const curtain = {
        id,
        name,
        active: true,
        createdAt: this.clock(),
        deactivatedAt: null
      };
      this.data.curtains.push(curtain);
      await this.persist();
      return curtain;
    });
  }

  listCurtains() {
    return this.data.curtains.map((curtain) => ({
      ...curtain,
      pendingCount: this.data.registrations.filter(
        (record) => record.curtainId === curtain.id && record.status === RECORD_STATUS.PENDING
      ).length
    }));
  }

  /**
   * 停用幕布：其全部待复核记录自动取消，已放行记录保留。
   */
  async deactivateCurtain(id) {
    return this.enqueueWrite(async () => {
      const curtain = this.data.curtains.find((item) => item.id === id);
      if (!curtain) {
        throw new DomainError("CURTAIN_NOT_FOUND", `幕布 ${id} 不存在`);
      }
      if (!curtain.active) {
        throw new DomainError("CURTAIN_NOT_ACTIVE", `幕布 ${id} 已处于停用状态`);
      }
      curtain.active = false;
      curtain.deactivatedAt = this.clock();
      const cancelledRecordIds = [];
      for (const record of this.data.registrations) {
        if (record.curtainId === id && record.status === RECORD_STATUS.PENDING) {
          record.status = RECORD_STATUS.CANCELLED;
          record.cancelledAt = this.clock();
          record.cancelReason = "curtain_deactivated";
          cancelledRecordIds.push(record.id);
        }
      }
      await this.persist();
      return { curtain, cancelledRecordIds };
    });
  }

  // ---------- 登记 ----------

  /**
   * 批量登记（原子）：
   * 1) 任一条缺少安全复核 / 引用不存在 / 幕布已停用 / 时长非法 /
   *    同一演出同一幕布存在待复核记录（含本批内重复）-> 整批拒绝；
   * 2) 本批切换时长合计超过 maxBatchDurationSec -> 整批拒绝。
   * 任何一项不满足都不写入，原数据不变。
   */
  async register(rawItems) {
    return this.enqueueWrite(async () => {
      const errors = [];

      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw new DomainError("BATCH_REJECTED", "批量登记被拒绝，数据未改动", {
          totalDurationSec: 0,
          maxBatchDurationSec: this.maxBatchDurationSec,
          errors: [
            {
              code: "EMPTY_BATCH",
              message: "items 必须是非空数组"
            }
          ]
        });
      }

      const batchKeys = new Set();
      let totalDurationSec = 0;

      const pushError = (index, code, message, extra) => {
        errors.push({ index, code, message, ...(extra || {}) });
      };

      rawItems.forEach((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          pushError(index, "INVALID_ITEM", "登记项必须是对象");
          return;
        }

        const performanceId = isNonEmptyString(item.performanceId)
          ? item.performanceId.trim()
          : "";
        const curtainId = isNonEmptyString(item.curtainId) ? item.curtainId.trim() : "";

        if (!performanceId) {
          pushError(index, "VALIDATION_ERROR", "缺少演出编号 performanceId", {
            field: "performanceId"
          });
        } else if (!this.data.performances.some((perf) => perf.id === performanceId)) {
          pushError(index, "PERFORMANCE_NOT_FOUND", `演出 ${performanceId} 不存在`);
        }

        if (!curtainId) {
          pushError(index, "VALIDATION_ERROR", "缺少幕布编号 curtainId", {
            field: "curtainId"
          });
        } else {
          const curtain = this.data.curtains.find((entry) => entry.id === curtainId);
          if (!curtain) {
            pushError(index, "CURTAIN_NOT_FOUND", `幕布 ${curtainId} 不存在`);
          } else if (!curtain.active) {
            pushError(index, "CURTAIN_INACTIVE", `幕布 ${curtainId} 已停用，不能登记`);
          }
        }

        if (!Number.isInteger(item.durationSec) || item.durationSec <= 0) {
          pushError(index, "VALIDATION_ERROR", "切换时长 durationSec 必须是正整数（秒）", {
            field: "durationSec"
          });
        } else {
          totalDurationSec += item.durationSec;
        }

        const review = item.safetyReview;
        if (
          !review ||
          typeof review !== "object" ||
          Array.isArray(review) ||
          !isNonEmptyString(review.reviewer)
        ) {
          pushError(
            index,
            "SAFETY_REVIEW_MISSING",
            "缺少安全复核：safetyReview.reviewer 必填",
            { field: "safetyReview.reviewer" }
          );
        }

        if (performanceId && curtainId) {
          const key = `${performanceId}|${curtainId}`;
          const hasPending = this.data.registrations.some(
            (record) =>
              record.performanceId === performanceId &&
              record.curtainId === curtainId &&
              record.status === RECORD_STATUS.PENDING
          );
          if (hasPending) {
            pushError(
              index,
              "PENDING_RECORD_EXISTS",
              "同一演出同一幕布只能有一条待复核记录"
            );
          } else if (batchKeys.has(key)) {
            pushError(index, "DUPLICATE_IN_BATCH", "本批内同一演出同一幕布重复登记");
          } else {
            batchKeys.add(key);
          }
        }
      });

      if (totalDurationSec > this.maxBatchDurationSec) {
        errors.push({
          code: "BATCH_DURATION_LIMIT_EXCEEDED",
          message: `本批切换总时长 ${totalDurationSec} 秒超过上限 ${this.maxBatchDurationSec} 秒`,
          totalDurationSec,
          maxBatchDurationSec: this.maxBatchDurationSec
        });
      }

      if (errors.length > 0) {
        throw new DomainError("BATCH_REJECTED", "批量登记被拒绝，数据未改动", {
          totalDurationSec,
          maxBatchDurationSec: this.maxBatchDurationSec,
          errors
        });
      }

      const createdAt = this.clock();
      const created = rawItems.map((item) => ({
        id: `rec_${crypto.randomUUID()}`,
        performanceId: item.performanceId.trim(),
        curtainId: item.curtainId.trim(),
        durationSec: item.durationSec,
        safetyReview: {
          reviewer: item.safetyReview.reviewer.trim(),
          note: isNonEmptyString(item.safetyReview.note) ? item.safetyReview.note.trim() : "",
          passedAt: isNonEmptyString(item.safetyReview.passedAt)
            ? item.safetyReview.passedAt
            : createdAt
        },
        status: RECORD_STATUS.PENDING,
        createdAt,
        approver: null,
        approvedAt: null,
        cancelledAt: null,
        cancelReason: null
      }));

      this.data.registrations.push(...created);
      await this.persist();
      return created;
    });
  }

  /** 单条登记复用批量原子逻辑，错误解包为第一条具体错误 */
  async registerOne(input) {
    let records;
    try {
      records = await this.register([input]);
    } catch (error) {
      if (error.code === "BATCH_REJECTED") {
        const first = error.details.errors[0];
        throw new DomainError(first.code, first.message, {
          ...first,
          totalDurationSec: error.details.totalDurationSec,
          maxBatchDurationSec: error.details.maxBatchDurationSec
        });
      }
      throw error;
    }
    return records[0];
  }

  /** 放行：待复核 -> 已放行 */
  async approve(recordId, input = {}) {
    return this.enqueueWrite(async () => {
      const record = this.data.registrations.find((item) => item.id === recordId);
      if (!record) {
        throw new DomainError("RECORD_NOT_FOUND", `记录 ${recordId} 不存在`);
      }
      if (record.status === RECORD_STATUS.APPROVED) {
        throw new DomainError("RECORD_ALREADY_APPROVED", `记录 ${recordId} 已放行`);
      }
      if (record.status === RECORD_STATUS.CANCELLED) {
        throw new DomainError("RECORD_CANCELLED", `记录 ${recordId} 已取消，不能放行`);
      }
      record.status = RECORD_STATUS.APPROVED;
      record.approvedAt = this.clock();
      record.approver = isNonEmptyString(input.approver) ? input.approver.trim() : null;
      await this.persist();
      return record;
    });
  }

  listRegistrations(filter = {}) {
    return this.data.registrations.filter(
      (record) =>
        (!filter.performanceId || record.performanceId === filter.performanceId) &&
        (!filter.curtainId || record.curtainId === filter.curtainId) &&
        (!filter.status || record.status === filter.status)
    );
  }

  /**
   * 统计：只算有效记录（pending + approved），cancelled 不计入。
   */
  stats(filter = {}) {
    const valid = this.data.registrations.filter(
      (record) =>
        record.status !== RECORD_STATUS.CANCELLED &&
        (!filter.performanceId || record.performanceId === filter.performanceId) &&
        (!filter.curtainId || record.curtainId === filter.curtainId)
    );
    const pending = valid.filter((record) => record.status === RECORD_STATUS.PENDING);
    const approved = valid.filter((record) => record.status === RECORD_STATUS.APPROVED);
    const sumDuration = (list) => list.reduce((sum, record) => sum + record.durationSec, 0);
    return {
      filter: {
        performanceId: filter.performanceId || null,
        curtainId: filter.curtainId || null
      },
      counts: {
        total: valid.length,
        pending: pending.length,
        approved: approved.length,
        totalDurationSec: sumDuration(valid),
        pendingDurationSec: sumDuration(pending),
        approvedDurationSec: sumDuration(approved)
      }
    };
  }
}

module.exports = { Store, DomainError, RECORD_STATUS };
