# Runbook：Runtime Image 拉取部分失败的定位与恢复（#724）

> as-built。拉取走受治理的 task / adoption / readiness / 审计，不以手动 `podman pull` / `docker pull` 作为标准恢复方式。

## 1. 查看 pull-status 的 per-item 结果

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$SCHEDULER/runtime-images/registry/pull-status" | jq .
```

关注字段：

- `total` / `succeeded` / `failed` / `completed`
- `items[]`：`image_key`、`image_ref`、`target_digest`、`status`、`failure_class`、`error`、`attempts`、`retry_count`、`timeout_budget_sec`

计数描述一次实际准备操作：首次 pull 成功为 `attempts=1, retry_count=0`；失败后第二次成功为 `2/1`；已经本地可用、不执行 pull 为 `0/0`。`timeout_budget_sec` 是最后一次 pull 的预算，无 pull 时为 `0`。并发等待同一 in-flight 操作的调用者共享该操作结果，不会额外拉取；不能把各观察者的计数相加当作全局 pull 次数。pull 返回成功后若精确 digest 校验失败，仍保留已消耗的次数及预算并报告 `digest_missing`。

示例：13 项里仅 1 项失败 → `total=13, succeeded=12, failed=1`，并保留失败项原因。

## 2. 确认失败项、目标 digest 与执行节点，定向重拉

失败分类：

| `failure_class` | 是否可自动重试 | 处理 |
| --- | --- | --- |
| `timeout` / `transport` | 是（统一预算内最多 1 次） | 定向重拉同一 digest |
| `auth` | 否 | 检查 registry 凭据后重拉 |
| `digest_missing` | 否 | 核对清单/通道，勿漂移到 latest |
| `disk_full` | 否 | 先清理磁盘 / GC，再重拉 |
| `other` | 否 | 按错误原文排查 |

定向重拉（digest 不变，成功项无需重拉）：

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"items":[{"image_key":"deepsonar-base","image_ref":"ghcr.io/...@sha256:..."}]}' \
  "$SCHEDULER/runtime-images/registry/pull"
```

也可只按 `image_keys` 拉当前通道最新不可变版本（可能与失败时 digest 不同，慎用）：

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"image_keys":["deepsonar-base"]}' \
  "$SCHEDULER/runtime-images/registry/pull"
```

Web 市场页在拉取失败后提供「仅重拉失败项」按钮，等价于按失败项的 `image_ref` 定向恢复。

## 3. 按执行节点对账（含 Job 冻结旧 digest）

```bash
# 只读对账
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' "$SCHEDULER/runtime-images/registry/reconcile"

# 对本地缺失的需要版本发起受治理修复拉取
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"repair":true}' "$SCHEDULER/runtime-images/registry/reconcile"
```

说明：

- 对账集合 = 各产品最新 trusted + 项目 pin + 受保护 Job 冻结的旧 digest。
- 本地节点会做 detect（只读）；`repair` 走定向 pull task，不是手动 pull。
- Scheduler 从已有受信 `worker_nodes` 注册表枚举所有远端 worker，包括 stale / unavailable 节点；注册表读取失败会使对账失败，不静默伪装成没有远端节点。
- 当前远端 image inspect / repair 平面**尚未实现**。每个已注册远端节点返回 `inspect: "unsupported"`，`items=[]` / `missing=[]` 表示未检测，不能理解为镜像齐全。这里不会访问远端 endpoint、传送凭据或以 Scheduler 宿主状态冒充该节点。
- `repair:true` 只修复 Scheduler 本地缺失版本；`repair_task` 成功不代表远端已就绪。远端逐节点镜像检测及受治理拉取仍需后续实现。

## 4. 复核 readiness

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$SCHEDULER/runtime-images/registry" | jq '.image_status'
```

对应本地 `image_key` 的 `readiness` 应为 `ready`。仍不满足时按 `failure_class` 继续处理。这个结果不能证明 `inspect: "unsupported"` 的远端 worker 已就绪。

## 超时与环境变量

- 自动估算：按 `size_bytes` 与历史有效下载速度，**至少 300s**，上限 **3600s**；缺元数据时用 300s。
- 覆盖：`DEEPSONAR_RUNTIME_IMAGE_PULL_TIMEOUT_SEC`（整数秒，合法范围 60..7200）。非法值会告警并回退自动估算。
- 统一重试预算：每个镜像最多 2 次 pull（首次 + 一次重试）；同 digest 通道兜底占用该重试名额，不叠内外层重试。
