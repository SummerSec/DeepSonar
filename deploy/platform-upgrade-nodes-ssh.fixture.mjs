import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {spawn, execFile, execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {join, dirname} from 'node:path';
import {createServer} from 'node:net';
const exec = (command, args) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Ephemeral user-owned daemon; no system configuration, keys or remote hosts. */
export async function startLoopbackSshFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'managed-ssh-'));
  let daemon; let daemonLog = '';
  async function close() {
    if (daemon && daemon.exitCode === null) { const exited = new Promise(resolve => daemon.once('exit', resolve)); daemon.kill('SIGTERM'); await exited; }
    await rm(directory, {recursive: true, force: true});
  }
  try {
    for (const key of ['host', 'client']) exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, key)]);
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const username = userInfo().username;
    const hostKey = (await readFile(join(directory, 'host.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
    await writeFile(join(directory, 'known_hosts'), `[127.0.0.1]:${port} ${hostKey}\n`, {mode: 0o600});
    await writeFile(join(directory, 'sshd_config'), [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'host')}`, `PidFile ${join(directory, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(directory, 'client.pub')}`, 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
      `AllowUsers ${username}`, 'PermitRootLogin no', 'AllowTcpForwarding no', 'X11Forwarding no', 'PermitTunnel no',
      `SetEnv PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, 'LogLevel VERBOSE',
    ].join('\n') + '\n', {mode: 0o600});
    daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(directory, 'sshd_config')], {stdio: ['ignore', 'pipe', 'pipe']});
    daemon.stdout.on('data', data => { daemonLog += data; }); daemon.stderr.on('data', data => { daemonLog += data; });
    for (let i = 0; i < 30 && !daemonLog.includes('Server listening'); i++) { if (daemon.exitCode !== null) throw new Error(`isolated sshd failed: ${daemonLog}`); await sleep(100); }
    assert.match(daemonLog, /Server listening/);
    const sshOptions = {isolatedConfig: true, port, identityFile: join(directory, 'client'), knownHostsFile: join(directory, 'known_hosts')};
    await promisify(execFile)('ssh', ['-F', '/dev/null', '-p', String(port), '-i', sshOptions.identityFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${sshOptions.knownHostsFile}`, `${username}@127.0.0.1`, 'node --version'], {timeout: 10000});
    return {directory, sshHost: `${username}@127.0.0.1`, sshOptions, logs: () => daemonLog, close};
  } catch (error) { await close(); throw new Error(`Isolated SSH fixture failed: ${error.message}\n${daemonLog}`); }
}
