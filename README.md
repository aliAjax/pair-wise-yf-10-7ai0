# 舞台幕布调度 API

零依赖 Node.js 服务（仅用内置模块 `http` / `fs` / `crypto`），管理演出登记、幕布编号、切换时长与安全复核。数据以原子写入方式保存在本地 JSON 文件，重启后保留。

## 启动

```bash
npm start                    # 默认 PORT=3019，数据文件 data/db.json
PORT=8080 MAX_BATCH_DURATION_SEC=900 DATA_FILE=/data/curtain.json node server.js
npm test                     # node:test 内置测试（含跨进程重启持久化）
```

## 业务规则

- **登记**：每条记录包含演出编号、幕布编号、切换时长（正整数秒）与安全复核（`reviewer` 必填），初始状态为 `pending`（待复核）。
- **唯一性**：同一演出 + 同一幕布，同一时刻只能有一条 `pending` 记录；放行（`approved`）后可再次登记。
- **批量原子性**：任一条缺少安全复核、引用不存在、幕布已停用、时长非法、与既有/批内记录构成待复核冲突，**或整批切换总时长超过上限**（默认 600 秒，`MAX_BATCH_DURATION_SEC` 可调），整批拒绝，返回全部错误项及其下标，**原数据不变**。
- **幕布停用**：该幕布所有 `pending` 记录自动转为 `cancelled`（记录 `cancelReason: curtain_deactivated`），`approved` 记录保留；停用幕布不再接受登记。
- **统计**：只计有效记录（`pending` + `approved`），取消记录不计入。
- **持久化**：每次写盘走「临时文件 + rename」原子替换；并发写操作串行化，保证批量「先全量校验、后统一提交」。数据文件损坏时自动改名备份（`db.json.corrupt-*`）后以空库启动，不静默销毁数据。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查、上限配置 |
| POST | `/performances` | 登记演出 `{id?, name}` |
| GET | `/performances` | 演出列表 |
| POST | `/curtains` | 登记幕布 `{id?, name}` |
| GET | `/curtains` | 幕布列表（含各幕待复核数） |
| POST | `/curtains/:id/deactivate` | 停用幕布，联动取消待复核记录 |
| POST | `/registrations` | 单条登记 |
| POST | `/registrations/batch` | 批量登记（原子，请求体为数组） |
| GET | `/registrations?performanceId=&curtainId=&status=` | 记录查询 |
| POST | `/registrations/:id/approve` | 放行 `{approver?}` |
| GET | `/stats?performanceId=&curtainId=` | 有效记录统计 |

成功响应统一为 `{ "data": ... }`；错误响应为：

```json
{ "error": { "code": "PENDING_RECORD_EXISTS", "message": "..." , "details": {} } }
```

主要错误码：`VALIDATION_ERROR`、`SAFETY_REVIEW_MISSING`、`BATCH_REJECTED`（含 `details.errors[]`，每项带 `index`）、`BATCH_DURATION_LIMIT_EXCEEDED`、`PENDING_RECORD_EXISTS`、`DUPLICATE_IN_BATCH`、`CURTAIN_INACTIVE`、`CURTAIN_NOT_ACTIVE`、`RECORD_CANCELLED`、`RECORD_ALREADY_APPROVED`、`*_NOT_FOUND` / `*_EXISTS`。

## 示例

```bash
curl -X POST http://127.0.0.1:3019/performances \
  -H 'Content-Type: application/json' -d '{"id":"night","name":"仲夏夜之梦"}'
curl -X POST http://127.0.0.1:3019/curtains \
  -H 'Content-Type: application/json' -d '{"id":"m1","name":"大幕"}'

curl -X POST http://127.0.0.1:3019/registrations/batch \
  -H 'Content-Type: application/json' \
  -d '[{"performanceId":"night","curtainId":"m1","durationSec":45,
        "safetyReview":{"reviewer":"安叔","note":"制动器、限位检查通过"}}]'

curl -X POST http://127.0.0.1:3019/registrations/rec_xxx/approve \
  -H 'Content-Type: application/json' -d '{"approver":"舞台监督"}'
curl -X POST http://127.0.0.1:3019/curtains/m1/deactivate
curl http://127.0.0.1:3019/stats
```

## 结构

- `store.js`：领域模型、校验、批量原子提交、文件持久化（可独立使用）
- `server.js`：HTTP 路由与错误码到状态码的映射
- `test/`：`store.test.js`（领域规则）、`http.test.js`（接口端到端）、`restart.test.js`（杀进程重启持久化）
