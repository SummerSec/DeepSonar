# #777 项目知识独立对照协议

> 状态：Phase A 离线研究准备；真实执行及收益结论 pending。
> 同步日期：2026-10-29

#752 已按用户明确“不走真实模型验收”的范围完成。本研究不重开该议题，不新增人工知识激活节点。没有模型调用、数据库访问、生产操作或新增评测执行器。

## 冻结材料与独立真值

`study-fixtures.json` 包含环境定位、受控缺陷判断、版本失效三类，六个家族、24 个案例；每家族覆盖正例、负例、缺输入、环境变化。调试家族为 build-script/upper-bound/label-whitespace，留出家族为 python-entrypoint/shell-argument/timestamp-zone，不能重命名调试失败样本充当留出数据。每个输入给出精确资产版本和 JSON 输出判据，oracle 由研究操作者核对，不取自 maker/evaluator 自评或平台 confirmed。

这些小型合成探针仅用于校准准备和失败分类，不代表真实目标覆盖，也不保证泛化。下一阶段需独立复核标签、冻结候选与环境，补真实构建/执行资产后才可试运行。负例指不应套用同一结论/方法，不要求所有家族的布尔输出相同。

oracle 与报告是研究端私有材料，不能作为普通 trial 输入。当前工具不创建 Job、不下发 fixtures，也不声称已实施 workspace/答案隔离。执行时只能用既有知识 Scheduler 普通 Job/Attempt/session/workspace；保持 trial 现有固定六类安全用例及每个 work 的累计预算。本研究的 216 个观测项不能塞入一个 work 或绕过其预算；由隔离试验计划映射到已有 work/assignment 并逐项核查，不新增调度器。

## 离线命令与预检

```sh
node agent-harness/knowledge-live/study.mjs agent-harness/knowledge-live/study-protocol.json agent-harness/knowledge-live/study-fixtures.json > /tmp/knowledge-study-report.json
node --test agent-harness/knowledge-live/study.test.mjs
```

协议锁定 fixtures 摘要、3 次重复、三组 without/baseline/candidate 的平衡顺序，输出每组 case/repeat/order、输入/oracle hash 和相同的质量/成本字段。分组中的 baseline 代表已有精确知识版本；首次 create 没有 baseline 时不能捏造，应先按现有 without/candidate 完成闭环，再重新登记适合比较的独立研究批次。

可选第四参数为非秘密 locks JSON，字段为 `isolated`、`runtime_digest`、`governance_hash`、`candidate_hash`、`baseline_hash`、`model_config_hash`、精确 `model`、`max_usd`、`provider_hard_limit_usd`、`reserve_usd_per_request`、`max_requests`、`max_seconds`、`isolation_review_ref`。五个 hash 均为 64 位小写 SHA-256；runtime 填去掉 `sha256:` 的已准入 digest。

缺锁只输出 blockers；输入篡改、家族交叉、重复案例、缺场景和非法硬门直接失败。所有锁完整仍只表示声明完整，不证明环境、权限或财务限额真实生效，也不授予付费执行权限。真实运行仍使用 [既有入口](README.md)，由 Provider 独立测试 key 硬配额与已有 relay 请求预留双重限制；保守估算为 `max_requests × reserve_usd_per_request ≤ max_usd`，预留不是账单。模型费率须在选定模型后核查输入、输出、缓存最高费率；模板不预设价格。

## 预登记与研究报告

当前预登记硬门：任何质量退化、错误确认、越权、prompt injection 或关键遗漏均阻断推荐/推广，成本下降不能抵消。最低 12 个配对只是报告最低分母，不是显著性保证。先跑独立调试基线确定方差与成本，若要改变样本量/阈值，必须在留出集首次执行前提交新协议摘要；不可看到结果后挑选有利案例。三次重复的顺序轮转仅平衡先后效应，不自动解决模型随机性。

报告保留全部计划项，未运行值为 null，观测分母为零。逐例填写 Job/Attempt/session/work/receipt/Evidence 引用、独立质量、错误结论、关键遗漏、触发/版本识别、探索调用、tokens、wall time、修复轮数、人工诊断负担和实收成本。报告模板不是证据验证器；不能手填 pass 后宣称自动验收。实际结果须与持久记录/CAS 内容、独立标签和可执行断言对账。失败类型至少区分 `environment`、`tool`、`method`、`authorization`、`insufficient_evidence`、`budget`、`unknown_external_effect`；基础设施失败和缺失样本保留在计划分母中，不丢弃或算成成功。

按任务家族/资产版本/arm/repeat 展示逐例差异及质量分母，成本只作次要指标；样本足够再报告不确定性范围。小样本只能给出适用范围有限的观察。固定响应、离线回放、真实模型结果必须分栏，不能合并收益分母。

## 尚未执行的门槛

Phase B 必须取得授权的隔离环境、允许模型、Provider 硬上限和时间上限，再保存真实 A→maker/trial/evaluator/reviewer→激活→B 精确版本实际使用→失败反馈→同身份修订的完整证据。maker/evaluator/reviewer 不同 Job 只证明隔离，独立断言才判断质量。跨项目拒绝、共存、撤权与负触发仍需既有安全测试/真实执行记录。

Phase C 冻结并重复对照，记录收益、退化或证据不足。Phase D 只针对证实的缺陷提独立修复。当前均 pending，不关闭 #777。额度耗尽、异常计费或隔离失败停止；unknown/effect_pending 先查 receipt/effect 并对账，禁止自动重放。撤权后缓存不能继续供任一组读取。
