# Hub 统一任务入口与事件触发实施方案

> 状态：**历史方案稿**（Hub 入口与事件触发已 as-built，见 `DESIGN.md`）。  
> 冲突时以 `DESIGN.md`、OpenAPI 与代码为准。
>
> 适用范围：任务创建、Agent 编排、Finding 验证、任务画布  
> 核心结论：`hub_reason` 是唯一决策入口；执行角色由 Hub 下发意图、Scheduler 落地。

## 1. 为什么要这样改

此前任务创建后直接启动 `audit_module`，等 Audit 完成后才让 Hub 介入。这会产生三个问题：

1. Hub 不是入口，无法根据任务内容判断是否真的需要审计、分析、测试或代码梳理；
2. 人必须提前理解任务类型和执行方式，违背“人只表达目标”的设计原则；
3. 人工任务、Plane Issue 和机器事件容易形成不同的编排路径，后续状态与画布难以保持一致。

改造后的职责边界是：

- 人：只提供标题和内容；
- 外部系统：只提供事件事实，不指定 Agent 和执行步骤；
- Hub Agent：读取目标和整张画布，决定下一步角色与意图；
- Audit Agent：执行安全审计，输出结构化 Finding；
- 调度器：维护状态机、幂等、验证派生、画布和真正的 Job 下发；
- Verify Agent：验证 Finding，输出明确 verdict；
- Hub 风险验收：对 confirmed 风险决定是否继续搭环境、写 PoC、动态复现或分析影响。

## 2. 本方案范围

### 2.1 本轮实施

- 新建任务只接收 `title` 和 `content`；
- 人工任务、Plane Issue、外部事件统一进入 `hub_reason`；
- Hub 可以派发 `audit` 角色；
- Audit 输出 Finding 后，所有 Finding 自动进入验证；
- confirmed Finding 强制进入 Hub 风险验收；
- Hub 可以继续派发 `test/verify/analyze/code` 等角色；
- 子 Agent 结果重新回到 Hub 收敛；
- 画布完整展示任务来源、决策、执行、发现、验证和验收关系；
- 外部事件使用稳定幂等键，重复投递不重复执行。

### 2.2 明确不做

- 漏洞运营闭环、工单分派、修复 SLA、复测和关闭流程；
- 与本方案无关的生产加固项目；
- 让用户选择 Agent 类型、优先级、超时、模型或执行步骤；
- 允许外部事件直接指定角色或绕过 Hub；
- 让 Agent 直接修改 Job 状态、画布边或数据库。

### 2.3 当前落地状态

| 能力 | 状态 | 说明 |
|------|------|------|
| 人工任务进入 Hub | 已落地 | 首个 Job 为 `hub_reason` |
| Plane Issue 进入 Hub | 已落地 | 标题和描述直接作为自然语言目标 |
| 事件入口和幂等 | 已落地 | `POST /projects/{id}/events`，重复事件复用原任务 |
| Hub 派发 Audit | 已落地 | 新增内置 `audit` 角色 |
| Finding 必验 | 已落地 | Finding 创建后自动派发 Verify |
| confirmed 风险验收 | 已落地 | 强制进入 Hub，子 Agent 结果再次回收 |
| 画布语义边和流动效果 | 已落地 | 六类边独立颜色、速度和方向 |
| 事件 API Token 门禁 | 上线前必做 | 当前事件路由只能用于本地或受信网络，公网接入前完成 §5.4 |

## 3. 第一性原理

### 3.1 人输入的是意图，不是调度参数

人类最擅长描述“希望得到什么”，不应该被要求理解内部 Job 类型、Agent 角色、执行超时和调度优先级。因此人工任务的稳定契约只有：

```json
{
  "title": "检查登录与权限控制",
  "content": "重点检查认证绕过、越权和输入注入问题"
}
```

`type/profile/priority/timeout/module_path` 都不属于人工输入。

### 3.2 事件是事实，不是命令

CI、监控系统和扫描器发送的是“发生了什么”，不是“必须调用哪个 Agent”。事件进入后由 Hub 结合项目目标和已有画布决定行动。

### 3.3 Hub 决策，角色执行，调度器落地

Hub 只能输出 `complete` 或 `intents` 提案；真正创建 Job、校验角色白名单、限制轮次和写入画布的仍然是调度器。这样可以保留 Agent 自主性，同时避免 Agent 获得不可控的系统副作用。

### 3.4 Finding 必须验证

Finding 只是审计假设，不能直接当作真实风险。所有 Finding 都必须经过 Verify；严重等级只表达影响，不决定是否验证。

