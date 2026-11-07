import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const wrapperName = "@anthropic-ai/claude-code";
const lifecycle = ["preinstall", "install", "postinstall"];
const fail = (code, detail) => { throw new Error(`${code}: ${detail}`); };
const equal = (actual, expected, code, detail) => {
  if (!isDeepStrictEqual(actual, expected)) fail(code, detail);
};
async function json(path, code) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { fail(code, path); }
}
async function digest(path, code) {
  try {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return hash.digest("hex");
  } catch { fail(code, path); }
}
async function executable(path) {
  let stat;
  try { stat = await lstat(path); } catch { fail("BASE_CLI_ENTRY_MISSING", path); }
  if (!stat.isFile() || !(stat.mode & 0o111)) fail("BASE_CLI_ENTRY_INVALID", path);
}

// Only JSON, filesystem metadata and streamed bytes are inspected; no package code is loaded.
export async function verifyBaseCliInstall({ globalRoot, lock, binRoot, targetarch, frozen, runtime }) {
  const arch = targetarch === "amd64" ? "x64" : targetarch === "arm64" ? "arm64" : undefined;
  if (!arch || runtime.platform !== "linux" || runtime.arch !== arch || !runtime.glibc) {
    fail("BASE_CLI_PLATFORM_MISMATCH", `${targetarch}/${runtime.platform}/${runtime.arch}`);
  }
  const packages = lock.packages;
  const hooks = frozen.hooks;
  equal(Object.keys(packages).filter(path => packages[path].hasInstallScript).sort(),
    Object.keys(hooks).map(name => `node_modules/${name}`).sort(), "BASE_CLI_HOOK_MISMATCH", "lock hook inventory");
  for (const [name, hook] of Object.entries(hooks)) {
    equal(packages[`node_modules/${name}`]?.version, hook.version, "BASE_CLI_VERSION_MISMATCH", name);
  }
  const native = frozen.nativePackages[targetarch];
  const version = hooks[wrapperName].version;
  const nativeLock = packages[`node_modules/${native.name}`];
  const expected = {
    version, resolved: `https://registry.npmjs.org/${native.name}/-/${native.name.split("/").at(-1)}-${version}.tgz`,
    integrity: native.integrity, os: ["linux"], cpu: [arch], libc: ["glibc"], optional: true,
  };
  if (native.name !== `${wrapperName}-linux-${arch}` || native.arch !== arch || !nativeLock) {
    fail("BASE_CLI_NATIVE_IDENTITY_MISMATCH", targetarch);
  }
  for (const [key, value] of Object.entries(expected)) {
    equal(nativeLock[key], value, "BASE_CLI_NATIVE_IDENTITY_MISMATCH", `${native.name}.${key}`);
  }
  if (nativeLock.name !== undefined) equal(nativeLock.name, native.name, "BASE_CLI_NATIVE_IDENTITY_MISMATCH", "name");
  const wrapperLock = packages[`node_modules/${wrapperName}`];
  equal(wrapperLock.optionalDependencies?.[native.name], version, "BASE_CLI_NATIVE_IDENTITY_MISMATCH", "optionalDependencies");
  const nativeRoot = join(globalRoot, native.name);
  const nativeManifest = await json(join(nativeRoot, "package.json"), "BASE_CLI_NATIVE_MISSING");
  for (const key of ["os", "cpu", "libc"]) {
    equal(nativeManifest[key], expected[key], "BASE_CLI_NATIVE_IDENTITY_MISMATCH", `installed ${key}`);
  }
  let wrapper;
  for (const [path, entry] of Object.entries(packages)) {
    if (!path) continue;
    if (entry.optional && [["os", "linux"], ["cpu", arch], ["libc", "glibc"]]
      .some(([key, value]) => entry[key] && !entry[key].includes(value))) continue;
    const name = path.split("node_modules/").at(-1);
    const directory = join(globalRoot, path.slice("node_modules/".length));
    const manifest = await json(join(directory, "package.json"), "BASE_CLI_MANIFEST_INVALID");
    equal(manifest.name, name, "BASE_CLI_NAME_MISMATCH", path);
    equal(manifest.version, entry.version, "BASE_CLI_VERSION_MISMATCH", path);
    const scripts = Object.fromEntries(lifecycle.filter(key => Object.hasOwn(manifest.scripts ?? {}, key))
      .map(key => [key, manifest.scripts[key]]));
    const hook = hooks[name];
    equal(scripts, hook?.scripts ?? {}, "BASE_CLI_HOOK_MISMATCH", path);
    for (const [file, hash] of Object.entries(hook?.files ?? {})) {
      equal(await digest(join(directory, file), "BASE_CLI_SCRIPT_MISSING"), hash, "BASE_CLI_SCRIPT_HASH_MISMATCH", `${name}/${file}`);
    }
    if (name === wrapperName) wrapper = manifest;
  }
  equal(wrapper.bin, { claude: "bin/claude.exe" }, "BASE_CLI_ENTRY_INVALID", "wrapper bin");
  equal(wrapper.optionalDependencies, wrapperLock.optionalDependencies, "BASE_CLI_NATIVE_IDENTITY_MISMATCH", "installed optionalDependencies");
  const source = join(nativeRoot, "claude");
  const destination = join(globalRoot, wrapperName, "bin/claude.exe");
  await executable(source);
  await executable(destination);
  equal(await digest(destination, "BASE_CLI_ENTRY_INVALID"), await digest(source, "BASE_CLI_ENTRY_INVALID"),
    "BASE_CLI_NATIVE_HASH_MISMATCH", "wrapper/native bytes");
  const expectedPath = join(await realpath(globalRoot), wrapperName, "bin/claude.exe");
  equal(await realpath(destination), expectedPath, "BASE_CLI_LINK_INVALID", destination);
  for (const link of [join(globalRoot, ".bin/claude"), join(binRoot, "claude")]) {
    let actual;
    try { actual = await realpath(link); } catch { fail("BASE_CLI_LINK_INVALID", link); }
    equal(actual, expectedPath, "BASE_CLI_LINK_INVALID", link);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6) fail("BASE_CLI_ARGUMENTS_INVALID", "GLOBAL_ROOT LOCK_PATH BIN_ROOT TARGETARCH");
    const [, , globalRoot, lockPath, binRoot, targetarch] = process.argv;
    await verifyBaseCliInstall({ globalRoot, binRoot, targetarch,
      lock: await json(lockPath, "BASE_CLI_LOCK_INVALID"),
      frozen: await json(new URL("./base-cli-lifecycle.json", import.meta.url), "BASE_CLI_FROZEN_INVALID"),
      runtime: { platform: process.platform, arch: process.arch, glibc: process.report.getReport().header.glibcVersionRuntime },
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
