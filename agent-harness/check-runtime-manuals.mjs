import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const manualsRoot = join(here, "manuals");
const catalogPath = join(manualsRoot, "catalog.json");

export const REQUIRED_MANUAL_HEADINGS = [
  "## 使用场景",
  "## 选型依据",
  "## 前置条件",
  "## 调用方式",
  "## 输出解释",
  "## 失败处理",
  "## 组合流程",
  "## 证据留存",
  "## 版本与限制",
];

export const OFFICIAL_RUNTIME_IMAGE_KEYS = [
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-chrome-test",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-fuzz",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-fuzz",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-mobile",
];

function read(path) {
  return readFileSync(path, "utf8");
}

/** Validate #588 runtime tool manuals; returns failure strings. */
export function checkRuntimeManuals({ fingerprintPresets } = {}) {
  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  expect(existsSync(catalogPath), "agent-harness/manuals/catalog.json missing");
  if (!existsSync(catalogPath)) return failures;

  const catalog = JSON.parse(read(catalogPath));
  expect(catalog.manuals_root_in_image === "/opt/deepsonar/manuals", "catalog.manuals_root_in_image must be /opt/deepsonar/manuals");
  expect(Array.isArray(catalog.required_headings), "catalog.required_headings must be an array");
  for (const h of REQUIRED_MANUAL_HEADINGS) {
    expect(catalog.required_headings?.includes(h), `catalog.required_headings missing ${h}`);
  }

  const images = catalog.images ?? {};
  expect(Object.keys(images).length === OFFICIAL_RUNTIME_IMAGE_KEYS.length, `catalog must list exactly ${OFFICIAL_RUNTIME_IMAGE_KEYS.length} official images`);
  for (const key of OFFICIAL_RUNTIME_IMAGE_KEYS) {
    expect(Boolean(images[key]), `catalog missing image ${key}`);
  }

  for (const key of OFFICIAL_RUNTIME_IMAGE_KEYS) {
    const meta = images[key];
    if (!meta) continue;
    const imageDir = join(manualsRoot, key);
    const indexPath = join(imageDir, "INDEX.md");
    expect(existsSync(indexPath), `${key}: INDEX.md missing`);
    if (existsSync(indexPath)) {
      const index = read(indexPath);
      expect(index.includes("/opt/deepsonar/manuals"), `${key}: INDEX.md must mention in-image manuals path`);
    }

    expect(Array.isArray(meta.tools) && meta.tools.length > 0, `${key}: catalog tools must be non-empty`);
    const seen = new Set();
    for (const tool of meta.tools ?? []) {
      expect(Boolean(tool.id && tool.file), `${key}: tool entry needs id+file`);
      expect(!seen.has(tool.id), `${key}: duplicate tool id ${tool.id}`);
      seen.add(tool.id);
      const toolPath = join(imageDir, tool.file);
      expect(existsSync(toolPath), `${key}: missing ${tool.file}`);
      if (!existsSync(toolPath)) continue;
      const body = read(toolPath);
      for (const h of REQUIRED_MANUAL_HEADINGS) {
        expect(body.includes(h), `${key}/${tool.id}: missing heading ${h}`);
      }
      expect(
        /正常无结果/.test(body) && /可修正/.test(body) && /可重试/.test(body) && /缺少运行条件/.test(body),
        `${key}/${tool.id}: failure table must distinguish 正常无结果/可修正/可重试/缺少运行条件`,
      );
      expect(body.length > 400, `${key}/${tool.id}: manual too short to be actionable`);
      expect(!/仅列出工具名|see base only|TODO\(manual\)/i.test(body), `${key}/${tool.id}: stub manual rejected`);
    }

    const toolsDir = join(imageDir, "tools");
    if (existsSync(toolsDir)) {
      const catalogFiles = new Set((meta.tools ?? []).map((t) => String(t.file).replace(/^tools\//, "")));
      for (const name of readdirSync(toolsDir)) {
        if (!name.endsWith(".md")) continue;
        expect(catalogFiles.has(name), `${key}: orphan tool file tools/${name} not in catalog`);
      }
    }

    expect(typeof meta.dockerfile === "string" && meta.dockerfile.startsWith("deploy/"), `${key}: dockerfile path required`);
    if (meta.dockerfile) {
      const dfPath = join(repoRoot, meta.dockerfile);
      expect(existsSync(dfPath), `${key}: dockerfile ${meta.dockerfile} missing`);
      if (existsSync(dfPath)) {
        const df = read(dfPath);
        expect(df.includes("/opt/deepsonar/manuals"), `${key}: Dockerfile must install /opt/deepsonar/manuals`);
        if (key === "deepsonar-base" || key === "deepsonar-audit") {
          expect(df.includes("agent-harness/manuals/deepsonar-base") && df.includes("agent-harness/manuals/deepsonar-audit"), `${key}: Dockerfile.agent must COPY base and audit manuals`);
        } else {
          expect(df.includes(`agent-harness/manuals/${key}`), `${key}: Dockerfile must COPY agent-harness/manuals/${key}`);
        }
        expect(df.includes("io.deepsonar.manuals=\"/opt/deepsonar/manuals\"") || df.includes("io.deepsonar.manuals='/opt/deepsonar/manuals'"), `${key}: Dockerfile should label io.deepsonar.manuals`);
      }
    }

    if (fingerprintPresets?.[key]?.paths) {
      const paths = fingerprintPresets[key].paths;
      expect(
        paths.some((p) => p === `agent-harness/manuals/${key}` || p === "agent-harness/manuals" || p.startsWith(`agent-harness/manuals/${key}/`)),
        `${key}: fingerprint preset must include manuals path`,
      );
    }
  }

  return failures;
}

if (process.argv[1] && /check-runtime-manuals\.mjs$/.test(process.argv[1])) {
  const failures = checkRuntimeManuals();
  if (failures.length) {
    console.error(failures.map((f) => `- ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`runtime manuals gate ok (${OFFICIAL_RUNTIME_IMAGE_KEYS.length} images)`);
}
