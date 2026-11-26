
import { openSync as credentialOpen, closeSync as credentialClose, fstatSync as credentialStat,
  readFileSync as credentialRead, constants as credentialFlags } from 'node:fs';

export function readPrivateCredential(file, optional = false) {
  if (optional && file === undefined) return undefined;
  if (typeof file !== 'string' || !/^\/(?:[^/]+\/)*\.deepsonar-credentials-[a-f0-9-]{36}\/(control-token|gateway-token|om-token|pi-auth\.json)$/.test(file)
    || file.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('PRIVATE_CREDENTIAL_REJECTED');
  }
  let parent;
  let fd;
  try {
    const parts = file.split('/');
    parent = credentialOpen('/', credentialFlags.O_RDONLY | credentialFlags.O_DIRECTORY | credentialFlags.O_NOFOLLOW);
    for (let index = 1; index < parts.length - 1; index++) {
      const child = credentialOpen('/proc/self/fd/' + parent + '/' + parts[index],
        credentialFlags.O_RDONLY | credentialFlags.O_DIRECTORY | credentialFlags.O_NOFOLLOW);
      credentialClose(parent);
      parent = child;
    }
    const directory = credentialStat(parent);
    if (!directory.isDirectory() || directory.uid !== process.geteuid() || (directory.mode & 0o777) !== 0o700) {
      throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    }
    fd = credentialOpen('/proc/self/fd/' + parent + '/' + parts[parts.length - 1],
      credentialFlags.O_RDONLY | credentialFlags.O_NOFOLLOW | credentialFlags.O_NONBLOCK);
    const info = credentialStat(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o600
      || info.size <= 0 || info.size > 4 * 1024 * 1024) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    const value = credentialRead(fd, 'utf8');
    const after = credentialStat(fd);
    if (after.nlink !== 1 || after.uid !== process.geteuid() || (after.mode & 0o777) !== 0o600
      || after.size !== info.size || Buffer.byteLength(value) !== info.size
      || value.includes('\0')) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    return value;
  } catch {
    throw new Error('PRIVATE_CREDENTIAL_REJECTED');
  } finally {
    if (fd !== undefined) credentialClose(fd);
    if (parent !== undefined) credentialClose(parent);
  }
}

if (process.argv.length === 3 && process.argv[2] === '--post-tool-use') {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error('hook input limit');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || input.hook_event_name !== 'PostToolUse' || !Object.hasOwn(input, 'tool_response')) {
      throw new Error('invalid hook event');
    }
    const secrets = [...new Set([readPrivateCredential(process.env.DEEPSONAR_GATEWAY_TOKEN_FILE),
      readPrivateCredential(process.env.DEEPSONAR_CONTROL_TOKEN_FILE, true),
      readPrivateCredential(process.env.DEEPSONAR_OM_GATEWAY_TOKEN_FILE, true)].filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    let changed = false;
    const project = value => {
      if (typeof value === 'string') {
        let text = value;
        for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
        if (text !== value) changed = true;
        return text;
      }
      if (Array.isArray(value)) return value.map(project);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)]));
      }
      return value;
    };
    const output = project(input.tool_response);
    // Identity rewrites can overwrite a sibling hook's real projection.
    process.stdout.write(JSON.stringify(changed ? { hookSpecificOutput: {
      hookEventName: 'PostToolUse', updatedToolOutput: output,
    } } : {}));
  } catch {
    process.stderr.write('CLAUDE_TOOL_OUTPUT_PROJECTION_FAILED\n');
    process.exitCode = 78;
  }
} else {
  if (process.argv.length !== 2) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
  const token = readPrivateCredential(process.env.DEEPSONAR_GATEWAY_TOKEN_FILE);
  if (!token || /[\r\n]/.test(token)) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
  process.stdout.write(token);
}
