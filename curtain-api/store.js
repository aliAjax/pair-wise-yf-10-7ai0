'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_BATCH_TOTAL_LIMIT_SEC = 10 * 60; // 批量登记总时长上限：10 分钟
const MAX_ITEM_DURATION_SEC = 24 * 60 * 60; // 单条切换时长的合理性上限

class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function emptyState() {
  return { version: 1, curtains: [], performances: [], records: [] };
}

// 简单的异步互斥锁：所有写操作串行化，保证批量登记的原子性
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    // 等待链不因单个任务失败而中断
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

class Store {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.batchTotalLimitSec =
      options.batchTotalLimitSec != null
        ? options.batchTotalLimitSec
        : DEFAULT_BATCH_TOTAL_LIMIT_SEC;
    this.state = emptyState();
    this._withLock = createMutex();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        version: parsed.version || 1,
        curtains: Array.isArray(parsed.curtains) ? parsed.curtains : [],
        performances: Array.isArray(parsed.performances) ? parsed.performances : [],
        records: Array.isArray(parsed.records) ? parsed.records : []
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this._persist(this.state);
    }
    return this.state;
  }

  // 原子写入：先写临时文件再 rename，避免进程崩溃导致数据文件半写
  async _persist(state = this.state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  async _mutate(fn) {
    return this._withLock(async () => {
      const result = await fn(this.state);
      await this._persist();
      return result;
    });
  }

  // ---------- 查询 ----------

  listPerformances() {
    return this.state.performances.map((p) => this._decoratePerformance(p));
  }

  listCurtains() {
    return [...this.state.curtains];
  }

  getPerformance(id) {
    return this.state.performances.find((p) => p.id === id) || null;
  }

  getCurtain(no) {
    return this.state.curtains.find((c) => c.no === no) || null;
  }

  listRecords(filter = {}) {
    return this.state.records
      .filter(
        (r) =>
          (!filter.performanceId || r.performanceId === filter.performanceId) &&
          (!filter.curtainNo || r.curtainNo === filter.curtainNo) &&
          (!filter.status || r.status === filter.status)
      )
      .map((r) => this._decorateRecord(r));
  }

  getRecord(id) {
    const r = this.state.records.find((item) => item.id === id);
    return r ? this._decorateRecord(r) : null;
  }

  _decoratePerformance(p) {
    const records = this.state.records.filter((r) => r.performanceId === p.id);
    return {
      ...p,
      pendingCount: records.filter((r) => r.status === 'pending').length,
      approvedCount: records.filter((r) => r.status === 'approved').length,
      cancelledCount: records.filter((r) => r.status === 'cancelled').length
    };
  }

  _decorateRecord(r) {
    const curtain = this.getCurtain(r.curtainNo);
    return { ...r, curtainActive: curtain ? curtain.active : false };
  }

  // ---------- 演出 / 幕布 ----------

  async createPerformance(input = {}) {
    return this._mutate(() => {
      const id = normalizeId(input.id, 'perf', '演出ID');
      const name = requireString(input.name, 'name', '演出名称', 100);
      if (this.state.performances.some((p) => p.id === id)) {
        throw new ApiError(409, 'performance_exists', `演出 ${id} 已存在`);
      }
      const performance = { id, name, createdAt: nowIso() };
      this.state.performances.push(performance);
      return performance;
    });
  }

  async registerCurtain(input = {}) {
    return this._mutate(() => {
      const no = requireCode(input.no, 'no', '幕布编号');
      const name = optionalString(input.name, 'name', '幕布名称', 100) || '';
      if (this.state.curtains.some((c) => c.no === no)) {
        throw new ApiError(409, 'curtain_exists', `幕布 ${no} 已登记`);
      }
      const curtain = { no, name, active: true, createdAt: nowIso(), deactivatedAt: null };
      this.state.curtains.push(curtain);
      return curtain;
    });
  }

  // 停用幕布：待复核记录自动取消，已放行记录保留。幂等。
  async deactivateCurtain(no) {
    return this._mutate(() => {
      const curtain = this.state.curtains.find((c) => c.no === no);
      if (!curtain) throw new ApiError(404, 'curtain_not_found', `幕布 ${no} 不存在`);

      const cancelledRecordIds = [];
      if (curtain.active) {
        const at = nowIso();
        curtain.active = false;
        curtain.deactivatedAt = at;
        for (const r of this.state.records) {
          if (r.curtainNo === no && r.status === 'pending') {
            r.status = 'cancelled';
            r.cancelledAt = at;
            r.cancelReason = 'curtain_deactivated';
            cancelledRecordIds.push(r.id);
          }
        }
      }
      return { curtain, cancelledRecordIds };
    });
  }

  // ---------- 调度记录 ----------

  // 单条登记：携带有效安全复核即放行，否则进入待复核
  async createRecord(input) {
    return this._mutate(() => {
      const draft = this._prepareRecord(input, this.state);
      this.state.records.push(draft);
      return draft;
    });
  }

  // 批量登记：任一记录缺复核 / 校验失败 / 总时长超上限 => 整批拒绝，原数据不变
  async createRecordBatch(input) {
    if (!input || !Array.isArray(input.items)) {
      throw new ApiError(400, 'invalid_body', '请求体需要包含 items 数组');
    }
    if (input.items.length === 0) {
      throw new ApiError(400, 'empty_batch', '批量登记至少包含一条记录');
    }

    return this._mutate(() => {
      const errors = [];
      const drafts = [];
      let totalDurationSec = 0;

      input.items.forEach((item, index) => {
        try {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new ApiError(400, 'invalid_record', '记录必须是对象');
          }
          // 时长独立校验并计入总时长：即使该条因缺复核被拒，
          // 整批申报的总时长仍要参与上限判断
          const durationSec = requireDuration(item.durationSec);
          totalDurationSec += durationSec;
          const draft = this._prepareRecord(item, this.state, { reviewRequired: true });
          drafts.push(draft);
        } catch (err) {
          if (err instanceof ApiError) {
            errors.push({ index, code: err.code, message: err.message });
          } else {
            throw err;
          }
        }
      });

      if (totalDurationSec > this.batchTotalLimitSec) {
        errors.push({
          index: null,
          code: 'total_duration_exceeded',
          message: `批量切换总时长 ${totalDurationSec}s 超过上限 ${this.batchTotalLimitSec}s`,
          totalDurationSec,
          limitSec: this.batchTotalLimitSec
        });
      }

      if (errors.length > 0) {
        // 尚未写入任何记录、尚未持久化，原数据保持不变
        throw new ApiError(422, 'batch_rejected', '批量登记被拒绝：存在不合规记录', {
          errors,
          totalDurationSec,
          limitSec: this.batchTotalLimitSec
        });
      }

      this.state.records.push(...drafts);
      return {
        created: drafts,
        count: drafts.length,
        totalDurationSec
      };
    });
  }

  // 构造并完整校验一条记录（不修改 state），供单条与批量复用
  _prepareRecord(input, state, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ApiError(400, 'invalid_record', '记录必须是对象');
    }
    const performanceId = requireString(input.performanceId, 'performanceId', '演出ID', 64);
    const curtainNo = requireCode(input.curtainNo, 'curtainNo', '幕布编号');

    const performance = state.performances.find((p) => p.id === performanceId);
    if (!performance) {
      throw new ApiError(404, 'performance_not_found', `演出 ${performanceId} 不存在`);
    }
    const curtain = state.curtains.find((c) => c.no === curtainNo);
    if (!curtain) {
      throw new ApiError(404, 'curtain_not_found', `幕布 ${curtainNo} 不存在`);
    }
    if (!curtain.active) {
      throw new ApiError(409, 'curtain_inactive', `幕布 ${curtainNo} 已停用，不能登记`);
    }

    const durationSec = requireDuration(input.durationSec);
    const review = parseReview(input.review, options.reviewRequired === true);

    // 同一演出同一幕布只能有一条待复核记录
    const conflict = state.records.find(
      (r) =>
        r.performanceId === performanceId &&
        r.curtainNo === curtainNo &&
        r.status === 'pending'
    );
    if (conflict) {
      throw new ApiError(
        409,
        'pending_conflict',
        `演出 ${performanceId} 的幕布 ${curtainNo} 已存在待复核记录 ${conflict.id}`
      );
    }

    const at = nowIso();
    return {
      id: makeId('rec'),
      performanceId,
      curtainNo,
      durationSec,
      status: review ? 'approved' : 'pending',
      review: review
        ? { reviewer: review.reviewer, note: review.note, at }
        : null,
      note: optionalString(input.note, 'note', '备注', 200) || '',
      createdAt: at,
      reviewedAt: review ? at : null,
      cancelledAt: null,
      cancelReason: null
    };
  }

  // 对待复核记录进行安全复核并放行
  async reviewRecord(id, input = {}) {
    return this._mutate(() => {
      const record = state_record(this.state, id);
      if (record.status !== 'pending') {
        throw new ApiError(
          409,
          'not_pending',
          `记录 ${id} 当前状态为 ${record.status}，不能复核`
        );
      }
      const reviewer = requireString(
        input.reviewer,
        'reviewer',
        '复核人',
        64
      );
      const note = optionalString(input.note, 'note', '复核备注', 200) || '';
      const at = nowIso();
      record.status = 'approved';
      record.review = { reviewer, note, at };
      record.reviewedAt = at;
      return record;
    });
  }

  // 主动取消待复核记录（已放行记录不可取消）
  async cancelRecord(id, input = {}) {
    return this._mutate(() => {
      const record = state_record(this.state, id);
      if (record.status !== 'pending') {
        throw new ApiError(
          409,
          'not_pending',
          `记录 ${id} 当前状态为 ${record.status}，不能取消`
        );
      }
      const at = nowIso();
      record.status = 'cancelled';
      record.cancelledAt = at;
      record.cancelReason = 'manual';
      record.cancelNote = optionalString(input.reason, 'reason', '取消原因', 200) || '';
      return record;
    });
  }

  // ---------- 统计 ----------

  // 只统计有效记录（status !== cancelled）；已放行记录即使幕布后停用也保留计入
  stats(filter = {}) {
    const cancelledCount = this.state.records.filter((r) => r.status === 'cancelled').length;
    let visible = this.state.records.filter((r) => r.status !== 'cancelled');
    let inactiveCurtainExcluded = 0;
    if (filter.curtainActive) {
      const before = visible.length;
      visible = visible.filter((r) => {
        const c = this.getCurtain(r.curtainNo);
        return c && c.active;
      });
      inactiveCurtainExcluded = before - visible.length;
    }

    const summary = (list) => ({
      total: list.length,
      pending: list.filter((r) => r.status === 'pending').length,
      approved: list.filter((r) => r.status === 'approved').length,
      pendingDurationSec: list
        .filter((r) => r.status === 'pending')
        .reduce((sum, r) => sum + r.durationSec, 0),
      approvedDurationSec: list
        .filter((r) => r.status === 'approved')
        .reduce((sum, r) => sum + r.durationSec, 0)
    });

    const groupBy = (list, key) => {
      const map = {};
      for (const r of list) {
        const k = r[key];
        if (!map[k]) map[k] = [];
        map[k].push(r);
      }
      const out = {};
      for (const [k, list] of Object.entries(map)) out[k] = summary(list);
      return out;
    };

    return {
      generatedAt: nowIso(),
      cancelledExcluded: cancelledCount,
      inactiveCurtainExcluded,
      ...summary(visible),
      totalDurationSec: visible.reduce((sum, r) => sum + r.durationSec, 0),
      byCurtain: groupBy(visible, 'curtainNo'),
      byPerformance: groupBy(visible, 'performanceId')
    };
  }
}

