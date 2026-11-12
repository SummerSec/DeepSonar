# Pi RPC 大载荷链路（#944 / #990）

> 状态：接收侧已交付；#990 完整归档关联、持久索引与按指针回读已接线，最终 SHA Actions 待验。发送侧分片、冻结 knobs 与真实 80 MiB E2E 未交付。
> 核对基线：2026-11-08（`pi-rpc-chunking.ts`、`pi-jsonl-framer.ts`、`pi-rpc-output.ts`、Scheduler `evidence.ts` / `runtime-evidence.ts`）。
>
> 本文出现的阈值（分片大小、单事件上限、硬上限、超时、预览上限、重试次数、有界预览条数）都是代码常量取值；常量变化时**以代码为准**并同步本文，不把这里的数字当作独立事实来源。

本文件记录 Pi RPC 通道在传输大载荷时的三条失败路径、对应修复与仍待外部依赖的部分。

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

1. 先把完整脱敏 JSON 写入 `/workspace/.deepsonar-rpc-output/` 与 Attempt 留存目录；Scheduler 串行提交文件及既有 Job evidence manifest 索引后才返回路径，不依赖运行结束的 `finalize`。同一 Attempt 的累计文件数/字节从持久索引读取，重建 writer 不重置预算，已有文件不覆盖；落盘但尚未索引的归档及中断的临时文件也有界计入预算，但不发布为可信引用。新归档与索引在返回前执行文件同步和 POSIX 新建目录链同步（Windows 为文件同步），finalize 替换同一索引时仍保留该持久写语义；归档拒绝不阻断后续失败诊断和 finalize。未 finalize 的索引读取仍合并既有有界 raw stream 扫描及重启 capture_error，不因提前索引而隐藏过程流；raw stream 保持 inflight / sha256=null。捕获侧运行预算与 Scheduler Attempt 预算均受代码上限约束；
2. 保留 `type` 与全部控制字段（`id`、`command`、`success`、`disposition`、`toolCallId`、`toolName`、`isError`、`message.role`、`stopReason` 等）；
3. **只替换超长的叶子字符串**，容器类型一律不动：`message.content` 必须仍是数组（`piMessageText` 按数组读正文），`args` / `result` 必须仍是对象。替换形式为
   `{"$piRef": <Attempt evidence path>, "pointer": "/args/script", "sha256": ..., "bytes": ...}`。引用中的 SHA 是完整脱敏归档 SHA，`bytes` 是叶子字符串 UTF-8 字节数；
4. 数组在预览阶段按 `PI_RPC_PREVIEW_MAX_ELEMENTS`（128）截断，并追加 `{type:"truncated", omitted:N}` 标记（该标记没有 `text` 字段，`piMessageText` 会跳过）。这样「几百个小文本块」的超大 `message_end` 会保留有界正文前缀，而不是把整个 `content` 换成指针导致正文丢失；
5. 每个大事件的预览根均附加 `"$piArchive": {"path": <Attempt evidence path>, "sha256": ..., "bytes": ...}`，包括已缩短的已知文本键和已截断数组；消费端用原 JSON Pointer 读取完整文本、数组或对象。根关联本身计入内联字节上限，原输入占用保留字段时明确拒绝。叶子替换另发 `pi_rpc_payload_referenced` 诊断，完整归档诊断保留 sandbox `path` 与独立 `evidence_path`；
6. 若某条事件在保留控制字段与容器类型的前提下**无法**压到内联上限，仍然 fail closed 抛 `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE`，并在诊断里标明 `capture_complete: true`（归档本身是成功的）。

捕获写入失败、预算耗尽、缺少 archive 时仍然 fail closed，绝不返回指针。

## 3. 持久归档回读（#990 切片）

