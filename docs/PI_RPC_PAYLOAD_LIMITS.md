# Pi RPC 大载荷链路（#944）

本文件记录 Pi RPC 通道在传输大载荷时的三条失败路径、对应修复与仍待外部依赖的部分。
状态：接收侧已交付；发送侧（分片产出）属于外部 Pi CLI，本仓库不控制。

## 症状与定位

| 错误码 | 触发位置 | 修复 |
| --- | --- | --- |
| `PI_RPC_MESSAGE_TOO_LARGE` | `pi-jsonl-framer.ts`（单行超 `limit`）与 `runtime-adapters.ts` 的 `parsePiJsonlRecord` | 硬上限抬到 256 MiB；新增分片重组路径 |
| `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE` | `pi-rpc-output.ts`（投影后仍超内联上限） | 改为 `__ref` 引用传递 |
| `PI_RPC_INPUT_UNACKNOWLEDGED` | `pi-rpc-driver.ts`（首次未 ACK 即终止） | 同字节重传 3 次后仍失败才终止 |

## 1. 帧层上限与分片

- `PI_RPC_HARD_MAX_BYTES` 由 64 MiB 抬到 **256 MiB**，仅作绝对保护。
- 单事件上限仍默认 **8 MiB**，可用 `DEEPSONAR_PI_RPC_MAX_EVENT_BYTES` 覆盖，可设区间为 1 MiB–256 MiB（超出区间回落默认）。
- 新增帧类型 `{type:"chunk", id, seq, total, data}`：`data` 为 base64 分片，默认片大小 4 MiB。
- 接收侧 `PiRpcChunkAssembler` 按 `id` 聚合，收齐 `total` 后按 `seq` 顺序拼接并交给原有派发路径；不完整分组超过 30s 即丢弃并报 `PI_RPC_CHUNK_INCOMPLETE`。
- 边界保护：单组最大 256 MiB、最多 8 个并发未完成分组、最多 4096 片；重复片若字节相同则忽略，字节不同报 `PI_RPC_CHUNK_DUPLICATE_CONFLICT`；`total` 前后不一致报 `PI_RPC_CHUNK_TOTAL_MISMATCH`。

灰度：分片重组由 `DEEPSONAR_PI_RPC_CHUNKING` 控制，**默认关闭**。关闭时线上帧格式与行为完全不变。

## 2. 大结构改引用传递

脱敏后的预览仍超过 `PI_RPC_INLINE_BYTES`（1 MiB）时，不再抛 `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE`，而是：

1. 先把完整脱敏 JSON 写入 `/workspace/.deepsonar-rpc-output/` 与 Attempt 留存目录（沿用既有捕获机制，仍受 128 个文件 / 128 MiB 运行级预算约束）；
2. 返回 `{type:"runtime.rpc_reference", __ref, sha256, bytes, evidence_path, event_type, original_bytes, redacted:true}`；
3. 调用方按 `__ref` 读取完整内容。

捕获写入失败、预算耗尽、缺少 archive 时仍然 fail closed，绝不返回引用。

## 3. 输入确认重传

- 发送帧保持单调 `id`；未在 `timeoutMs` 内收到 ACK 时，用**完全相同的字节与 id** 重传，最多 3 次，退避为 `timeoutMs * 2^n`（上限 4 倍）。
- 只有 3 次重传后仍未确认才终止，报 `PI_RPC_ACK_TIMEOUT: <command>`（原为首次超时即终止）。
- 接收侧按 id 去重：已确认 id 的迟到重复回包被忽略（最近 256 个 id），不再误判 `PI_RPC_RESPONSE_ID_MISMATCH`。

## 未交付 / 边界

- **分片的产出方是外部 Pi CLI**。本仓库交付的是接收侧能力与灰度开关；在 CLI 开始发送 `chunk` 帧之前，`>8 MiB` 的单事件仍需靠提高 `DEEPSONAR_PI_RPC_MAX_EVENT_BYTES` 规避。
- 未做 80 MiB 端到端集成样本与「生产两周归零」观测；issue 的验收要求真实运行数据，本次不宣称。
- 分片重组会额外占用内存（上限受 256 MiB 硬顶约束），大载荷仍需结合 `runtime_knobs` 的实际取值观察。