function state_record(state, id) {
  const record = state.records.find((r) => r.id === id);
  if (!record) throw new ApiError(404, 'record_not_found', `调度记录 ${id} 不存在`);
  return record;
}

// ---------- 输入校验 ----------

function requireString(value, field, label, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'missing_field', `${label}（${field}）不能为空`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ApiError(400, 'field_too_long', `${label}（${field}）长度不能超过 ${max}`);
  }
  return trimmed;
}

function optionalString(value, field, label, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_field', `${label}（${field}）必须是字符串`);
  }
  if (value.length > max) {
    throw new ApiError(400, 'field_too_long', `${label}（${field}）长度不能超过 ${max}`);
  }
  return value.trim();
}

function requireCode(value, field, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'missing_field', `${label}（${field}）不能为空`);
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(trimmed)) {
    throw new ApiError(
      400,
      'invalid_code',
      `${label}（${field}）只能包含字母、数字、下划线和连字符，长度 1-32`
    );
  }
  return trimmed;
}

function normalizeId(value, prefix, label) {
  if (value === undefined || value === null || value === '') {
    return makeId(prefix);
  }
  return requireCode(value, 'id', label);
}

function requireDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(400, 'invalid_duration', '切换时长 durationSec 必须是数字（秒）');
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, 'invalid_duration', '切换时长 durationSec 必须是正整数秒');
  }
  if (value > MAX_ITEM_DURATION_SEC) {
    throw new ApiError(
      400,
      'invalid_duration',
      `单条切换时长不能超过 ${MAX_ITEM_DURATION_SEC}s`
    );
  }
  return value;
}

function parseReview(value, required) {
  if (value === undefined || value === null) {
    if (required) {
      throw new ApiError(422, 'review_required', '批量登记的每条记录都必须包含安全复核 review');
    }
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_review', '安全复核 review 必须是对象');
  }
  const reviewer = requireString(value.reviewer, 'reviewer', '复核人', 64);
  const note = optionalString(value.note, 'note', '复核备注', 200) || '';
  return { reviewer, note };
}

module.exports = {
  Store,
  ApiError,
  DEFAULT_BATCH_TOTAL_LIMIT_SEC,
  MAX_ITEM_DURATION_SEC
};
