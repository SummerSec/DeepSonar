# Pi retry lifecycle implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Tests/build/typecheck run only in GitHub Actions per AGENTS.md.

**Goal:** 修复 #1072：Pi 单次模型失败不提前终止内部重试，最终失败和完成回执边界保持真实。
**Architecture:** 在既有 Pi adapter 中将模型消息错误保留到 agent_settled；只有观测到后续成功消息才清除可恢复消息错误。协议/进程/取消错误继续失败，不新增模型请求或恢复权限。
**Tech Stack:** TypeScript、node:test、既有 RuntimeHost/Pi RPC、GitHub Actions。
**Spec:** DESIGN.md 运行器失败来源；docs/AGENT_CLI_RUNTIME_ADAPTERS.md；AGENTS.md 生命周期与仅 Actions 验收。

## Global constraints
- Job c76115f3-3d90-4c11-a56a-f2efe2b82a73 不重跑，不修改冻结快照/历史账本。
- 使用 Barry04 发布 Issue/PR，不部署、不合并。
- 独立worktree；不扩大预算、不把 terminated 无条件视为可重放网络错误。

## Review focus
- Pi message_update与message_end同一错误不双重终态化。
- 成功重试须成功消息；仅auto_retry_end success不足以完成。
- 非模型协议/扩展/进程错误不被成功重试掩盖。
- 无retry的最终错误、耗尽、取消、完成拒绝保留来源。
- 同一进程/Session内部重试不关闭stdin；完成门继续要求持久回执。

## Tasks
- [x] 读取现场Session、Job、effects和HTTP日志；登记#1072，区分已知宿主缺陷和未证明的最初断开来源。
- [x] 添加真实runner回归，PR #1073 在 Actions 复现失败；不运行本地测试。
- [x] 修复adapter模型消息错误与retry/settled衔接，补负例；GREEN 待 Actions。
- [x] 同步CLI专题、运行时视图、既有需求追溯及索引；无schema/API变更。
- [ ] 独立评审、git diff --check、推送并核对最新SHA Actions；交付PR与真实验证状态。

## Rulings and evidence
- Draft-fast 当前只跑路径映射套件，不包含 runtime-sandbox。为在 Actions 观察新增回归的 RED，测试提交 1afd5d1e 以 Ready PR #1073 触发完整核心；未修改路由或门禁。修复提交后必须重新验证最新 SHA。
- 初始 terminated 定位为 Undici 响应体异常终止；Pi-AI 1.4.0 只保留 message/status/body，已丢失 cause/code。无法从历史记录证明这次是空闲超时还是socket断链；不据此扩大重试权限。宿主过早终态化另由源码及现场新请求/终态时间线证实。
- RED 证据：提交 1afd5d1e、Actions 42999636017、gate-runtime job 130452361311 的 Runtime sandbox semantic tool unit 在2026-11-11T10:03:11Z失败。两条新测试均命中预期：message_end过早result；message_update消费后stdinClosed=true。该SHA的typecheck/build已通过。为避免在已确认失败的候选上继续重型CI，主线程取消剩余core/reverse；最终修复SHA重新完整验收。
