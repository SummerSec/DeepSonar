# mvn

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

构建 Java PoC/测试（kali）。

## 选型依据

移动端 APK 分析用 jadx/apktool，不是 mvn。

## 前置条件

pom.xml；JDK 可用；egress 影响依赖。

## 调用方式

`mvn -v`/`mvn -q -DskipTests package`。

最小示例：

```bash
mvn -v
```

## 输出解释

版本与构建产物。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | pom 错误 | 修正参数/路径后重试 |
| 可重试失败 | 中央仓库瞬时 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 断网/无 JDK | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

java -jar 运行产物。

## 证据留存

pom、mvn 版本、产物哈希。

## 版本与限制

kali 钉选 Maven。
