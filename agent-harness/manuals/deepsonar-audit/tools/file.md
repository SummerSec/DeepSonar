# file

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

识别文件类型（ELF/APK/zip/脚本）以决定下一步工具。

## 选型依据

不替代 readelf/jadx 深挖。

## 前置条件

目标文件可读。

## 调用方式

入口：`file`。

最小示例：

```bash
file -b /path/to/sample
```

## 输出解释

类型描述字符串。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 罕见 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | 路径错误 | 修正参数/路径后重试 |
| 可重试失败 | 无 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 文件不存在 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

APK→jadx/apktool；ELF→readelf/r2；zip→unzip。

## 证据留存

路径、sha256、file 输出。

## 版本与限制

apt file。
