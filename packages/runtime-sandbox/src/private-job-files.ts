import { randomUUID } from "node:crypto";
import { shellQuote, type RuntimeHost } from "./runtime-host.js";

const PRIVATE_FILE_NAMES = new Set(["control-token", "gateway-token", "om-token", "pi-auth.json"]);

/** Descriptor-relative writes. Secrets arrive through live stdin, never SDK uploads. */
export const PRIVATE_JOB_FILES_SCRIPT = String.raw`
import json, os, re, stat, sys

def reject():
    raise ValueError("PRIVATE_JOB_FILES_REJECTED")

def directory_info(fd, private=False):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode): reject()
    if private and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700): reject()
    return info

def file_info(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: reject()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600: reject()
    return info

def same_entry(parent, name, fd):
    entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
    owned = os.fstat(fd)
    return (entry.st_dev, entry.st_ino) == (owned.st_dev, owned.st_ino)

def rollback_files(parent, entries):
    # Only names created by this invocation, relative to its still-open directory.
    # A replaced name is never followed, truncated or unlinked.
    for name, fd in reversed(entries):
        try:
            os.ftruncate(fd, 0)
            os.fsync(fd)
            if same_entry(parent, name, fd): os.unlink(name, dir_fd=parent)
        except OSError: pass

def main():
    root, operation, identity = sys.argv[1:]
    if not re.fullmatch(r"[a-f0-9-]{36}", identity): reject()
    if operation not in ("create", "check", "cleanup", "pi-auth"): reject()
    if not root.startswith("/") or root == "/" or any(p in ("", ".", "..") for p in root.split("/")[1:]): reject()
    payload = sys.stdin.buffer.readline(4 * 1024 * 1024 + 1)
    if not payload.endswith(b"\n") or len(payload) > 4 * 1024 * 1024: reject()
    files = json.loads(payload)
    names = {"control-token", "gateway-token", "om-token", "pi-auth.json"}
    if not isinstance(files, dict) or not files or not set(files).issubset(names): reject()
    if any(not isinstance(value, str) or "\x00" in value for value in files.values()): reject()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open("/", flags)
    try:
        for part in root.split("/")[1:]:
            child = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = child
            directory_info(current)
        parent = os.fstat(current)
        if parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) & 0o022: reject()
        name = ".deepsonar-credentials-" + identity
        if operation == "create":
            os.mkdir(name, 0o700, dir_fd=current)
        private = os.open(name, flags, dir_fd=current)
        created = []
        try:
            directory_info(private, True)
            if operation == "create":
                for filename, value in files.items():
                    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=private)
                    created.append((filename, fd))
                    file_info(fd)
                    data = value.encode("utf-8")
                    while data:
                        written = os.write(fd, data)
                        if written <= 0: reject()
                        data = data[written:]
                    os.fsync(fd)
                    file_info(fd)
                os.fsync(private)
            if operation == "pi-auth":
                source = os.open("pi-auth.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=private)
                try:
                    info = file_info(source)
                    if info.st_size > 4 * 1024 * 1024: reject()
                    data = os.read(source, info.st_size + 1)
                    if len(data) != info.st_size: reject()
                finally:
                    os.close(source)
                target = os.dup(current)
                try:
                    for part in (".deepsonar-home", ".pi", "agent"):
                        try: os.mkdir(part, 0o700, dir_fd=target)
                        except FileExistsError: pass
                        child = os.open(part, flags, dir_fd=target)
                        os.close(target)
                        target = child
                        entry = directory_info(target)
                        if entry.st_uid != os.geteuid() or stat.S_IMODE(entry.st_mode) & 0o022: reject()
                    fd = os.open("auth.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=target)
                    try:
                        file_info(fd)
                        while data:
                            written = os.write(fd, data)
                            if written <= 0: reject()
                            data = data[written:]
                        os.fsync(fd)
                        file_info(fd)
                    except Exception:
                        rollback_files(target, [("auth.json", fd)])
                        raise
                    finally:
                        os.close(fd)
                finally:
                    os.close(target)
            # Validate every entry before cleanup, including inode identity.
            if set(os.listdir(private)) != set(files): reject()
            for filename in files:
                fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=private)
                try:
                    info = file_info(fd)
                    entry = os.stat(filename, dir_fd=private, follow_symlinks=False)
                    if (info.st_dev, info.st_ino) != (entry.st_dev, entry.st_ino): reject()
                finally:
                    os.close(fd)
            directory_info(private, True)
            entry = os.stat(name, dir_fd=current, follow_symlinks=False)
            info = os.fstat(private)
            if (entry.st_dev, entry.st_ino) != (info.st_dev, info.st_ino): reject()
            if operation == "cleanup":
                for filename in files:
                    os.unlink(filename, dir_fd=private)
                os.rmdir(name, dir_fd=current)
            print("ok", flush=True)
        except Exception:
            if operation == "create":
                rollback_files(private, created)
                try:
                    if same_entry(current, name, private): os.rmdir(name, dir_fd=current)
                except OSError: pass
            raise
        finally:
            for _, fd in created: os.close(fd)
            os.close(private)
    finally:
        os.close(current)

try:
    os.umask(0o077)
    main()
except Exception:
    print("PRIVATE_JOB_FILES_REJECTED", file=sys.stderr)
    sys.exit(1)
`;