Management API `GET /jobs/:id/evidence/runtime` 沿用 `tasks:read` 和现有项目鉴权；Job capability token 不因此获得管理读取权限，不新增 Control operation。必填 query 为 `path`、`attempt_id`、`sha256`；`pointer` 默认空字符串（整个事件），可选 `bytes` 校验选中值的实际字节数。只接受该 Job manifest 中精确 Attempt 的已登记 RPC 归档，不接受 workspace 路径、未登记文件或越界路径。

先核对源文件长度和 SHA，再对完整 JSON 执行共享 OM 脱敏及 RFC 6901 Pointer 选择。返回 `value` 保留完整字符串、数组或对象；字符串 `encoding=utf8`，其他 JSON 值 `encoding=json`。`source.sha256/source.bytes` 指不可变归档，顶层 `sha256/bytes` 指实际返回值，二者不可混用；历史归档若经 OM 读取投影发生变化，也不能用源叶子字节数冒充投影字节数。现有 Session artifact 列表/下载可读取已提交索引，不自动将大内容重新塞入模型输入。

读取按 [`runtime-evidence.ts`](../apps/scheduler/src/runtime-evidence.ts) 的固定源字节预算和进程内并发预算执行。超预算、忙、源 hash/字节冲突、非法或不存在 Pointer、归档缺损、本副本不可见均返回稳定 `PI_RPC_*` 错误，不返回预览冒充完整内容。此并发界限仅覆盖新回读入口，不是整个 Scheduler RSS、其他 Session download 或 SLA 的承诺。

注意力成本：沿用既有证据列表与下载，不新增开关、通知或自动拉取；需要完整内容时由调用方显式读取，错误保留具体原因。没有新 schema、账本、运行时通道或跨副本复制。

## 4. 输入确认重传（仅只读命令）

固定的 Pi 1.5.2（#1069）对每个 `prompt` 帧仍调用 `session.prompt`，**不按请求 id 去重**，`id` 只用于关联响应。因此重发 `prompt` 可能让同一轮模型调用与工具副作用执行两次。

- 只有 `RETRYABLE_COMMANDS`（当前仅 `get_state`）允许重传：未在 `timeoutMs` 内收到 ACK 时，用**完全相同的字节与 id** 重传，最多 3 次，退避为 `timeoutMs * 2^n`（上限 4 倍）。
- `prompt` 不重传，首次 ACK/start 超时即终止，报 `PI_RPC_ACK_TIMEOUT: prompt` 或 `PI_RPC_START_TIMEOUT`。这也消除了「先注册的 start 截止时间会先杀掉进程、让承诺的重传一次都跑不到」的冲突。
- 接收侧按 id 去重：已确认 id 的迟到重复回包被忽略（最近 256 个 id），不再误判 `PI_RPC_RESPONSE_ID_MISMATCH`；未知 id 仍然拒绝。

## 未交付 / 边界

- **分片的产出方是外部 Pi CLI**。本仓库交付的是接收侧能力与灰度开关；在 CLI 开始发送 `chunk` 帧之前，`>8 MiB` 的单事件仍需靠提高 `DEEPSONAR_PI_RPC_MAX_EVENT_BYTES` 规避。
- 未做 80 MiB 端到端集成样本与「生产两周归零」观测；issue 的验收要求真实运行数据，本次不宣称。
- 分片重组会额外占用内存（上限受 256 MiB 硬顶约束），大载荷仍需结合 `runtime_knobs` 的实际取值观察。
- 分片开关和分片字节数仍未进入 Job 冻结 knobs；本切片不改变快照、CLI 版本、发送协议或分片开关。
- #990 回读工程验收入口：`pnpm ci:unit:runtime-sandbox`、`pnpm ci:unit:recovery`、`pnpm ci:integration:authz-boundaries`，覆盖预览 → 持久归档 → HTTP → 完整值、重建 writer、源损坏、Pointer/字节/权限拒绝。所有测试仅在 Actions 执行，当前尚无本切片最终 SHA 结果；离线替身不等于真实 Pi CLI 80 MiB E2E，亦不证明生产质量或容量。