### 3.5 confirmed 不等于任务结束

`confirmed` 表示风险成立，但可能仍缺少运行环境、PoC、利用条件和影响范围。confirmed 后必须由 Hub 验收，再决定是否需要进一步工作。

## 4. 总体架构

```text
┌─────────────────────────────────────────────┐
│                 任务入口                     │
│  Web title/content │ Plane Issue │ Event API │
└──────────────────────┬──────────────────────┘
                       │ 统一标准化
                       ▼
              ┌─────────────────┐
              │    hub_reason   │
              │  读取目标与整图  │
              └────────┬────────┘
                       │ hub_decision
          ┌────────────┼──────────────┐
          ▼            ▼              ▼
       audit         explore         test/...
          │            │              │
       Finding        Fact           Fact
          │                            │
          ▼                            └──────┐
   verify_finding                            │
          │                                  │
   ┌──────┼───────────┐                      │
   ▼      ▼           ▼                      │
confirmed false_positive needs_human         │
   │                                         │
   └──────────────► hub_reason ◄─────────────┘
                         │
                    complete / intents
```

所有入口共用同一组核心函数：

```text
ensureCanvasForTask → createJob(type=hub_reason) → pg_notify → dispatcher
```

## 5. 统一任务入口

### 5.1 人工任务

接口：

```http
POST /projects/{project_id}/tasks
Content-Type: application/json
```

请求：

```json
{
  "title": "审计认证模块",
  "content": "检查注入、认证绕过和水平越权"
}
```

服务端转换为：

```json
{
  "type": "hub_reason",
  "payload": {
    "title": "审计认证模块",
    "content": "检查注入、认证绕过和水平越权",
    "goal": "检查注入、认证绕过和水平越权",
    "trigger": { "kind": "user_task" }
  }
}
```

前端不得重新加入角色、优先级、超时和模型选择器。高级配置属于项目级 Agent Profile 和调度规则，不属于单次任务创建。

### 5.2 Plane Issue

Plane 仅作为可选入口：

- Issue 标题映射为任务标题；
- Issue 描述转换为纯文本内容；
- Ready 状态触发领取；
- 首个 Job 类型为 `hub_reason`；
- `trigger.kind = plane_issue`；
- 不再解析 `type=audit_module`、`path=` 等键值参数。

### 5.3 外部事件

接口：

```http
POST /projects/{project_id}/events
Content-Type: application/json
```

请求模型：

```json
{
  "event_id": "alert-20260801-001",
  "source": "ci",
  "event_type": "security_scan_failed",
  "title": "主分支安全扫描失败",
  "content": "CI 检测到新的高风险告警，请判断是否需要审计和验证",
  "data": {
    "repository": "demo",
    "branch": "main",
    "commit": "abc123",
    "alert_count": 2
  }
}
```

字段约束：

| 字段 | 必填 | 说明 |
|------|------|------|
| `event_id` | 是 | 事件源内稳定 ID，用于幂等 |
| `source` | 是 | 来源标识，例如 `ci`、`sast`、`monitor` |
| `event_type` | 是 | 事件类型，不直接映射 Agent 角色 |
| `title` | 否 | 缺省生成 `[source] event_type` |
| `content` | 否 | 缺省由事件类型和 data 生成自然语言上下文 |
| `data` | 否 | 事件原始结构化事实 |

事件统一转换为：

```json
{
  "type": "hub_reason",
  "payload": {
    "title": "主分支安全扫描失败",
    "content": "...",
    "goal": "...",
    "trigger": {
      "kind": "external_event",
      "source": "ci",
      "event_type": "security_scan_failed",
      "event_id": "alert-20260801-001",
      "data": {}
    }
  }
}
```

外部事件不得携带 `role/type/profile/priority` 等调度字段。即使 data 中存在同名字段，Hub 也只把它当作不可信事件内容。

### 5.4 事件入口鉴权

事件接口对外开放前必须接入项目级 API Token：

```http
Authorization: Bearer <project-api-token>
```

最低要求：

- Token 只保存安全哈希，不保存可回显明文；
- Token 必须绑定项目，URL 中的 project ID 必须与 Token 所属项目一致；
- Token 至少具有 `tasks:write` scope；
- Token 放在 Header，不允许放 URL、事件 data 或日志；
- 无 Token 返回 `401`，项目或 scope 不匹配返回 `403`；
- `event_id` 只负责幂等，不能替代身份认证。

