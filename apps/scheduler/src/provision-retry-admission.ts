import { projectProvisionFailure } from "./provision-failure-evidence.js";

/**
 * #1119 方案 C：让「可证伪的 provision 失败」获得一次有界重试。
 *
 * `retryProvisioningJob` 的未知外部效果门禁只认 provision effect 的
 * `never_started` 结算；而 egress sidecar 在 create 阶段 5xx 时，容器对象由
 * OpenSandbox 建出后才 start 失败，settlement 拿不到 `never_started`，但结构化
 * 证据（provision-failure/v1 审计内的 host 诊断）已经证明 Agent/会话从未运行。
 * 这里把这份证据作为**等价于 never_started** 的白名单，其余一律继续 fail closed。
 */

const NEVER_STARTED_STAGES = new Set(["create", "runtime_contract"]);

export function provisionFailureProvesNeverStarted(value: unknown): boolean {
  const diagnostic = projectProvisionFailure(value);
  if (!diagnostic) return false;
  return NEVER_STARTED_STAGES.has(diagnostic.stage)
    && diagnostic.session_observed === false
    && diagnostic.cancelled === false
    && diagnostic.http_status !== null
    && diagnostic.http_status >= 500 && diagnostic.http_status <= 599;
}
