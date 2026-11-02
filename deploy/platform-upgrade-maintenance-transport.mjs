import {spawnSync} from 'node:child_process';
export {assertDirectoryDurability, durablePrivateWrite, readPrivateJson} from './platform-upgrade-filesystem.mjs';

const STDOUT_LIMIT = 512 * 1024 * 1024;
const STDERR_LIMIT = 400;

/** Bounded, credential-free stderr excerpt for operator triage (#845). */
function redactDiagnostic(text) {
  return String(text ?? '')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gu, 'postgres://<redacted>')
    .replace(/PGPASSWORD=\S+/gu, 'PGPASSWORD=<redacted>')
    .replace(/\bpassword=\S+/giu, 'password=<redacted>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, STDERR_LIMIT);
}

/**
 * A Docker operation failed only when the child exit status is not allowed.
 * #845: a successful child can still hand Node an EPIPE (`pg_restore --list` stops
 * reading stdin once the TOC is parsed), so `error` alone must never fail a run.
 */
export const isRunFailure = (result, allowed = [0]) => !allowed.includes(result?.status);

/**
 * Failure detail that is safe to log: exit status, signal and error code were
 * missing before (#845) — the operator saw only `output suppressed`. Stderr stays
 * hidden unless DEEPSONAR_UPGRADE_DEBUG_STDERR opts in, because this module must
 * never surface PostgreSQL diagnostics.
 */
export function runFailureMessage(args, result, {debugStderr = process.env.DEEPSONAR_UPGRADE_DEBUG_STDERR === '1'} = {}) {
  const details = [
    `docker ${args?.[0] ?? '<unknown>'} exit ${result?.status ?? 'none'}`,
    result?.signal ? `signal ${result.signal}` : null,
    result?.error?.code ? `error ${result.error.code}` : null,
  ].filter(Boolean).join(', ');
  const stderr = debugStderr ? redactDiagnostic(result?.stderr?.toString?.() ?? '') : '';
  return `maintenance Docker operation failed (${details})${stderr ? `: ${stderr}` : ''}`;
}

// Constant program; all connection credentials and SQL arrive on stdin. Never
// interpolate them in command arguments or surface PostgreSQL diagnostics.
export const SQL_PROGRAM = `const postgres=require('/app/apps/scheduler/node_modules/postgres');
(async()=>{let raw='';for await(const b of process.stdin){raw+=b;if(raw.length>33554432)throw Error();}
const {connection,sql}=JSON.parse(raw);const db=postgres({...connection,max:1,connect_timeout:10,onnotice:()=>{}});
try{const result=await db.unsafe(sql).simple();const sets=Array.isArray(result[0])?result:[result];
const rows=[...sets].reverse().find(x=>x.length)||[];process.stdout.write(JSON.stringify(rows));}
finally{await db.end({timeout:5});}})().catch(()=>{process.stderr.write('maintenance SQL failed');process.exitCode=1;});`;
export function createMaintenanceTransport({compose, commandEnv, run: injectedRun}) {
  const run = injectedRun ?? ((args, input, env = commandEnv, allowed = [0]) => {
    const result = spawnSync('docker', args, {input, env, maxBuffer: STDOUT_LIMIT, timeout: 600_000});
    // #845: the exit status decides the outcome; EPIPE after a successful child
    // (podman) must not be reported as a failed upgrade step.
    if (isRunFailure(result, allowed)) throw new Error(runFailureMessage(args, result));
    return allowed.length > 1 ? {stdout: result.stdout, status: result.status} : result.stdout;
  });
  const dc = (args, input, env = commandEnv) => run([...compose, ...args], input, env);
  const pgContainer = () => {
    const id = dc(['ps', '-q', 'postgres']).toString().trim();
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('expected one running PostgreSQL container');
    return id;
  };
  const invoke = ({image, connection, args, payload, allowed = [0]}) => run(['run', '--rm', '-i', '--network', `container:${pgContainer()}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--entrypoint=node', image, ...args], JSON.stringify({...payload, connection: {host: '127.0.0.1', port: 5432, ...connection}}), commandEnv, allowed);
  const rows = async ({image, role, password, database, port = 5432, sql}) => {
    const output = invoke({image, connection: {username: role, password, database, port}, args: ['-e', SQL_PROGRAM], payload: {sql}});
    const value = JSON.parse(output.toString());
    if (!Array.isArray(value)) throw new Error('invalid maintenance SQL response');
    return value;
  };
  return {run, dc, pgContainer, rows,
    scalar: async input => Object.values((await rows(input))[0] ?? {})[0],
    schema: async ({image, role, password, database, port = 5432, ...payload}) => {
      const result = invoke({image, connection: {username: role, password, database, port}, args: ['/app/apps/scheduler/dist/platform-upgrade-schema-cli.js'], payload: {schema: 'deepsonar.schema-upgrade/v1', ...payload}, allowed: [0, 1]});
      const value = JSON.parse((result.stdout ?? result).toString());
      if (value.schema !== 'deepsonar.schema-upgrade-result/v1' || typeof value.ok !== 'boolean' || (result.status !== undefined && result.status !== (value.ok ? 0 : 1))) throw new Error('invalid schema CLI response');
      return value;
    },
    archive: ({action, role, password, database, port = 5432, input}) => run(['exec', '-i', '-e', 'PGPASSWORD', pgContainer(), action, '-h', '127.0.0.1', '-p', String(port), '-U', role, '-d', database,
      ...(action === 'pg_dump' ? ['-Fc'] : ['--exit-on-error', '--no-owner', '--no-privileges'])], input, {...commandEnv, PGPASSWORD: password}),
  };
}
