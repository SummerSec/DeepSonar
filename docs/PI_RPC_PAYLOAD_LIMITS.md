# Pi RPC 大载荷链路（#944）

> #992 文档路由验证：修改本页说明不构成 RPC 实现验收；本验证分支不改变运行时、开关或限制。

本文件记录 Pi RPC 通道在传输大载荷时的三条失败路径、对应修复与仍待外部依赖的部分。
状态：接收侧已交付；发送侧（分片产出）属于外部 Pi CLI，本仓库不控制。

## 症状与定位

| 错误码 | 触发位置 | 修复 |
| --- | --- | --- |
| `PI_RPC_MESSAGE_TOO_LARGE` | `pi-jsonl-framer.ts`（单行超 `limit`）与 `runtime-adapters.ts` 的 `parsePiJsonlRecord` | 硬上限抬到 256 MiB；新增分片重组路径 |
| `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE` | `pi-rpc-output.ts`（投影后仍超内联上限） | 保留事件与控制字段，仅把超大子树换成 `$piRef` 指针；无法保留时仍 fail closed |
| `PI_RPC_INPUT_UNACKNOWLEDGED` | `pi-rpc-driver.ts`（首次未 ACK 即终止） | 只读命令同字节重传 3 次；`prompt` 保持首次超时即终止 |

## 1. 帧层上限与分片

- `PI_RPC_HARD_MAX_BYTES` 由 64 MiB 抬到 **256 MiB**，仅作绝对保护。
- 单事件上限仍默认 **8 MiB**，可用 `DEEPSONAR_PI_RPC_MAX_EVENT_BYTES` 覆盖，可设区间为 1 MiB–256 MiB（超出区间回落默认）。
- 新增帧类型 `{type:"chunk", id, seq, total, data}`：`data` 为 base64 分片，默认片大小 4 MiB。
- 接收侧 `PiRpcChunkAssembler` 按 `id` 聚合，收齐 `total` 后按 `seq` 顺序拼接并交给原有派发路径；不完整分组超过 30s 即丢弃并报 `PI_RPC_CHUNK_INCOMPLETE`。
- 该 30s 是**真实定时器**，不依赖下一条帧：流保持打开但不再输出时，`onExpire` 会终止进程并把 `PI_RPC_CHUNK_INCOMPLETE` 记进 Attempt 的失败原因。注入自定义 `now()` 时（单测手动推进时钟）默认不启动定时器，改由 `sweep()` 驱动。
- 边界保护：单组最大 256 MiB、最多 8 个并发未完成分组、最多 4096 片；重复片若字节相同则忽略，字节不同报 `PI_RPC_CHUNK_DUPLICATE_CONFLICT`；`total` 前后不一致报 `PI_RPC_CHUNK_TOTAL_MISMATCH`。

灰度：分片重组由 `DEEPSONAR_PI_RPC_CHUNKING` 控制，**默认关闭**。关闭时线上帧格式与行为完全不变。

## 2. 大结构改为字段级指针

脱敏后的预览仍超过 `PI_RPC_INLINE_BYTES`（1 MiB）时，**不替换整个事件**。把事件整体换成裸引用会让驱动器匹配不到 `response` 的 `id`、让 `decodePi` 只看到 `unknown_runtime`，工具开始事件与 `message_end` 的 `stopReason` 都会静默消失。

实际做法：

1. 先把完整脱敏 JSON 写入 `/workspace/.deepsonar-rpc-output/` 与 Attempt 留存目录（沿用既有捕获机制，仍受 128 个文件 / 128 MiB 运行级预算约束）；
2. 保留 `type` 与全部控制字段（`id`、`command`、`success`、`disposition`、`toolCallId`、`toolName`、`isError`、`message.role`、`stopReason` 等）；
3. **只替换超长的叶子字符串**，容器类型一律不动：`message.content` 必须仍是数组（`piMessageText` 按数组读正文），`args` / `result` 必须仍是对象。替换形式为
   `{"$piRef": <path>, "pointer": "/args/script", "sha256": ..., "bytes": ...}`；
4. 数组在预览阶段按 `PI_RPC_PREVIEW_MAX_ELEMENTS`（128）截断，并追加 `{type:"truncated", omitted:N}` 标记（该标记没有 `text` 字段，`piMessageText` 会跳过）。这样「几百个小文本块」的超大 `message_end` 会保留有界正文前缀，而不是把整个 `content` 换成指针导致正文丢失；
5. 同时发出 `runtime.diagnostic` / `pi_rpc_payload_referenced`，带 `pointer_count` 与前 16 个 `pointers`，消费端据此按指针读取；
6. 若某条事件在保留控制字段与容器类型的前提下**无法**压到内联上限，仍然 fail closed 抛 `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE`，并在诊断里标明 `capture_complete: true`（归档本身是成功的）。

捕获写入失败、预算耗尽、缺少 archive 时仍然 fail closed，绝不返回指针。

## 3. 输入确认重传（仅只读命令）

固定的 Pi 1.4.0 对每个 `prompt` 帧都调用 `session.prompt`，**不按请求 id 去重**，`id` 只用于关联响应。因此重发 `prompt` 可能让同一轮模型调用与工具副作用执行两次。

- 只有 `RETRYABLE_COMMANDS`（当前仅 `get_state`）允许重传：未在 `timeoutMs` 内收到 ACK 时，用**完全相同的字节与 id** 重传，最多 3 次，退避为 `timeoutMs * 2^n`（上限 4 倍）。
- `prompt` 不重传，首次 ACK/start 超时即终止，报 `PI_RPC_ACK_TIMEOUT: prompt` 或 `PI_RPC_START_TIMEOUT`。这也消除了「先注册的 start 截止时间会先杀掉进程、让承诺的重传一次都跑不到」的冲突。
- 接收侧按 id 去重：已确认 id 的迟到重复回包被忽略（最近 256 个 id），不再误判 `PI_RPC_RESPONSE_ID_MISMATCH`；未知 id 仍然拒绝。

## 未交付 / 边界

- **分片的产出方是外部 Pi CLI**。本仓库交付的是接收侧能力与灰度开关；在 CLI 开始发送 `chunk` 帧之前，`>8 MiB` 的单事件仍需靠提高 `DEEPSONAR_PI_RPC_MAX_EVENT_BYTES` 规避。
- 未做 80 MiB 端到端集成样本与「生产两周归零」观测；issue 的验收要求真实运行数据，本次不宣称。
- 分片重组会额外占用内存（上限受 256 MiB 硬顶约束），大载荷仍需结合 `runtime_knobs` 的实际取值观察。
- 字段级指针的消费端（Scheduler）目前把 `$piRef` 当作普通对象保存，尚未提供「按指针回读」的 API；完整内容始终在 Attempt 留存里可取。