本地回环联调可以临时使用开发 Token；没有鉴权门禁时，`/projects/{id}/events` 只能监听在受信网络，不得直接暴露公网。

## 6. 事件幂等设计

事件平台通常采用至少一次投递，因此重复事件是正常情况，不能靠调用方保证只发送一次。

### 6.1 画布幂等

`canvases` 增加：

```text
trigger_source
trigger_event_id
trigger_payload_json
```

唯一约束：

```text
(project_id, trigger_source, trigger_event_id)
```

相同项目、来源和事件 ID 只能对应一个任务画布。

### 6.2 入口 Job 幂等

`jobs` 增加 `ingress_key`：

```text
event:{source}:{event_id}
```

唯一约束：

```text
(project_id, ingress_key)
```

画布唯一约束避免重复任务，Job 唯一约束避免并发请求在同一画布创建两个入口 Hub。

### 6.3 重复请求响应

- 第一次事件：HTTP `201`，返回新画布和 Hub Job；
- 重复事件：HTTP `200`，`duplicated=true`，返回原画布和原入口 Job；
- 不把重复事件当作错误，也不再次执行。

## 7. Agent 职责和输出契约

### 7.1 Hub Agent

输入：

- `goal`；
- `target`；
- `root_id`；
- `facts/findings`；
- `open_intents/concluded_intents`；
- `hints`；
- 当前触发原因。

输出二选一：

```json
{
  "intents": [
    {
      "from": ["root-or-fact-id"],
      "role": "audit",
      "description": "审计认证入口和权限校验链路，输出结构化 Finding"
    }
  ]
}
```

或：

```json
{
  "complete": {
    "from": ["fact-id"],
    "description": "任务目标已经达成"
  }
}
```

首次 Hub 轮次不得在没有执行证据时直接 `complete`。安全审计目标应优先考虑 `audit`，但最终角色组合由 Hub 根据目标决定。

### 7.2 Audit Agent

`audit` 是 Hub 可派发角色，和历史入口类型 `audit_module` 分离：

- `audit_module`：仅保留历史兼容和系统模板；
- `audit`：Hub 实际可派发的执行角色。

Audit 输出 `/workspace/findings.jsonl`，每行一个 Finding：

```json
{
  "title": "SQL 注入",
  "severity": "high",
  "location": "auth/login.ts:42",
  "summary": "用户输入未经参数化进入 SQL 查询",
  "rule_id": "sql-injection",
  "suggest_verify": true
}
```

`suggest_verify` 只是兼容字段，不决定是否验证。

### 7.3 Verify Agent

Verify 只验证单个 Finding，输出：

```json
{
  "summary": "验证证据与结论",
  "verdict": "confirmed"
}
```

合法 verdict：

- `confirmed`；
- `false_positive`；
- `needs_human`。

### 7.4 其他角色

`explore/analyze/test/code` 等角色输出增量 Fact，不直接修改 Finding 状态。Hub 根据这些 Fact 决定继续派发还是完成。

## 8. 调度状态机

### 8.1 首次决策

```text
创建 root
  → 创建 hub_reason pending Job
  → dispatcher claim
  → Hub 输出 intents
  → 调度器校验角色白名单
  → 创建 intent 节点和角色 Job
```

### 8.2 Finding 验证

```text
Audit emit finding
  → fingerprint 去重
  → Finding 节点 open
  → 创建 verify_finding Job
  → Finding 状态 verifying
  → 创建 Finding → Verify 的 verifies 边
```

所有 Finding 必验，但仍受现有最大派生数量和深度护栏约束，防止失控。

### 8.3 验证结果

| verdict | Finding 状态 | 下一步 |
|---------|---------------|--------|
| `confirmed` | confirmed | 强制创建 Hub 风险验收 Job |
| `false_positive` | false_positive | 所有活动验证结束后由普通 Hub 评估是否继续 |
| `needs_human` | needs_human | 保留画布证据，等待人工判断 |

普通 Hub 在同一画布仍有活动 Verify Job 时不得提前收敛；confirmed 使用强制路径立即进入风险验收。

### 8.4 风险验收

confirmed 触发的 Hub 必须检查：

- 是否需要运行或模型环境搭建；
- 是否需要最小 PoC；
- 是否需要动态复现；
- 利用前置条件是否明确；
- 影响范围是否明确；
- 当前证据是否足以结束任务。

Hub 可以派发 `test/verify/analyze/code`。这些角色完成后带 `hub_followup=true`，结果必须回到新的 Hub 验收轮次。只有 Hub 输出 `complete` 才把 root 置为 `succeeded`。

