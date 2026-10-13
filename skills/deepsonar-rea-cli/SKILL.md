---
name: deepsonar-rea-cli
description: 在 DeepSonar deepsonar-reverse 镜像内通过受治理 REA CLI（非 MCP）对 ELF/.so/PE 做有界深度静态分析，并按证据链归档结果。
---

# DeepSonar REA CLI（深度二进制解析）

仅在冻结镜像为 `deepsonar-reverse` 时使用。平台是控制面：能力由目录/准入与镜像 digest 约束；不要安装额外工具、不要注册 MCP、不要启动常驻 REA 服务。

## 钉死基线

- `rea-agents@6.4.0`（gitHead `a56f7bb668ab23fec8d33f7af353ac7ed2fe1895`）
- Ghidra `12.1.4`，`GHIDRA_INSTALL_DIR=/opt/deepsonar/ghidra`
- 完整 64 位 JDK 21：`JAVA_HOME=/opt/deepsonar/jdks/21`
- Node engines：`^22.19.0 || ^24.11.0 || >=26.0.0`（继承 `deepsonar-base`，构建期校验）
- `GHIDRA_HEADLESS_MAXMEM=1536m`；Job 建议至少 4096 MiB / 2 CPU / 600 s

## 发现与手册

1. 先读 `/opt/deepsonar/manuals/index.json`，再读 REA / Ghidra / Java 章节。
2. 通过平台 `list_capabilities` / `describe_capability` 确认 `binary.rea.cli` 已准入并冻结进 Job。
3. 调用前执行 `reverse-env.sh --check` 或 `rea doctor --provider ghidra --json`。

## 推荐 CLI（provider=ghidra）

对绝对路径样本使用 `--json`，优先复用一次 `function` dossier，限制追踪深度与返回体积：

```bash
mkdir -p /workspace/analysis
rea analyze /workspace/sample --provider ghidra --json > /workspace/analysis/analyze.json
rea search /workspace/sample "strcpy" --provider ghidra --json > /workspace/analysis/search.json
rea function /workspace/sample main --provider ghidra --json > /workspace/analysis/function.json
# 地址必须来自本次样本的分析结果，不复制示例地址。
rea decompile /workspace/sample main --provider ghidra --json > /workspace/analysis/decompile.json
rea instructions /workspace/sample main --provider ghidra --json > /workspace/analysis/instructions.json
rea xrefs /workspace/sample main --provider ghidra --json > /workspace/analysis/xrefs.json
rea trace-native-values /workspace/sample main --provider ghidra --max-depth 1 --max-functions 4 --max-call-sites 16 --max-nodes 128 --max-edges 256 --limit 32 --json > /workspace/analysis/trace.json
jq -c '{source:{kind:"inline",evidence:.},view:{kind:"native",facet:"value_flow_summary",offset:0,limit:32}}' /workspace/analysis/function.json > /workspace/analysis/view.json
rea inspect-analysis-view /workspace/analysis/view.json --json > /workspace/analysis/view-result.json
```

先保存完整原始文件，再按已返回的分页范围读取视图；不要把大段 JSON 直接塞入模型上下文。记录退出码、输出字节数和实际截断标记；超时/取消/部分 JSON 也必须在清理前归档。`main` 是公开样本的函数名，真实目标先用 `analyze`/`search` 取得有效符号或地址。

可用 `--snapshot /workspace/analysis/sample.json` 复用精确查询缓存；快照不是持久 Ghidra 工程数据库。

## 证据与语义边界

在沙箱清理前保留：原始 JSON、脱敏 stderr、退出码、截断/部分完成标记、分析限制、样本 SHA-256、Job/Attempt、工具版本、镜像 digest、脱敏 argv。失败/取消/超时也归档已取得片段；未完成结果不得解释为成功。

伪代码与静态值流 **不等于** 原始源码、动态证明或已验证漏洞。CLI 输出只作 Evidence/Fact 输入（`is_finding: false`），Finding 须走独立 Verify。



## amd64 实测摘要（#718 PR2）

主机 scratch 工具链（非已发布 OCI digest；本机无 docker）对公开可复现样本 `agent-harness/fixtures/reverse-sample/sample.c` 的实测见 `agent-harness/reverse-amd64-measurements.json`：

- 冷启动 `analyze` ≈ 13s；带 `--snapshot` 的重复 `analyze` ≈ 1.6s
- `function` / `decompile` / `instructions` / `xrefs` / `search` ≈ 12–13s（仍可能重新导入）
- 有界 `trace-native-values` ≈ 18s（**不**支持 `--snapshot`）
- `inspect-analysis-view` 需 `{source:{kind:"inline",evidence},view:{kind:"native",facet,...}}`，≈ 1.3s
- 峰值 java+node RSS ≈ 3.5 GiB（`GHIDRA_HEADLESS_MAXMEM=1536m`）→ Job 建议内存 **≥ 4096 MiB**
- SIGTERM 取消 ≈ 4.3s 返回 `cancelled`，无残留 `java`
- 历史记录不代表 OCI/arm64 已通过。当前 `reverse-runtime` 与 release 原生双架构门禁以 `reverse-native-evidence-<arch>` 的 `measurements.json` 记录实测 `docker save | gzip` 字节、资源和取消证据；无成功记录不得宣称通过。预算上限 **2800 MiB**，禁止用组件体积冒充镜像实测。

## 归档后经 Control API 提交 Fact

