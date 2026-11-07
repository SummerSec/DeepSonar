import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyBaseCliInstall } from "./base-cli-install.mjs";

const frozen = JSON.parse(readFileSync(new URL("./base-cli-lifecycle.json", import.meta.url), "utf8"));
const productionLock = JSON.parse(readFileSync(new URL("./base-cli-runtime/package-lock.json", import.meta.url), "utf8"));
const wrapperName = "@anthropic-ai/claude-code";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const writeJson = (path, value) => write(path, JSON.stringify(value));
const nativeEntry = (input, targetarch) => {
  const native = input.nativePackages[targetarch];
  const version = input.hooks[wrapperName].version;
  return { version, resolved: `https://registry.npmjs.org/${native.name}/-/${native.name.split("/").at(-1)}-${version}.tgz`,
    integrity: native.integrity, os: ["linux"], cpu: [native.arch], libc: ["glibc"], optional: true };
};

function fixture(t, targetarch = "amd64") {
  const directory = mkdtempSync(join(tmpdir(), "deepsonar-base-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const globalRoot = join(directory, "global");
  const binRoot = join(directory, "bin");
  const input = structuredClone(frozen);
  const packages = { "": { name: "fixture", dependencies: { [wrapperName]: input.hooks[wrapperName].version } } };
  for (const [name, hook] of Object.entries(input.hooks)) {
    packages[`node_modules/${name}`] = { version: hook.version, hasInstallScript: true };
    for (const file of Object.keys(hook.files)) {
      const bytes = `throw new Error("must never execute fixture ${name}/${file}");\n`;
      hook.files[file] = hash(bytes);
      write(join(globalRoot, name, file), bytes);
    }
  }
  const wrapperLock = packages[`node_modules/${wrapperName}`];
  wrapperLock.bin = { claude: "bin/claude.exe" };
  wrapperLock.optionalDependencies = structuredClone(productionLock.packages[`node_modules/${wrapperName}`].optionalDependencies);
  for (const architecture of ["amd64", "arm64"]) {
    packages[`node_modules/${input.nativePackages[architecture].name}`] = nativeEntry(input, architecture);
  }
  // Include a non-hook dependency and a nested copy to exercise exact installation paths.
  for (const path of ["node_modules/plain", "node_modules/plain/node_modules/nested"]) packages[path] = { version: "1.0.0" };
  const native = input.nativePackages[targetarch];
  for (const [path, entry] of Object.entries(packages)) {
    if (!path || (entry.optional && !entry.cpu.includes(native.arch))) continue;
    const name = path.split("node_modules/").at(-1);
    const manifest = { name, version: entry.version };
    if (input.hooks[name]) manifest.scripts = structuredClone(input.hooks[name].scripts);
    if (name === wrapperName) Object.assign(manifest, { bin: wrapperLock.bin, optionalDependencies: wrapperLock.optionalDependencies });
    if (entry.optional) Object.assign(manifest, { os: entry.os, cpu: entry.cpu, libc: entry.libc });
    writeJson(join(globalRoot, path.slice("node_modules/".length), "package.json"), manifest);
  }
  const source = join(globalRoot, native.name, "claude");
  const destination = join(globalRoot, wrapperName, "bin/claude.exe");
  // Tiny arbitrary bytes are compared, never executed and never mistaken for an ELF-size test.
  write(source, `offline native bytes for ${native.arch}\n`);
  chmodSync(source, 0o755);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  mkdirSync(join(globalRoot, ".bin"), { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  symlinkSync("../@anthropic-ai/claude-code/bin/claude.exe", join(globalRoot, ".bin/claude"));
  symlinkSync(join(globalRoot, ".bin/claude"), join(binRoot, "claude"));
  const options = { globalRoot, binRoot, targetarch, frozen: input, lock: { lockfileVersion: 3, packages },
    runtime: { platform: "linux", arch: native.arch, glibc: "2.36" } };
  return { ...options, options, source, destination, native,
    verify: () => verifyBaseCliInstall(options),
    manifest(name, change) {
      const path = join(globalRoot, name, "package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      change(manifest);
      writeJson(path, manifest);
    },
  };
}

const rejects = (f, code) => assert.rejects(f.verify(), error => {
  assert.ok(error.message.startsWith(`${code}: `), error.message);
  return true;
});

test("production lifecycle identities match all install-script entries in the complete lock", () => {
  assert.deepEqual(frozen.hooks, {
    "@anthropic-ai/claude-code": { version: "2.1.312", scripts: { postinstall: "node install.cjs" },
      files: { "install.cjs": "32a7b2429d7447c5aa043e383bcf9a72e0b233dff66336ea4b5b32531da981ad" } },
    "@google/genai": { version: "2.21.0", scripts: { preinstall: "echo 'preinstall: no-op'" }, files: {} },
    protobufjs: { version: "7.6.6", scripts: { postinstall: "node scripts/postinstall" },
      files: { "scripts/postinstall.js": "5af8463b97ee8e309b4a2111f9479bacdf0c180de0ca0155527679b1fc6d9e6c" } },
  });
  assert.equal(productionLock.lockfileVersion, 3);
  assert.deepEqual(Object.entries(productionLock.packages).filter(([, entry]) => entry.hasInstallScript)
    .map(([path]) => path).sort(), Object.keys(frozen.hooks).map(name => `node_modules/${name}`).sort());
  for (const [name, hook] of Object.entries(frozen.hooks)) {
    assert.equal(productionLock.packages[`node_modules/${name}`].version, hook.version);
  }
  const root = JSON.parse(readFileSync(new URL("./base-cli-runtime/package.json", import.meta.url), "utf8"));
  assert.equal(root.private, true);
  assert.equal(root.scripts, undefined, "registry installs must not run root prepare/publish scripts");
  assert.equal(root.dependencies[wrapperName], frozen.hooks[wrapperName].version);
});

test("production locked native identities and all wrapper optional dependencies remain exactly audited", () => {
  assert.deepEqual(frozen.nativePackages, {
    amd64: { name: "@anthropic-ai/claude-code-linux-x64", arch: "x64",
      integrity: "sha512-oj55HL9uasLWzym5eZNgC8xyk0N0H4hw8WdN0DeDuAlquhs2d4hhkQVZcRKvJarBB37IU9bbEGXZwtuhsex6EQ==" },
    arm64: { name: "@anthropic-ai/claude-code-linux-arm64", arch: "arm64",
      integrity: "sha512-2BYrAYcr5q9mG/7qD8NN8Mnh8YLvW1cj6O9WjLXHh4OoraA+vjwAYkP7dMyGXQ/nQW/ydw483j8G91dmsMBXPA==" },
  });
  const wrapper = productionLock.packages[`node_modules/${wrapperName}`];
  assert.deepEqual(wrapper.bin, { claude: "bin/claude.exe" });
  assert.deepEqual(wrapper.optionalDependencies, Object.fromEntries([
    "darwin-arm64", "darwin-x64", "linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-musl", "win32-arm64", "win32-x64",
  ].map(suffix => [`${wrapperName}-${suffix}`, "2.1.312"])));
  for (const targetarch of ["amd64", "arm64"]) {
    const native = frozen.nativePackages[targetarch];
    const entry = productionLock.packages[`node_modules/${native.name}`];
    for (const [key, value] of Object.entries(nativeEntry(frozen, targetarch))) assert.deepEqual(entry[key], value, `${native.name}.${key}`);
    assert.equal(wrapper.optionalDependencies[native.name], entry.version);
  }
  // These are static lock/JSON audits, not a claim that real vendor bytes were checked offline.
});

for (const targetarch of ["amd64", "arm64"]) {
  test(`offline ${targetarch} metadata succeeds with copied bytes on different inodes`, async t => {
    const f = fixture(t, targetarch);
    assert.notEqual(statSync(f.source).ino, statSync(f.destination).ino);
    f.manifest("plain", manifest => { manifest.scripts = { prepare: "not run", prepublish: "not run", publish: "not run" }; });
    await f.verify();
  });
}

for (const [label, change] of [
  ["unknown target", f => { f.options.targetarch = "riscv64"; }],
  ["unknown prototype target", f => { f.options.targetarch = "__proto__"; }],
  ["target/runtime arch mismatch", f => { f.runtime.arch = "arm64"; }],
  ["non-linux", f => { f.runtime.platform = "darwin"; }],
  ["musl or missing glibc", f => { delete f.runtime.glibc; }],
]) {
  test(`rejects ${label}`, async t => {
    const f = fixture(t); change(f); await rejects(f, "BASE_CLI_PLATFORM_MISMATCH");
  });
}

for (const [label, change, code] of [
  ["missing selected native package", f => rmSync(dirname(f.source), { recursive: true }), "BASE_CLI_NATIVE_MISSING"],
  ["chmodded 500-byte wrapper placeholder", f => writeFileSync(f.destination, Buffer.alloc(500, 32)), "BASE_CLI_NATIVE_HASH_MISMATCH"],
  ["changed native bytes", f => writeFileSync(f.source, "changed"), "BASE_CLI_NATIVE_HASH_MISMATCH"],
  ["missing native entry", f => rmSync(f.source), "BASE_CLI_ENTRY_MISSING"],
  ["missing wrapper entry", f => rmSync(f.destination), "BASE_CLI_ENTRY_MISSING"],
  ["non-executable wrapper", f => chmodSync(f.destination, 0o644), "BASE_CLI_ENTRY_INVALID"],
  ["non-executable native", f => chmodSync(f.source, 0o644), "BASE_CLI_ENTRY_INVALID"],
  ["symlink wrapper instead of ordinary file", f => { rmSync(f.destination); symlinkSync(f.source, f.destination); }, "BASE_CLI_ENTRY_INVALID"],
  ["symlink native instead of ordinary file", f => { rmSync(f.source); symlinkSync(f.destination, f.source); }, "BASE_CLI_ENTRY_INVALID"],
  ["directory wrapper instead of ordinary file", f => { rmSync(f.destination); mkdirSync(f.destination); }, "BASE_CLI_ENTRY_INVALID"],
  ["changed wrapper bin mapping", f => f.manifest(wrapperName, m => { m.bin.claude = "install.cjs"; }), "BASE_CLI_ENTRY_INVALID"],
  ["changed native manifest name", f => f.manifest(f.native.name, m => { m.name = "wrong"; }), "BASE_CLI_NAME_MISMATCH"],
  ["changed native manifest version", f => f.manifest(f.native.name, m => { m.version = "0.0.0"; }), "BASE_CLI_VERSION_MISMATCH"],
  ["changed wrapper manifest version", f => f.manifest(wrapperName, m => { m.version = "0.0.0"; }), "BASE_CLI_VERSION_MISMATCH"],
  ["changed nested manifest version", f => f.manifest("plain/node_modules/nested", m => { m.version = "0.0.0"; }), "BASE_CLI_VERSION_MISMATCH"],
  ["changed installed native arch", f => f.manifest(f.native.name, m => { m.cpu = ["arm64"]; }), "BASE_CLI_NATIVE_IDENTITY_MISMATCH"],
  ["changed installed native libc", f => f.manifest(f.native.name, m => { m.libc = ["musl"]; }), "BASE_CLI_NATIVE_IDENTITY_MISMATCH"],
  ["changed installed native OS", f => f.manifest(f.native.name, m => { m.os = ["win32"]; }), "BASE_CLI_NATIVE_IDENTITY_MISMATCH"],
  ["changed installed optional dependency version", f => f.manifest(wrapperName, m => { m.optionalDependencies[f.native.name] = "0.0.0"; }), "BASE_CLI_NATIVE_IDENTITY_MISMATCH"],
  ["extra installed optional dependency", f => f.manifest(wrapperName, m => { m.optionalDependencies.extra = "1.0.0"; }), "BASE_CLI_NATIVE_IDENTITY_MISMATCH"],
]) {
  test(`rejects ${label}`, async t => {
    const f = fixture(t); change(f); await rejects(f, code);
  });
}

for (const key of ["name", "version", "resolved", "integrity", "os", "cpu", "libc", "optional"]) {
  test(`rejects changed locked native ${key}`, async t => {
    const f = fixture(t);
    f.lock.packages[`node_modules/${f.native.name}`][key] = key === "optional" ? false : "changed";
    await rejects(f, "BASE_CLI_NATIVE_IDENTITY_MISMATCH");
  });
}

test("rejects missing selected native lock and changed locked optionalDependency", async t => {
  const absent = fixture(t);
  delete absent.lock.packages[`node_modules/${absent.native.name}`];
  await rejects(absent, "BASE_CLI_NATIVE_IDENTITY_MISMATCH");
  const changed = fixture(t);
  changed.lock.packages[`node_modules/${wrapperName}`].optionalDependencies[changed.native.name] = "0.0.0";
  await rejects(changed, "BASE_CLI_NATIVE_IDENTITY_MISMATCH");
});

for (const [label, change, code] of [
  ["new lock hook", f => { f.lock.packages["node_modules/plain"].hasInstallScript = true; }, "BASE_CLI_HOOK_MISMATCH"],
  ["removed lock hook", f => { delete f.lock.packages[`node_modules/${wrapperName}`].hasInstallScript; }, "BASE_CLI_HOOK_MISMATCH"],
  ["changed locked hook version", f => { f.lock.packages["node_modules/@google/genai"].version = "0.0.0"; }, "BASE_CLI_VERSION_MISMATCH"],
  ["changed hook command", f => f.manifest(wrapperName, m => { m.scripts.postinstall = "node changed.cjs"; }), "BASE_CLI_HOOK_MISMATCH"],
  ["removed hook command", f => f.manifest("protobufjs", m => { delete m.scripts.postinstall; }), "BASE_CLI_HOOK_MISMATCH"],
  ["extra hook command", f => f.manifest("@google/genai", m => { m.scripts.install = "echo unexpected"; }), "BASE_CLI_HOOK_MISMATCH"],
  ["new installed hook without lock flag", f => f.manifest("plain", m => { m.scripts = { preinstall: "echo unexpected" }; }), "BASE_CLI_HOOK_MISMATCH"],
  ["changed Claude hook bytes", f => writeFileSync(join(f.globalRoot, wrapperName, "install.cjs"), "changed"), "BASE_CLI_SCRIPT_HASH_MISMATCH"],
  ["changed protobuf hook bytes", f => writeFileSync(join(f.globalRoot, "protobufjs/scripts/postinstall.js"), "changed"), "BASE_CLI_SCRIPT_HASH_MISMATCH"],
  ["missing audited script", f => rmSync(join(f.globalRoot, wrapperName, "install.cjs")), "BASE_CLI_SCRIPT_MISSING"],
]) {
  test(`rejects ${label}`, async t => {
    const f = fixture(t); change(f); await rejects(f, code);
  });
}

for (const which of ["global", "PATH"]) {
  for (const target of ["deleted-staging", "native-instead-of-wrapper"]) {
    test(`rejects ${which} link to ${target}`, async t => {
      const f = fixture(t);
      const link = which === "global" ? join(f.globalRoot, ".bin/claude") : join(f.binRoot, "claude");
      rmSync(link);
      symlinkSync(target === "deleted-staging" ? join(f.globalRoot, "deleted-staging/claude") : f.source, link);
      await rejects(f, "BASE_CLI_LINK_INVALID");
    });
  }
}
