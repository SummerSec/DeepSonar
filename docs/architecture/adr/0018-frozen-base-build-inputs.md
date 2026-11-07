# ADR 0018：基础镜像依赖使用固定来源与摘要，失败不回退 live

> 状态：**已采纳构建边界**；本分支的输入冻结前置实现尚待最终 SHA Actions 原生验收。跨运行复用未实现，决策不代表其已交付。
> 同步日期：2026-11-08
> 来源：[#992](https://github.com/SummerSec/DeepSonar/issues/992)、[NFR-OPS-003](../01-system-specification.md#nfr-ops-003-发布与文档保鲜)、[CI 构建输入](../../CI_COST_ACCEPTANCE_992.md#6-基础构建输入冻结992前置切片)

## 背景

相同仓库 tree 不证明相同有效构建输入。base 仍可因 registry 解析、APT 源和原生工具资产变化而得到不同依赖；只记录指纹、版本或事后产物 hash，不能授权 PR→main 的构建复用。当前 main 测试、镜像准入和发布来源边界必须保留。

## 决策

1. 对 base 的可枚举外部依赖维护固定来源和内容摘要：CLI/OM 使用完整 npm lock；Debian 使用固定快照并核验实际 APT 消费的 signed InRelease；fd 使用固定双架构资产 SHA。
2. 不以版本一致替代内容身份，也不在不可用或不符时恢复 live/unpinned 安装。历史快照可关闭 valid-until 时效检查，但 GPG、TLS 和预期摘要仍强制。
3. 保留 CLI 原生 hooks 和标准全局包布局、自有 npm/corepack；OM/DSH 的 canonical prefix 与既有治理不变。不以忽略所有 hooks、SDK shim、Pi offline/发现旗标或 CLI 改版解决依赖问题。
4. 输入冻结与证据复用分开。npm closure 本身不证明 lifecycle；当前三个固定 hook 已静态核实无二次下载，仍须校验 native 软成功/占位入口，任何新增 hook/材料重新审计。实际 builder/backend、parent native child、Action/context/ARG/env/权限必须另外收口，未知输入不获得复用资格。
5. 即使后续允许 CI-only base build 复用，原产物来源身份也不能改写为 main；当前提交测试/smoke、稳定汇总和发布门继续执行。当前前置切片不启用任何跨运行复用。

## 取舍与替代方案

- 拒绝 live 源或仅固定根版本：无法解释输入相等，失效后静默恢复也延续了旧语义。
- 拒绝全局 `npm ci` 或私有模块查找 shim：前者可能删除自有 npm，后者改变标准 SDK 解析；采用 canonical staging 后标准布局。
- 拒绝跳过 CLI 原生 hooks：Claude 的真实原生入口必须安装，不能用版本字符串或 stub 冒充。
- 增加的维护成本仅是机器锁/快照/资产摘要及验证接线；不新增运行时开关、人工通知、Job 权限或生产流程。更新依赖必须同步这些输入并重新验收。

## 实现与证据边界

[Dockerfile](../../../deploy/Dockerfile.agent)、[APT 身份](../../../agent-harness/base-apt-runtime.json)、[verifier](../../../agent-harness/base-apt-inputs.mjs)、[CLI lock](../../../agent-harness/base-cli-runtime/package-lock.json)、[OM lock](../../../agent-harness/pi-extensions-base-runtime/package-lock.json) 和[回归](../../../agent-harness/base-apt-inputs.test.mjs) 已接线。指纹及 PR/main 触发路径一并覆盖。

本次只做元数据/静态摘要核对和 diff 检查，未运行本地 test/build/typecheck/安装。双架构原生构建、真实 CLI 与完整最终候选 Actions 待验；三个固定 hooks 的无下载分支已静态核实；安装 guard 与镜像内 npm/native 行为待最终 SHA 实跑。没有真实跨运行命中与可比成本样本，复用收益保持 `unknown`，不关闭 #992，不自动合并或执行生产动作。
