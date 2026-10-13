"""Deterministic test actor invoked by the real Claude Code Bash tool.

No REA output is mocked. The local model only selects this script; production
Control API, archive, normalization and Verify remain authoritative.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path('/workspace')
context = json.loads((ROOT / 'rea-job-input.json').read_text())
runtime = json.loads((ROOT / '.deepsonar/runtime-manifest.json').read_text())
mode = context['mode']

def invoke(operation, payload, accepted=True):
    request = urllib.request.Request(
        os.environ['DEEPSONAR_API_BASE_URL'] + '/operations/' + operation,
        data=json.dumps(payload).encode(), method='POST',
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + os.environ['DEEPSONAR_API_TOKEN'],
                 'Idempotency-Key': str(uuid.uuid4())})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        result = json.load(error)
    if accepted:
        assert result.get('accepted') is True, (operation, result)
    else:
        assert result.get('accepted') is False, (operation, result)
    return result

if mode == 'verify':
    # Bytes come from the immutable, server-frozen shared-assets volume after
    # the maker's sandbox has already been destroyed. No maker text is trusted.
    archive_path = Path(context['archive_read_path'])
    data = archive_path.read_bytes()
    assert hashlib.sha256(data).hexdigest() == context['archive_sha256']
    archive = json.loads(data)
    assert archive['job_id'] != runtime['job_id']
    assert archive['exit_code'] == 0 and not archive['stdout_truncated']
    observation = json.loads(archive['stdout'])
    assert observation.get('normalized_result'), 'actual REA normalized result required'
    invoke('emit_progress', {'message': 'REA_VERIFY_ARCHIVE_READ sha256=' + hashlib.sha256(data).hexdigest()})
    # Deliberately overclaim: the production fact-first gate, not this actor,
    # must refuse confirmation without independent structured supporting Facts.
    invoke('mark_job_done', {'summary': 'Negative acceptance probe: requesting confirmed from an observation-only archive; Scheduler must require independent structured evidence.', 'verdict': 'confirmed'})
    print('REA_E2E_DONE')
    raise SystemExit(0)

# Read installed, pinned tools before executing the public source-built sample.
assert runtime['runtime_image']['digest'] == context['image_digest']
assert any(item['id'] == 'binary.rea.cli' for item in runtime['cli_capabilities'])
listed = invoke('search_skills', {'query': 'deepsonar-rea-cli'})
entry = next(item for item in listed['skills'] if item['name'] == 'deepsonar-rea-cli')
stale = invoke('pull_skill', {'selector': entry['selector'], 'expected_content_hash': '0' * 64}, False)
assert stale['error_code'] == 'SKILL_HASH_MISMATCH'
skill = invoke('pull_skill', {'selector': entry['selector'], 'expected_content_hash': entry['content_hash']})['skill']
assert hashlib.sha256(skill['files']['SKILL.md'].encode()).hexdigest() == context['skill_sha256']
(ROOT / 'pulled-rea-skill.md').write_text(skill['files']['SKILL.md'])
capability = invoke('describe_capability', {'id': 'binary.rea.cli'})
assert capability.get('cli_capability', {}).get('tool') == 'rea', capability
# Isolation proof must match what OpenSandbox Docker DNS-mode egress actually
# enforces (see packages/runtime-sandbox NETWORK_ISOLATION_SCRIPT / platform-api
# PoC). Raw access to the Docker bridge gateway IP is NOT denied under
# ingress.mode=direct + egress.mode=dns, so probing host:port falsely fails CI
# without proving a production policy hole we can fix in this fixture.
# Enforce: TEST-NET / documentation IPv6 blackholes, NXDOMAIN for .invalid,
# and no HTTP marker via the Gateway proxy on a non-forwarded path.
def _tcp(host, port, family=socket.AF_INET):
    probe = socket.socket(family, socket.SOCK_STREAM)
    probe.settimeout(3)
    try:
        probe.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()

try:
    leaked = False
    phase = 'test-net'
    if _tcp('192.0.2.1', 80):
        leaked = True
    try:
        if _tcp('2001:db8::1', 80, socket.AF_INET6):
            leaked = True
    except OSError:
        pass
    phase = 'dns'
    try:
        socket.getaddrinfo('this-name-should-not-resolve.invalid', 80)
        leaked = True
    except socket.gaierror:
        pass
    phase = 'connect'
    try:
        with socket.create_connection(('192.0.2.1', 80), 3) as probe:
            probe.sendall(b'CONNECT 192.0.2.1:443 HTTP/1.1\r\nHost: 192.0.2.1\r\n\r\n')
            leaked = True
    except OSError:
        pass
    assert not leaked, 'restricted sandbox leaked arbitrary internet egress'

    # Application-level: Gateway proxy only forwards /gateway and /control/v1.
    # A marker served on the Scheduler host must not appear on a denied proxy path.
    phase = 'proxy-path'
    proxy = os.environ.get('DEEPSONAR_GATEWAY_PROXY_HOST', 'deepsonar-gateway-proxy')
    marker = str(context.get('egress_probe_marker') or '').encode()
    response = b''
    try:
        with socket.create_connection((proxy, 3100), 3) as probe:
            probe.sendall(
                b'GET /rea-egress-control HTTP/1.1\r\n'
                b'Host: ' + proxy.encode() + b'\r\n'
                b'Connection: close\r\n\r\n'
            )
            while len(response) < 8192:
                chunk = probe.recv(4096)
                if not chunk:
                    break
                response += chunk
    except OSError:
        response = b''
    if marker:
        assert marker not in response, 'restricted sandbox leaked target HTTP egress via gateway proxy'
    invoke('emit_progress', {'message': 'REA_EGRESS_BLOCKED phase=' + phase})
except AssertionError as error:
    try:
        invoke('emit_progress', {'message': 'REA_ACTOR_FAILED ' + str(error)})
    except Exception:
        pass
    raise

(ROOT / 'sample_elf').write_bytes(base64.b64decode((ROOT / 'sample_elf.base64').read_bytes(), validate=True))
(ROOT / 'sample_elf').chmod(0o700)
sample_sha = hashlib.sha256((ROOT / 'sample_elf').read_bytes()).hexdigest()
assert sample_sha == context['sample_sha256']
version = subprocess.run(['rea', '--version'], capture_output=True, text=True, check=True)
assert '6.4.0' in version.stdout + version.stderr
java = subprocess.run(['java', '-version'], capture_output=True, text=True, check=True)
assert '21.' in java.stderr + java.stdout
operation = 'function'
argv = ['rea', 'function', str(ROOT / 'sample_elf'), 'vulnerable_copy', '--provider', 'ghidra', '--json']
if mode == 'failure':
    argv[3] = '__deepsonar_function_does_not_exist__'
output = ROOT / 'rea.stdout'
error_output = ROOT / 'rea.stderr'
key = 'rea-e2e/' + runtime['job_id'] + '/observation.json'
cap = 4_194_304

def checkpoint(exit_code=None):
    stdout = output.read_bytes()
    stderr = error_output.read_bytes()
    # Never archive our short-lived runtime authentication tokens.
    for name in ['DEEPSONAR_API_TOKEN', 'DEEPSONAR_GATEWAY_TOKEN']:
        secret = os.environ.get(name, '').encode()
        if secret:
            stdout = stdout.replace(secret, b'[REDACTED]')
            stderr = stderr.replace(secret, b'[REDACTED]')
    archive = {
        'schema': 'deepsonar.rea-observation/v1',
        'job_id': runtime['job_id'], 'attempt_id': runtime['attempt_id'],
        'operation': operation, 'sample_path': str(ROOT / 'sample_elf'), 'sample_sha256': sample_sha,
        'image_digest': context['image_digest'],
        'tool_versions': {'rea': '6.4.0', 'ghidra': '12.1.4', 'java': (java.stderr + java.stdout).splitlines()[0][:100]},
        'argv': argv, 'exit_code': exit_code,
        'stdout': stdout[:cap].decode('utf-8', errors='replace'), 'stderr': stderr[:cap].decode('utf-8', errors='replace'),
        'stdout_truncated': len(stdout) > cap, 'stderr_truncated': len(stderr) > cap,
        'timed_out': False, 'cancelled': False,
        'analysis_limits': {'timeout_ms': 180000, 'max_output_bytes': cap,
                            'note': 'Static single-function dossier; no dynamic exploit proof. Null exit means an unfinished checkpoint.'},
    }
    (ROOT / 'rea-observation.json').write_text(json.dumps(archive))
    invoke('publish_shared_asset', {'scope': 'project', 'key': key, 'source_path': str(ROOT / 'rea-observation.json'), 'content_type': 'application/json'})
    return archive

with output.open('wb') as stdout, error_output.open('wb') as stderr:
    process = subprocess.Popen(argv, stdout=stdout, stderr=stderr, start_new_session=True)
    if mode in ('cancel', 'timeout'):
        time.sleep(1)
        assert process.poll() is None, 'cancellation probe must interrupt a live REA process'
        checkpoint()
        invoke('emit_fact', {'title': 'REA interrupted checkpoint', 'description': 'A running tool checkpoint retained before cancellation.',
                            'artifact': {'extensions': {'binary.rea-cli': {'evidence_key': key}}}})
        invoke('emit_progress', {'message': 'REA_CHECKPOINT_READY pid=' + str(process.pid)})
        # Scheduler cancels/expires the Job and destroys the actual sandbox.
        # Do not try to write after terminal status or weaken late-event guards.
        time.sleep(300)
        raise AssertionError('Scheduler did not interrupt the Job')
    try:
        exit_code = process.wait(timeout=180)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        raise
archive = checkpoint(exit_code)
if mode == 'success':
    assert exit_code == 0, archive['stderr'][:1000]
    result = json.loads(archive['stdout'])
    assert result.get('normalized_result'), result
    assert 'strcpy' in json.dumps(result['normalized_result']), 'real dossier must contain the expected public sample call'
else:
    assert exit_code != 0, 'real invalid function query must fail'
# A tool's stdout is not a semantic event, even if it resembles one.
print(json.dumps({'v': 1, 'event_id': str(uuid.uuid4()), 'type': 'finding',
                  'payload': {'title': 'REA_HOSTILE_STDOUT_MUST_NOT_INGEST', 'summary': 'No semantic authority'}}))
invoke('emit_fact', {'title': 'REA sample observation', 'description': 'Actual REA output is archived; Scheduler normalizes the observation.',
                    'artifact': {'extensions': {'binary.rea-cli': {'evidence_key': key}}}})
if mode == 'success':
    invoke('emit_finding', {'title': 'Public sample contains a static strcpy call', 'profile': 'general', 'severity': 'low',
                           'summary': 'REA observed a call in the public test binary. This is a static observation, not a vulnerability or dynamic proof.',
                           'location': '/workspace/sample_elf:vulnerable_copy'})
if mode == 'failure':
    raise RuntimeError('Expected REA nonzero exit; partial observation retained, no successful Job completion submitted')
invoke('mark_job_done', {'summary': 'REA observation archived and submitted with independent verification still required.'})
print('REA_E2E_DONE')