### 8.5 重试

重试必须满足：

- 当前画布没有 `pending/claimed/provisioning/running/waiting_human` Job；
- 复用原画布，保留历史节点和事件；
- 复用最早的入口 Job 类型与 payload；
- 对新任务而言，重试的仍然是原始 `hub_reason`，不能重试最后一个派生 Agent。

## 9. 画布表达

### 9.1 节点

| 节点 | 含义 |
|------|------|
| root | 原始任务或事件目标 |
| job: hub_reason | Hub 决策或风险验收 |
| intent: audit | Hub 下发的审计意图，也是 Audit Job 的可视节点 |
| finding | Audit 产出的待验证发现 |
| job: verify_finding | 单 Finding 验证任务 |
| intent | Hub 下发的其他角色工作 |
| fact | 角色 Agent 产出的增量事实 |
| human | 需要人工判断的阻塞点 |

### 9.2 边

| 边 | 方向 | 颜色 | 动效 | 含义 |
|----|------|------|------|------|
| `child` | root → Hub/Job | 灰蓝 | 慢速流动 | 任务包含的运行 |
| `produces` | Audit/Job → Finding | 琥珀 | 中速流动 | Agent 产出发现 |
| `verifies` | Finding → Verify | 青色 | 快速流动 | 发现进入验证 |
| `next` | Finding/Fact → Hub | 紫色 | 中速流动 | 结论触发下一轮决策 |
| `from` | root/Fact/Finding → Intent | 粉色 | 中速流动 | 意图引用的依据 |
| `to` | Intent → Fact 或 Fact → root | 绿色 | 中速流动 | 工作产出或最终收敛 |

所有边必须有方向箭头和流动动画；系统设置 `prefers-reduced-motion` 时关闭动画，但保留颜色和箭头语义。

### 9.3 标准画布路径

```text
Root
  └─child→ Hub 首次决策
Root
  └─from→ Audit Intent
Audit Intent
  └─produces→ Finding
Finding
  └─verifies→ Verify Job
Finding confirmed
  └─next→ Hub 风险验收
Finding/Fact
  └─from→ Test Intent
Test Intent
  └─to→ Fact
Fact
  └─next→ Hub 回收验收
Fact
  └─to→ Root succeeded
```

## 10. 数据库迁移

迁移文件：

```text
apps/scheduler/migrations/0010_hub_ingress_and_event_triggers.sql
```

迁移内容：

1. `canvases` 增加事件来源、事件 ID 和原始 payload；
2. 建立事件画布唯一索引；
3. `jobs` 增加入口幂等键；
4. 建立入口 Job 唯一索引；
5. 从 `audit_module` 系统模板生成可被 Hub 派发的内置 `audit` 角色。

迁移是纯增量操作，不删除历史字段和历史 Job。回滚应用代码时保留新增列和索引即可，不做破坏性 down migration。

## 11. 代码改造映射

| 文件 | 实施内容 |
|------|----------|
| `apps/scheduler/src/routes.ts` | 人工任务改为 Hub；新增事件入口；事件幂等响应；活动任务重试门禁 |
| `apps/scheduler/src/plane-sync.ts` | Plane Issue 攋为 Hub 入口 |
| `apps/scheduler/src/core.ts` | 入口幂等键、事件画布、Finding 来源兼容 intent、Verify 活动门禁、Hub 验收循环 |
| `apps/scheduler/src/dispatcher.ts` | fake 模式支持 Hub → Audit 的完整演示链 |
| `apps/scheduler/src/executor-real.ts` | 区分 Hub/Audit/Verify/Fact 角色，增加首次决策和事件触发提示 |
| `apps/scheduler/src/graph.ts` | 图快照暴露 `root_id` |
| `packages/shared-types/src/index.ts` | 注册内置 `audit` Job 类型 |
| `apps/web/src/pages/TasksPage.tsx` | 保持标题/内容最小表单，说明 Hub、Plane 和事件入口 |
| `apps/web/src/CanvasView.tsx` | 六类边的颜色、箭头和流动速度 |
| `apps/web/src/styles.css` | SVG 边流动动画与 reduced-motion 兼容 |
| `agent-harness/test-local-project-api.py` | 验证完整 Hub 链路和事件幂等 |

## 12. 分阶段实施顺序

### 阶段 A：数据库和角色