`binary.rea-cli` 扩展只接受已发布的 `evidence_key`。不要把 CLI stdout 当语义事件；不要自行填写 verified/confirmed。先读取 `/workspace/.deepsonar/runtime-manifest.json` 的 `job_id`、`attempt_id`、`runtime_image.digest` 与 `cli_capabilities`，缺失/未冻结立即停止。下例把一次 `function` 调用保存为版本化、agent-reported 观察；样本路径和函数须换成当前目标。

```bash
mkdir -p /workspace/evidence
set +e
timeout --signal=TERM --kill-after=10s 180s rea function /workspace/sample main --provider ghidra --json > /workspace/evidence/rea.stdout 2> /workspace/evidence/rea.stderr
printf '%s' "$?" > /workspace/evidence/rea.exit
set -e
python3 - <<'PYARCHIVE'
import hashlib, json, os, subprocess
from pathlib import Path
w = Path('/workspace')
m = json.loads((w / '.deepsonar/runtime-manifest.json').read_text())
c = next(x for x in m['cli_capabilities'] if x['id'] == 'binary.rea.cli')
assert m['job_id'] and m['attempt_id'] and c['image_key'] == 'deepsonar-reverse'
assert c['limits']['timeout_ms'] >= 180000
cap = min(c['limits']['max_output_bytes'], 4194304)
def capture(name):
    with (w / ('evidence/rea.' + name)).open('rb') as f:
        raw = f.read(cap + 1)
    truncated = len(raw) > cap
    text = raw[:cap].decode('utf-8', errors='replace')
    for key in ('DEEPSONAR_API_TOKEN', 'DEEPSONAR_GATEWAY_TOKEN'):
        if os.environ.get(key): text = text.replace(os.environ[key], '[REDACTED]')
    return text, truncated
stdout, out_cut = capture('stdout')
stderr, err_cut = capture('stderr')
code = int((w / 'evidence/rea.exit').read_text())
java = subprocess.run(['java', '-version'], capture_output=True, text=True, check=True)
archive = {
  'schema': 'deepsonar.rea-observation/v1', 'job_id': m['job_id'], 'attempt_id': m['attempt_id'],
  'operation': 'function', 'sample_path': '/workspace/sample',
  'sample_sha256': hashlib.sha256((w / 'sample').read_bytes()).hexdigest(),
  'image_digest': m['runtime_image']['digest'],
  'tool_versions': {'rea': '6.4.0', 'ghidra': '12.1.4', 'java': (java.stderr + java.stdout).splitlines()[0][:100]},
  'argv': ['rea', 'function', '/workspace/sample', 'main', '--provider', 'ghidra', '--json'],
  'exit_code': code, 'stdout': stdout, 'stderr': stderr,
  'stdout_truncated': out_cut, 'stderr_truncated': err_cut, 'timed_out': code == 124, 'cancelled': False,
  'analysis_limits': {'timeout_ms': 180000, 'max_output_bytes': cap, 'note': 'Static function observation only; no dynamic exploit or independent verification.'}
}
(w / 'evidence/observation.json').write_text(json.dumps(archive))
key = 'rea/' + m['job_id'] + '/observation.json'
(w / 'evidence/publish.json').write_text(json.dumps({'scope': 'project', 'source_path': '/workspace/evidence/observation.json', 'key': key, 'content_type': 'application/json'}))
(w / 'evidence/fact.json').write_text(json.dumps({'title': 'REA static observation', 'description': 'Static output archived for independent evaluation.', 'artifact': {'extensions': {'binary.rea-cli': {'evidence_key': key}}}}))
PYARCHIVE
```

按强制注入的 `deepsonar-control` Skill，使用当前 Job 的 `DEEPSONAR_API_BASE_URL` / 短期 token / 新 Idempotency-Key：

1. POST `/operations/publish_shared_asset`，JSON body 为 `evidence/publish.json`；确认 `accepted: true`。
2. POST `/operations/emit_fact`，JSON body 为 `evidence/fact.json`；确认 `accepted: true`，失败读 RepairFeedback，不能换控制通道。
3. Host 按同一项目/Job/活动 Attempt 校验已归档的 CAS 内容摘要、冻结镜像/能力/预算，生成 claim/evidence 均为 `unknown` 的 Fact/Artifact；这证明归档完整性与归属，不证明 agent-reported 输出真实执行，更不证明漏洞成立。独立 Verify 另行取证。

长任务应在 Job 仍运行时主动发布前缀 checkpoint：`exit_code: null`、真实截断标记和限制；随后成功再发布完整版本。Job 已取消/超时后 token 会撤销，不能承诺此时补传；已归档前缀保持 inconclusive。上面的 `timeout` 只管该次调用；最终硬控制、取消和资源回收由 Scheduler/OpenSandbox 执行。归档前同时去除输出/argv 中其它已知敏感信息，不要把 token、凭据或完整进程环境放入 Evidence。

## 失败纪律

- 镜像未准入 / 能力未冻结 / 冻结快照不可解析 → 结构化 `capability_unavailable`，禁止临时 `npm i` / 扩大网络。
- 缺 native decompiler 或 `rea doctor` 失败 → 按角色证据边界报告，不得用 binutils/radare2 叙述冒充 REA/Ghidra 深度结果。
- 硬控制沿用 Job 沙箱 CPU/内存/PIDs、网络策略、deadline、取消与 Reaper；薄 launcher 不提供不可绕过的累计调用计数器。