export interface PrivateJobFiles {
  directory: string;
  paths: Record<string, string>;
  check(): Promise<void>;
  cleanup(): Promise<void>;
  installPiAuth(): Promise<void>;
}

export function privateCredentialEnvironment(
  environment: Record<string, string>,
  files: Pick<PrivateJobFiles, "paths">,
): Record<string, string> {
  const result = { ...environment };
  for (const key of ["DEEPSONAR_API_TOKEN", "DEEPSONAR_GATEWAY_TOKEN", "DEEPSONAR_OM_GATEWAY_TOKEN",
    "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "OTEL_EXPORTER_OTLP_HEADERS"]) delete result[key];
  for (const [filename, key] of [["control-token", "DEEPSONAR_CONTROL_TOKEN_FILE"],
    ["gateway-token", "DEEPSONAR_GATEWAY_TOKEN_FILE"], ["om-token", "DEEPSONAR_OM_GATEWAY_TOKEN_FILE"]] as const) {
    const file = files.paths[filename];
    if (file) result[key] = file;
  }
  return result;
}

async function runPrivateFileProtocol(
  host: RuntimeHost,
  operation: "create" | "check" | "cleanup" | "pi-auth",
  identity: string,
  files: Record<string, string>,
): Promise<void> {
  const command = `python3 -c ${shellQuote(PRIVATE_JOB_FILES_SCRIPT)} /workspace ${operation} ${identity}`;
  const process = await host.runAsync(command, { pty: false, diagnosticSecrets: Object.values(files) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = (async () => {
      let output = "";
      let exited = false;
      const consume = (async () => {
        for await (const chunk of process) {
          if (chunk.type === "exit") {
            exited = true;
            if (chunk.exitCode !== 0) throw new Error("PRIVATE_JOB_FILES_REJECTED");
          } else if (chunk.type === "stdout") {
            output += chunk.chunk;
            if (output.length > 128) throw new Error("PRIVATE_JOB_FILES_REJECTED");
          }
        }
        if (!exited || output !== "ok\n") throw new Error("PRIVATE_JOB_FILES_REJECTED");
      })();
      await Promise.all([consume, process.write(`${JSON.stringify(files)}\n`)]);
    })();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("PRIVATE_JOB_FILES_REJECTED")), 15_000);
    });
    await Promise.race([completion, deadline]);
  } catch {
    await process.kill().catch(() => {});
    throw new Error("PRIVATE_JOB_FILES_REJECTED");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function materializePrivateJobFiles(host: RuntimeHost, files: Record<string, string>): Promise<PrivateJobFiles> {
  const names = Object.keys(files);
  if (!names.length || names.some(name => !PRIVATE_FILE_NAMES.has(name))) throw new Error("PRIVATE_JOB_FILES_REJECTED");
  const identity = randomUUID();
  const directory = `/workspace/.deepsonar-credentials-${identity}`;
  await runPrivateFileProtocol(host, "create", identity, files);
  const entries = Object.fromEntries(names.map(name => [name, ""]));
  return {
    directory,
    paths: Object.fromEntries(names.map(name => [name, `${directory}/${name}`])),
    check: () => runPrivateFileProtocol(host, "check", identity, entries),
    cleanup: () => runPrivateFileProtocol(host, "cleanup", identity, entries),
    installPiAuth: () => runPrivateFileProtocol(host, "pi-auth", identity, entries),
  };
}
