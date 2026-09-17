# apktool

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

解码资源、smali、清单便于修改/回编译分析。

## 选型依据

只要 Java 视图用 jadx；只要引用查询用 droidasc。

## 前置条件

Java；APK。

## 调用方式

`apktool d app.apk -o out`

最小示例：

```bash
apktool --version
```

## 输出解释

out/ 含 smali/res/AndroidManifest.xml。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 无 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 框架缺失/损坏 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 无 apktool | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

与 jadx/droidasc 互补。

## 证据留存

命令与 out 树摘要。

## 版本与限制

钉选。
