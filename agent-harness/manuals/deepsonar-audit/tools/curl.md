# curl

> Agent 面向工具说明书。内部实现依赖不在此列。路径约定：镜像内 `/opt/deepsonar/manuals/`。

## 使用场景

需要按策略发起 HTTP(S) 请求下载或探测可达性时使用。

## 选型依据

默认沙箱可能断网；不要用 curl 代替浏览器 CDP 观察页面；不要用它绕过设备协议。

## 前置条件

egress 策略允许；已知 URL；证书可用（ca-certificates）。

## 调用方式

入口：`curl`。常用：`-fsSL`、`-o`、`-D -`。

最小示例：

```bash
curl -fsSL -o /tmp/sample.txt https://example.com/ || echo "egress_blocked:$?"
```

## 输出解释

文件或响应体；HTTP 码需显式 `-w`。成功下载不证明应用漏洞。

## 失败处理

| 类别 | 表现 | 处理 |
| --- | --- | --- |
| 正常无结果 | 空响应体 | 记录查询条件与空结果；不要升级为 needs_human |
| 可修正错误 | URL/参数错误 | 修正参数/路径后重试 |
| 可重试失败 | 瞬时网络 | 有限次重试；仍失败则记 inconclusive |
| 缺少运行条件 | 断网/DNS/TLS 被策略拒绝 | 明确缺项；提交 needs_human / inconclusive，禁止编造 |

## 组合流程

下载样本后接 file/unzip/jadx；Chrome 场景优先 CDP。

## 证据留存

URL、响应码、字节数、sha256、策略是否允许 egress。

## 版本与限制

apt 钉选；注意跟随重定向与 SSRF 风险，仅访问任务允许目标。
