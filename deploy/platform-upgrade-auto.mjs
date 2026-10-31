import {runMaintenanceUpgrade} from './platform-upgrade-maintenance.mjs';
import {validateAutoPolicy, inMaintenanceWindow, isPatchIncrease, assertAutomaticPlan, fingerprint, autoError} from './platform-upgrade-auto-policy.mjs';

const RECEIPT_SCHEMA = 'deepsonar.auto-upgrade-authorization/v1';
const manualStates = ['rolled_back', 'rollback_resumed', 'rolling_back', 'recovery_uncertain', 'awaiting_drain'];
const noAction = reason => ({status: 'not_started', reason});

// Called under the same OS lock as manual maintenance. All trust dependencies
// are supplied by the host, never mapped from CLI or release-manifest fields.
export async function runAutomaticUpgrade(io, {policy, now = () => new Date()}) {
  validateAutoPolicy(policy);
  if (!policy.enabled) return noAction('policy_disabled');
  const policyHash = fingerprint(policy);
  let journal = await io.readJournal(), authorization = await io.readAuthorization();
  if (journal?.status === 'complete' && !journal.autoAuthorizationHash) {
    if (!inMaintenanceWindow(policy, now())) return noAction('outside_maintenance_window');
    if (fingerprint(journal.binding) !== fingerprint(await io.deploymentBinding())) throw autoError('AUTO_JOURNAL_MISMATCH');
    await io.writeAuthorization(null); // Manual terminal journal still proves completion if archival is interrupted.
    await io.archiveCompleted(journal); // A verified manual completion is not an interrupted operation.
    journal = null;authorization = null;
  }
  const binding = () => io.deploymentBinding();
  const validateReceipt = async () => {
    if (!authorization || authorization.schema !== RECEIPT_SCHEMA || authorization.policyHash !== policyHash
        || authorization.targetHash !== fingerprint(authorization.target) || authorization.signature?.verified !== true
        || fingerprint(authorization.binding) !== fingerprint(await binding())
        || !isPatchIncrease(authorization.sourceVersion, authorization.target.version)) throw autoError('AUTO_AUTHORIZATION_MISMATCH');
    assertAutomaticPlan(authorization.plan, authorization.target);
  };
  if (journal) {
    await validateReceipt();
    if (journal.autoAuthorizationHash !== fingerprint(authorization)
        || journal.requestedTarget !== authorization.target.version || fingerprint(journal.target) !== authorization.targetHash
        || fingerprint(journal.plan) !== fingerprint(authorization.plan) || fingerprint(journal.binding) !== fingerprint(authorization.binding)) throw autoError('AUTO_JOURNAL_MISMATCH');
    if (manualStates.includes(journal.status)) return noAction('manual_recovery_required');
    if (journal.status === 'complete' && !inMaintenanceWindow(policy, now())) return noAction('outside_maintenance_window');
    const verified = await io.verifySignatures(authorization.target, policy.signature);
    if (verified?.verified !== true || verified.status !== 'verified') throw autoError('AUTO_SIGNATURE_REQUIRED');
    // Already-authorized generations may finish safely outside the start window.
    // Never discover a newer target or re-plan an interrupted candidate.
    if (journal.status !== 'complete') return runMaintenanceUpgrade(io, {action: 'apply', target: authorization.target.version});
    if (!inMaintenanceWindow(policy, now())) return noAction('outside_maintenance_window');
    await io.archiveCompleted(journal); // Verifies the actual active generation.
    journal = null;
    authorization = null;
  }
  if (!inMaintenanceWindow(policy, now())) return noAction('outside_maintenance_window');
  const source = await io.current(); // Real running health/version, not dotenv alone.
  if (authorization) {
    await validateReceipt();
    // A crash after verified completed-journal archival can leave its receipt.
    if (source.version === authorization.target.version) authorization = null;
    else if (source.version !== authorization.sourceVersion) throw autoError('AUTO_SOURCE_CHANGED');
  }
  const target = authorization?.target ?? await io.discoverTarget();
  if (!isPatchIncrease(source.version, target.version)) return noAction('not_a_stable_patch_increase');
  const signature = await io.verifySignatures(target, policy.signature);
  if (signature?.verified !== true || signature.status !== 'verified') throw autoError('AUTO_SIGNATURE_REQUIRED');
  await io.pull(target);
  const plan = await io.plan(target);
  assertAutomaticPlan(plan, target);
  if (source.environmentHash !== plan.source_environment_sha256) throw autoError('AUTO_SOURCE_CHANGED');
  if (authorization && plan.plan_hash !== authorization.plan.plan_hash) throw autoError('AUTO_PLAN_CHANGED');
  if (!inMaintenanceWindow(policy, now())) return noAction('maintenance_window_closed');
  authorization = {schema: RECEIPT_SCHEMA, policyHash, sourceVersion: source.version, target, targetHash: fingerprint(target), plan, binding: await binding(), signature};
  await io.writeAuthorization(authorization);
  if (!inMaintenanceWindow(policy, now())) return noAction('maintenance_window_closed');
  // Recheck the source and complete configuration preflight just before the
  // engine creates its durable generation. No implicit risk-plan approval.
  let generationStarted = false;
  const guarded = {...io,
    resolveTarget: async () => target,
    plan: async () => {
      const current = await io.current();
      const checked = await io.plan(target);
      assertAutomaticPlan(checked, target);
      if (current.version !== authorization.sourceVersion || current.environmentHash !== checked.source_environment_sha256
          || checked.plan_hash !== plan.plan_hash || checked.source_environment_sha256 !== plan.source_environment_sha256) throw autoError('AUTO_PLAN_CHANGED');
      if (!inMaintenanceWindow(policy, now())) throw autoError('AUTO_MAINTENANCE_WINDOW_CLOSED');
      return checked;
    },
    writeJournal: async state => {
      // Persist ownership in the same write as the engine's first generation.
      if (!generationStarted && !inMaintenanceWindow(policy, now())) throw autoError('AUTO_MAINTENANCE_WINDOW_CLOSED');
      await io.writeJournal({...state, autoAuthorizationHash: fingerprint(authorization)});
      generationStarted = true;
    },
  };
  return runMaintenanceUpgrade(guarded, {action: 'apply', target: target.version});
}
