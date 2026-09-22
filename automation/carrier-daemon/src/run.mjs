import {randomUUID} from 'node:crypto';
import {
  CONTACT_POLICY,
  MAX_CANDIDATE_VALIDATIONS_PER_RUN,
  MAX_INVITATIONS_PER_RUN,
} from './constants.mjs';
import {deliverOnce} from './delivery.mjs';
import {discoverCandidates, verifyLiveCandidate} from './discovery.mjs';
import {assertInvitationPolicy, buildInvitationRequest, sha256} from './policy.mjs';
import {verifyPreflight} from './preflight.mjs';
import {resolvePublicUrl} from './security.mjs';

export class CarrierSafetyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CarrierSafetyError';
    this.fatal = true;
    this.details = details;
  }
}

function cleanError(error) {
  return {
    name: String(error?.name ?? 'Error').slice(0, 100),
    message: String(error?.message ?? error).slice(0, 500),
  };
}

export function createRunEngine({
  repository,
  config,
  runtimeState,
  preflight = verifyPreflight,
  discover = discoverCandidates,
  verifyCandidate = verifyLiveCandidate,
  resolveTarget = resolvePublicUrl,
  deliver = deliverOnce,
  idFactory = randomUUID,
}) {
  if (!repository || !config || !runtimeState) throw new Error('repository, config, and runtimeState are required');

  async function failureResult(error, runId, client = null) {
    const fatal = error?.fatal === true;
    if (fatal) {
      runtimeState.breakerOpen = true;
      runtimeState.breakerReason = String(error.message).slice(0, 500);
    }
    try {
      const options = {
        runId,
        reason: String(error?.message ?? error).slice(0, 500),
        details: error?.details ?? cleanError(error),
        fatal,
      };
      const state = client && repository.noteFailureWithClient
        ? await repository.noteFailureWithClient(client, options)
        : await repository.noteFailure(options);
      if (state.circuitOpened) {
        runtimeState.breakerOpen = true;
        runtimeState.breakerReason = String(error?.message ?? error).slice(0, 500);
      }
    } catch (evidenceError) {
      runtimeState.breakerOpen = true;
      runtimeState.breakerReason = 'failure evidence could not be persisted';
      try {
        await repository.openBreaker?.({
          runId,
          reason: runtimeState.breakerReason,
          details: {original_error: cleanError(error), evidence_error: cleanError(evidenceError)},
        });
      } catch {
        // The in-process breaker remains open even if PostgreSQL is unavailable.
      }
      return {
        kind: 'failed',
        runId,
        fatal: true,
        error: cleanError(error),
        evidenceError: cleanError(evidenceError),
      };
    }
    return {kind: 'failed', runId, fatal, error: cleanError(error)};
  }

  return async function runOnce({signal} = {}) {
    const runId = idFactory();
    if (config.disabled) return {kind: 'suppressed', reason: 'operator_disabled', runId};
    if (runtimeState.breakerOpen) {
      return {kind: 'suppressed', reason: 'in_memory_circuit_breaker', runId};
    }

    try {
      return await repository.withRunLock(async client => {
        try {
        const gate = await repository.gate(client, {maxAutomatedContacts: config.maxAutomatedContacts});
        if (!gate.allowed) {
          if (gate.reason === 'safety_limit_exceeded') {
            throw new CarrierSafetyError('database safety limit has already been exceeded', gate.counts);
          }
          return {kind: 'suppressed', reason: gate.reason, runId, nextEligibleAt: gate.nextEligibleAt ?? null};
        }

        await repository.recordEvent(client, {
          runId,
          kind: 'run_started',
          payload: {
            contact_policy: CONTACT_POLICY,
            maximum_invitations_this_run: MAX_INVITATIONS_PER_RUN,
          },
        });

        const preflightResult = await preflight({
          marketOrigin: config.marketOrigin,
          signal,
          timeoutMs: config.connectTimeoutMs,
        });
        const discovery = await discover({
          pages: config.registryPages,
          signal,
          timeoutMs: config.connectTimeoutMs,
        });
        const known = await repository.contactedHostnames(
          client,
          discovery.candidates.map(candidate => candidate.hostname),
        );

        const inspectable = discovery.candidates
          .filter(candidate => !known.has(candidate.hostname))
          .slice(0, MAX_CANDIDATE_VALIDATIONS_PER_RUN);
        const verification = await Promise.all(inspectable.map(async candidate => {
          try {
            await resolveTarget(candidate.endpoint, undefined, config.connectTimeoutMs);
            return {
              candidate: await verifyCandidate(candidate, {
                signal,
                timeoutMs: config.connectTimeoutMs,
              }),
            };
          } catch (error) {
            if (signal?.aborted) throw error;
            return {error: cleanError(error)};
          }
        }));
        const unsafeCandidates = verification.filter(result => result.error).length;
        for (const verified of verification) {
          if (!verified.candidate) continue;
          const verifiedCandidate = verified.candidate;

          const invitation = buildInvitationRequest(verifiedCandidate, {
            runId,
            marketOrigin: config.marketOrigin,
          });
          try {
            assertInvitationPolicy(invitation);
          } catch (error) {
            throw new CarrierSafetyError('invitation policy assertion failed', cleanError(error));
          }
          const wire = JSON.stringify(invitation.body);
          const requestSha256 = sha256(wire);
          const requestBytes = Buffer.byteLength(wire);
          const claimed = await repository.claimHost(client, {
            runId,
            candidate: verifiedCandidate,
            requestSha256,
            requestBytes,
            requestBody: invitation.body,
            maxAutomatedContacts: config.maxAutomatedContacts,
          });
          if (!claimed) {
            known.add(verifiedCandidate.hostname);
            continue;
          }

          const outcome = await deliver({
            candidate: verifiedCandidate,
            request: invitation,
            signal,
            timeoutMs: config.connectTimeoutMs,
          });
          if (outcome.request_sha256 !== requestSha256 || outcome.request_bytes !== requestBytes) {
            throw new CarrierSafetyError('delivered request does not match the permanently claimed request');
          }
          await repository.recordEvent(client, {
            runId,
            kind: 'delivery_outcome',
            hostname: verifiedCandidate.hostname,
            payload: {
              carrier_id: invitation.carrierId,
              target: {
                registry_id: verifiedCandidate.registryId,
                name: verifiedCandidate.name,
                manifest_url: verifiedCandidate.manifestUrl,
                endpoint: verifiedCandidate.endpoint,
                protocol_version: verifiedCandidate.protocolVersion,
                skill_id: verifiedCandidate.skillId,
                skill_name: verifiedCandidate.skillName,
              },
              ...outcome,
              claim_boundary: 'This proves one disclosed WHP invitation attempt and, where present, a response. It does not prove download, reading, demand, endorsement, adoption, evaluation, payment, issuance, standing, or propagation.',
            },
          });
          await repository.noteSuccess(client, {
            runId,
            kind: 'run_completed',
            payload: {
              result: 'one_lifetime_invitation_attempted',
              hostname: verifiedCandidate.hostname,
              registry_records: discovery.registryRecords,
              eligible_candidates: discovery.candidates.length,
              candidates_validated: verification.length,
              unsafe_candidates_skipped: unsafeCandidates,
              preflight: preflightResult,
            },
          });
          return {
            kind: 'attempted',
            runId,
            hostname: verifiedCandidate.hostname,
            responded: outcome.responded,
            httpStatus: outcome.http_status ?? null,
          };
        }

        await repository.noteSuccess(client, {
          runId,
          kind: 'run_completed',
          payload: {
            result: 'no_new_eligible_hostname',
            registry_records: discovery.registryRecords,
            eligible_candidates: discovery.candidates.length,
            candidates_validated: verification.length,
            unsafe_candidates_skipped: unsafeCandidates,
            preflight: preflightResult,
          },
        });
        return {kind: 'no_candidate', runId};
        } catch (error) {
          if (signal?.aborted) return {kind: 'aborted', runId};
          return failureResult(error, runId, client);
        }
      });
    } catch (error) {
      if (signal?.aborted) return {kind: 'aborted', runId};
      return failureResult(error, runId);
    }
  };
}
