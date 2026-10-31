"""Real sandbox actor for the disposable project knowledge runtime smoke."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid

root = Path('/workspace')
config = json.loads((root / 'knowledge-job-input.json').read_text())
runtime = json.loads((root / '.deepsonar/runtime-manifest.json').read_text())
assert runtime['job_id'] == config['job_id']

def invoke(operation, payload, accepted=True):
    request = urllib.request.Request(
        os.environ['DEEPSONAR_API_BASE_URL'].rstrip('/') + '/operations/' + operation,
        data=json.dumps(payload).encode(), method='POST',
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + os.environ['DEEPSONAR_API_TOKEN'],
                 'Idempotency-Key': str(uuid.uuid4())})
    if operation == 'mark_job_done':
        request.add_header('X-DeepSonar-Proposal-Revision', '0')
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        result = json.load(error)
    assert result.get('accepted') is accepted, (operation, result)
    return result

try:
    mode = config['mode']
    listed = invoke('search_skills', {'query': config['skill_title']})
    skills = [item for item in listed['skills'] if item['selector'] == config['selector']]
    memory = invoke('search_project_knowledge', {'kind': 'memory', 'query': config['memory_title']})
    assert not memory['items'], 'other project Memory entered this Job'
    denied_memory = invoke('read_project_memory', {
        'item_ref': config['memory_item_id'], 'version': 1,
        'expected_hash': config['memory_hash']}, False)
    assert denied_memory['error_code'] in ('KNOWLEDGE_SCOPE_DENIED', 'KNOWLEDGE_REVOKED'), denied_memory
    if mode == 'granted':
        assert len(skills) == 1, listed
        pulled = invoke('pull_skill', {'selector': config['selector'],
                                      'expected_content_hash': config['skill_hash']})
        assert pulled['usage_ref'] and pulled['skill']['files']['SKILL.md'] == config['skill_content']
        invoke('emit_progress', {'message': 'KNOWLEDGE_GRANTED_USAGE ' + pulled['usage_ref']})
    else:
        assert not skills, listed
        denied = invoke('pull_skill', {'selector': config['selector'],
                                       'expected_content_hash': config['skill_hash']}, False)
        assert denied['error_code'] in ('KNOWLEDGE_REVOKED', 'KNOWLEDGE_SCOPE_DENIED'), denied
        invoke('emit_progress', {'message': 'KNOWLEDGE_' + mode.upper() + '_DENIED ' + denied['error_code']})
    invoke('mark_job_done', {'summary': 'Real sandbox project knowledge authorization smoke completed.'})
    print('KNOWLEDGE_ACTOR_DONE mode=' + mode)
except Exception as error:
    try:
        invoke('emit_progress', {'message': 'KNOWLEDGE_ACTOR_FAILED ' + str(error)[:1000]})
    finally:
        raise
