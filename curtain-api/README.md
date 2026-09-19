# 舞台幕布调度 API

零依赖 Node.js 服务（仅使用内置模块 `http` / `fs` / `path` / `crypto`），用于登记**演出、幕布、幕布切换时长**并强制**安全复核**流程。数据写入本地 JSON 文件，重启后保留。

## 业务规则

1. **调度记录（record）** 关联一场演出与一块幕布，携带切换时长（正整数秒）。
2. 登记时若携带有效 `review`（复核人非空）→ 直接 **approved（已放行）**；否则进入 **pending（待复核）**。
3. **同一演出 + 同一幕布，最多只能有一条待复核记录**；重复登记返回 `409 pending_conflict`。已放行记录不占用该名额。
4. **批量登记是原子操作**：
   - 每条记录都必须携带安全复核，否则该条报 `review_required`；
   - 所有申报时长之和超过上限（默认 600 秒）报 `total_duration_exceeded`；
   - 只要存在任一不合规记录，**整批拒绝（HTTP 422），已有的数据完全不变**，响应中给出每条错误的下标。
5. **停用幕布**时：该幕布的待复核记录**自动取消**（`cancelled` / `curtain_deactivated`），已放行记录**保留**；停用后不能再为该幕布登记，重复停用幂等。
6. **统计只算有效记录**（不含已取消）；已放行记录即使其幕布后来停用仍保留并计入。
7. 持久化：写文件采用"临时文件 + `rename`"原子替换；进程内写操作经互斥锁串行化，批量不会被并发写撕裂。

## 启动

```bash
node server.js
# 可选环境变量
PORT=3020 DB_FILE=./data/db.json BATCH_TOTAL_LIMIT_SEC=600 node server.js
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查、上限配置、路由清单 |
| GET | `/performances` | 演出列表（含各状态计数） |
| POST | `/performances` | 登记演出 `{id?, name}` |
| GET | `/curtains` | 幕布列表 |
| POST | `/curtains` | 登记幕布 `{no, name?}` |
| POST | `/curtains/:no/deactivate` | 停用幕布（自动取消待复核，幂等） |
| GET | `/records?performanceId=&curtainNo=&status=` | 查询记录 |
| POST | `/records` | 单条登记 |
| POST | `/records/batch` | 批量登记（原子，全部需带复核） |
| POST | `/records/:id/review` | 安全复核放行 `{reviewer, note?}` |
| POST | `/records/:id/cancel` | 主动取消待复核 `{reason?}` |
| GET | `/stats?curtainActive=1` | 有效记录统计（总体/按幕布/按演出） |

记录状态：`pending`（待复核）→ `approved`（已放行）；`pending` → `cancelled`（已取消，终态）。

## 示例

```bash
# 1. 登记演出与幕布
curl -X POST localhost:3020/performances -H 'Content-Type: application/json' \
  -d '{"id":"show-1","name":"雷雨"}'
curl -X POST localhost:3020/curtains -H 'Content-Type: application/json' \
  -d '{"no":"M-1","name":"大幕"}'

# 2. 登记一条带安全复核的切换 -> 直接放行
curl -X POST localhost:3020/records -H 'Content-Type: application/json' -d '{
  "performanceId":"show-1","curtainNo":"M-1","durationSec":45,
  "review":{"reviewer":"王安全","note":"试运平稳"}
}'

# 3. 不带复核 -> pending；随后复核放行
curl -X POST localhost:3020/records -H 'Content-Type: application/json' \
  -d '{"performanceId":"show-1","curtainNo":"M-1","durationSec":30}'
curl -X POST localhost:3020/records/<id>/review -H 'Content-Type: application/json' \
  -d '{"reviewer":"李复核"}'

# 4. 批量登记：全部需要 review；任一缺失或总时长超限则整批 422、原数据不变
curl -X POST localhost:3020/records/batch -H 'Content-Type: application/json' -d '{
  "items":[
    {"performanceId":"show-1","curtainNo":"M-1","durationSec":60,"review":{"reviewer":"甲"}},
    {"performanceId":"show-1","curtainNo":"M-1","durationSec":90,"review":{"reviewer":"乙"}}
  ]
}'

# 5. 停用幕布：待复核自动取消，已放行保留
curl -X POST localhost:3020/curtains/M-1/deactivate

# 6. 统计（不含已取消记录）
curl localhost:3020/stats
```

## 测试

零依赖，使用 Node 内置测试运行器：

```bash
node --test test/
```

覆盖：唯一待复核约束、单条/批量登记、缺复核与超总时长的整批拒绝与回滚、
停用联动取消、已放行保留、统计口径、并发批量原子性以及重启持久化。

## 错误响应格式

```json
{
  "error": {
    "code": "batch_rejected",
    "message": "批量登记被拒绝：存在不合规记录",
    "details": {
      "errors": [
        {"index": 1, "code": "review_required", "message": "……"}
      ],
      "totalDurationSec": 630,
      "limitSec": 600
    }
  }
}
```
