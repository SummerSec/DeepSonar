# java/javac (managed JDK)

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

编译运行 Java PoC 或驱动 jar 工具。

## 选型依据

Android 反编译用 jadx，不靠 javac。

## 前置条件

JAVA_HOME 指向镜像 JDK。

## 调用方式

`java`/`javac`。

最小示例：

```bash
java -version
```

## 输出解释

版本信息。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 错误 class | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | JAVA_HOME 未设 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 mvn/apktool/jadx 协作。

## 证据留存

java -version 输出。

## 版本与限制

kali 多版本；mobile JDK17。
