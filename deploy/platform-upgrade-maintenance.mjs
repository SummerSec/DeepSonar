import {randomUUID} from 'node:crypto';

const STEPS = ['prepareIdentity', 'pauseAndDrain', 'fence', 'backup', 'candidate', 'rebuild', 'configurePreparing', 'startPreparing', 'verifyPreparing', 'activate', 'verifyActive'];
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fail = code => Object.assign(new Error(code), {code});
const validPlan = plan => plan && typeof plan.plan_hash === 'string' && /^[a-f0-9]{64}$/.test(plan.plan_hash) && Array.isArray(plan.risks) && Array.isArray(plan.blocking_errors);

// Actors are effect-aware idempotent operations. Repeating an intent must inspect
// real DB/container state, not trust this host journal or repeat destructive SQL.
export async function runMaintenanceUpgrade(io, {action, target, approvedPlanHash}) {
  if (!['check', 'apply', 'rollback'].includes(action)) throw fail('INVALID_MAINTENANCE_ACTION');
  if (action === 'check') {
    const recorded = await io.readJournal();
    const recovery = recorded?.status === 'rolled_back' && (target === undefined || recorded.requestedTarget === target);
    if (recovery && stable(recorded.binding) !== stable(await io.deploymentBinding())) throw fail('MAINTENANCE_RECOVERY_BINDING_MISMATCH');
    const resolved = recovery ? recorded.target : await io.resolveTarget(target);
    const plan = await io.plan(resolved, recovery ? {recovery: true, resetRoleIdentity: recorded.plan.reset_role_identity === true} : undefined);
    if (!validPlan(plan)) throw fail('INVALID_SCHEMA_PLAN');
    return {target: resolved, plan, ok: plan.blocking_errors.length === 0};
  }
  let state = await io.readJournal();
  const binding = await io.deploymentBinding();
  if (state) {
    if (state.schema !== 'deepsonar.maintenance-upgrade/v1' || (target !== undefined && state.requestedTarget !== target)
        || stable(state.binding) !== stable(binding) || !validPlan(state.plan)
        || typeof state.generation !== 'string' || !state.target || !state.receipts) throw fail('MAINTENANCE_RECOVERY_BINDING_MISMATCH');
    if (state.status !== 'rolled_back' && approvedPlanHash && approvedPlanHash !== state.plan.plan_hash) throw fail('MAINTENANCE_APPROVAL_CHANGED');
  } else {
    if (action === 'rollback') throw fail('NO_MAINTENANCE_OPERATION');
    const resolved = await io.resolveTarget(target);
    const plan = await io.plan(resolved);
    if (!validPlan(plan)) throw fail('INVALID_SCHEMA_PLAN');
    if (plan.blocking_errors.length) throw fail('SCHEMA_PLAN_BLOCKED');
    if (plan.risks.length && approvedPlanHash !== plan.plan_hash) throw fail('SCHEMA_PLAN_APPROVAL_REQUIRED');
    state = {schema: 'deepsonar.maintenance-upgrade/v1', generation: randomUUID(), requestedTarget: target,
      target: resolved, binding, plan, status: 'preparing', intent: null, receipts: {}};
    await io.writeJournal(state);
  }
  const persist = async changes => {state = {...state, ...changes}; await io.writeJournal(state);};
  const activation = async () => {
    const actual = await io.inspectActivation(state);
    if (!actual || !['active', 'inactive', 'unknown'].includes(actual.status)) throw fail('ACTIVATION_EVIDENCE_INVALID');
    if (actual.status === 'active' && (actual.generation !== state.generation || typeof actual.receipt_id !== 'string' || !actual.receipt_id)) throw fail('ACTIVATION_EVIDENCE_INVALID');
    return actual;
  };
  const rollback = async () => {
    const actual = await activation();
    if (actual.status === 'active' || state.activation || state.receipts.activate) {
      await persist({status: 'active_repair', ...(actual.status === 'active' ? {activation: actual} : {})});
      throw fail('ACTIVE_GENERATION_REQUIRES_FORWARD_REPAIR');
    }
    if (actual.status !== 'inactive') {
      await persist({status: 'recovery_uncertain'});
      throw fail('MAINTENANCE_RECOVERY_UNCERTAIN');
    }
    await persist({status: 'rolling_back', intent: 'rollbackPreparing'});
    const receipt = await io.rollbackPreparing(state);
    if (receipt?.awaiting_drain === true && receipt.paused === true && receipt.services_unchanged === true && receipt.receipt_id) {
      await persist({status: 'awaiting_drain', intent: null, drain_wait: receipt});
      return {status: state.status, generation: state.generation, paused: true};
    }
    const unchanged = receipt?.unchanged === true && typeof receipt.paused === 'boolean';
    if ((!unchanged && (receipt?.paused !== true || receipt.source_selected !== true)) || !receipt?.receipt_id) throw fail('ROLLBACK_NOT_VERIFIED');
    if (unchanged && (state.receipts.pauseAndDrain || state.receipts.fence || state.receipts.backup)) throw fail('ROLLBACK_UNCHANGED_CONTRADICTS_EFFECTS');
    await persist({status: 'rolled_back', intent: null, rollback: receipt});
    return {status: state.status, generation: state.generation, paused: receipt.paused, ...(unchanged ? {unchanged: true} : {})};
  };
  if (action === 'rollback' || state.status === 'rolling_back') return rollback();
  // A completed rollback is a safe terminal outcome. Starting another attempt is
  // explicit apply, with the same pinned target/approval and a fresh generation.
  if (state.status === 'rolled_back') {
    const plan = await io.plan(state.target, {recovery: true, resetRoleIdentity: state.plan.reset_role_identity === true});
    if (!validPlan(plan) || plan.blocking_errors.length) throw fail('SCHEMA_PLAN_BLOCKED');
    if (plan.risks.length && approvedPlanHash !== plan.plan_hash) throw fail('SCHEMA_PLAN_APPROVAL_REQUIRED');
    await persist({plan, generation: randomUUID(), previousGeneration: state.generation, status: 'preparing', intent: null, receipts: {}, rollback: null, activation: null});
  }
  try {
    const actual = await activation();
    if (actual.status === 'unknown' || (actual.status === 'inactive' && (state.activation || state.receipts.activate))) throw fail('MAINTENANCE_RECOVERY_UNCERTAIN');
    if (actual.status === 'active') {
      await persist({status: 'active_repair', activation: actual, intent: 'verifyActive'});
      const receipt = await io.verifyActive(state);
      if (receipt?.ok !== true) throw fail('ACTIVE_VERIFICATION_FAILED');
      await persist({status: 'complete', intent: null, receipts: {...state.receipts, verifyActive: receipt}});
      return {status: state.status, generation: state.generation, activation: actual};
    }
    // Even previously completed steps are re-entered: each actor must revalidate
    // its durable receipt and return without replaying its effect when complete.
    for (const step of STEPS) {
      await persist({intent: step});
      const receipt = await io[step](state);
      if (!receipt || typeof receipt !== 'object') throw fail('MISSING_STEP_RECEIPT');
      if (step === 'activate' && (receipt.active !== true || receipt.generation !== state.generation || !receipt.receipt_id)) throw fail('ACTIVATION_RECEIPT_INVALID');
      if ((step === 'verifyPreparing' || step === 'verifyActive') && receipt.ok !== true) throw fail('GENERATION_VERIFICATION_FAILED');
      await persist({intent: null, receipts: {...state.receipts, [step]: receipt}, ...(step === 'activate' ? {status: 'active', activation: receipt} : {})});
    }
    await persist({status: 'complete'});
    return {status: state.status, generation: state.generation, activation: state.activation};
  } catch (error) {
    // inspectActivation must consult durable DB authority even after a lost
    // activate response; host absence of a receipt never proves inactivity.
    const recovery = await rollback();
    if (recovery.status === 'awaiting_drain') throw fail('MAINTENANCE_AWAITING_DRAIN');
    throw fail(error?.code ?? 'MAINTENANCE_STEP_FAILED_ROLLED_BACK');
  }
}