1. 部署 `0010` 迁移；
2. 确认 `agent_roles` 存在内置 `audit`；
3. 确认项目角色启用清单包含 `audit`，或保持 `roles.enabled = null` 使用全部内置角色；
4. `audit` 默认复用 `audit_module` 的 Agent Profile 绑定。

验收：Hub 的可用角色列表中能够看到 `audit`。

### 阶段 B：统一入口

1. Web 创建任务只发送 title/content；
2. Plane 创建 `hub_reason`；
3. Event API 创建 `hub_reason`；
4. root 保存自然语言目标和 trigger 元数据。

验收：三种来源创建的第一个 Job 都是 `hub_reason`。

### 阶段 C：编排和 Finding 链

1. Hub 首轮输出 audit intent；
2. Audit Intent 能产出 Finding；
3. Finding 自动派生 Verify；
4. confirmed 强制进入 Hub；
5. Hub 派发测试或分析角色；
6. Fact 回到 Hub，最终收敛 root。

验收：画布出现标准链路，且 root 只能由 Hub complete。

### 阶段 D：事件接入

1. 为项目创建仅含 `tasks:write` scope 的 API Token；
2. 选择一个真实事件源；
3. 为事件生成稳定 `event_id`；
4. 只发送决策所需字段；
5. 模拟重复投递；
6. 验证返回相同 canvas/job。

验收：重复发送 10 次只创建一个入口 Job。

### 阶段 E：真实 Agent 验收

1. 使用 `AGENT_MODE=real`；
2. 为 `hub_reason/audit/verify/test` 绑定可用 Agent Profile；
3. 运行一个可稳定发现漏洞的测试仓库；
4. 检查 findings.jsonl、verdict、PoC Fact 和 Hub complete；
5. 确认沙箱销毁、Job 终态和画布一致。

## 13. 验收标准

### 13.1 自动检查

```powershell
pnpm typecheck
pnpm build
python agent-harness/test-local-project-api.py
```

必须全部通过。

### 13.2 API 断言

- 人工任务请求只含 title/content；
- 人工任务首个 Job 为 `hub_reason`；
- Event 首次请求返回 `201`；
- 同一 Event 重复请求返回 `200 + duplicated=true`；
- 无 Token、错误 Token、跨项目 Token 和缺少 `tasks:write` scope 分别被拒绝；
- 重复 Event 的 canvas ID 和 Job ID 与首次一致；
- 归档项目拒绝人工任务和事件任务；
- 有活动 Job 时拒绝 retry。

### 13.3 图断言

至少存在：

```text
root → hub_reason          child
root → audit intent       from
audit intent → finding    produces
finding → verify          verifies
finding → hub_reason      next
intent → fact             to
fact → hub_reason         next
fact → root               to
```

### 13.4 状态断言

- Finding 创建后由 `pending` 进入 `verifying`；
- Verify verdict 与前后端展示值完全一致；
- confirmed 后一定存在风险验收 Hub；
- 活动 Verify 存在时普通 Hub 不得将 root 提前置为 succeeded；
- 最终只有 Hub complete 可以将 root 置为 succeeded。

## 14. 上线与回滚

### 14.1 上线顺序

```text
备份数据库
  → 发布包含 0010 的 scheduler
  → 启动自动迁移
  → 校验 audit 角色
  → 发布 Web
  → fake 模式冒烟
  → 单项目 real 模式验证
  → 接入第一个真实事件源
```

### 14.2 回滚

若 Hub 入口出现阻塞：

1. 停止接收新的外部事件；
2. 应用层临时将新任务入口切回 `audit_module`；
3. 保留 `0010` 新增列和索引，不删除历史画布；
4. 已创建的 Hub/Intent/Finding/Verify 节点保持只读，避免丢失过程证据；
5. 修复后从原始 root 重新创建 Hub Job。

## 15. 完成定义

本方案只有同时满足以下条件才算完成：

- 人工任务只填写标题和内容；
- 人工、Plane、事件三个入口均先进入 Hub；
- Audit 由 Hub 派发，不再充当决策入口；
- Finding 全部自动验证；
- confirmed 风险强制由 Hub 验收；
- 后续环境、PoC、动态复现由 Hub 自主选择角色；
- 子 Agent 结果能回到 Hub 收敛；
- 画布方向、颜色、动画和状态一致；
- 外部事件重复投递不会重复创建任务；
- 类型检查、构建、API 测试和图断言全部通过。

达到以上条件后，DeepSonar 的任务模型才真正成为“人表达目标、事件提供事实、Hub 负责决策、Agent 负责执行、调度器负责可信落地”。
