import {createHash} from 'node:crypto';

export const AUTO_POLICY_SCHEMA = 'deepsonar.auto-upgrade-policy/v1';
export const canonical = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
export const autoError = code => Object.assign(new Error(code), {code});

export function validateAutoPolicy(input) {
  if (!input || input.schema !== AUTO_POLICY_SCHEMA || typeof input.enabled !== 'boolean'
      || Object.keys(input).some(key => !['schema', 'enabled', 'window', 'signature'].includes(key))) throw autoError('AUTO_POLICY_INVALID');
  if (!input.enabled) return input;
  const window = input.window;
  if (!window || Object.keys(window).some(key => !['timezone', 'days', 'start', 'end'].includes(key))
      || !Array.isArray(window.days) || !window.days.length || window.days.some(day => !Number.isInteger(day) || day < 1 || day > 7)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end)
      || window.start === window.end || typeof window.timezone !== 'string'
      || !input.signature || input.signature.enabled !== true) throw autoError('AUTO_POLICY_INVALID');
  try {new Intl.DateTimeFormat('en', {timeZone: window.timezone}).format();} catch {throw autoError('AUTO_TIMEZONE_INVALID');}
  return input;
}

// Days are ISO Monday=1..Sunday=7. Overnight windows belong to their start day.
// A repeated DST minute is inside the same window; a skipped minute never occurs.
export function inMaintenanceWindow(policy, now = new Date()) {
  if (!policy.enabled) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: policy.window.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(now).map(part => [part.type, part.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  const time = `${parts.hour}:${parts.minute}`, {start, end, days} = policy.window;
  return start < end ? days.includes(day) && time >= start && time < end
    : (time >= start && days.includes(day)) || (time < end && days.includes(day === 1 ? 7 : day - 1));
}

export function isPatchIncrease(source, target) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stable.test(source) || !stable.test(target)) return false;
  const [a, b, c] = source.split('.').map(BigInt), [x, y, z] = target.split('.').map(BigInt);
  return a === x && b === y && z > c;
}

export function assertAutomaticPlan(plan, target) {
  if (!plan || !/^[a-f0-9]{64}$/.test(plan.plan_hash) || !Array.isArray(plan.risks) || plan.risks.length
      || !Array.isArray(plan.blocking_errors) || plan.blocking_errors.length
      || plan.preflight?.ok !== true || !Array.isArray(plan.preflight.blocking_errors) || plan.preflight.blocking_errors.length
      || plan.reset_role_identity === true || plan.preflight_projection !== 'none'
      || !Number.isSafeInteger(plan.source_schema_version) || plan.source_schema_version !== plan.target_schema_version
      || plan.target_schema_version !== target.schema_version || !/^[a-f0-9]{64}$/.test(plan.source_schema_sha256)
      || plan.source_schema_sha256 !== plan.target_sql_sha256) throw autoError('AUTO_PLAN_REQUIRES_MANUAL_UPGRADE');
}
