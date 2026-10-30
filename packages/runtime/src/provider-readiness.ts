import { configurationInsideRepository, type ClientAuthStatus, type HarnessAdapter } from '@code-conductor/adapters';
import type { AgentAssignment } from '@code-conductor/schemas';
import { CLIENT_BILLS_SEPARATELY, CLIENT_NOT_SIGNED_IN } from './next-actions.js';

export type HarnessTrustCheck = (harness: string, mode: 'read' | 'modify', surface?: string, clientVersion?: string) => boolean;

/** Shared official-client readiness. This performs probes, never provider execution. */
export async function providerReadinessProblem(root: string, assignment: AgentAssignment, adapter: HarnessAdapter, trusted?: HarnessTrustCheck, requireAuth = false): Promise<string | undefined> {
  if (assignment.surface && adapter.executionSurface !== assignment.surface) return `Harness ${assignment.harness} is configured for ${assignment.surface}, but the installed adapter exposes ${adapter.executionSurface}.`;
  const mode = assignment.authority.includes('modify_worktree') ? 'modify' : 'read';
  const version = adapter.version();
  if (!trusted?.(assignment.harness, mode, assignment.surface ?? adapter.executionSurface, version)) return `Harness ${assignment.harness} surface ${assignment.surface ?? adapter.executionSurface} has not passed Code Conductor workstation ${mode} smoke validation${version ? ` for its installed version (${version})` : ''}.`;
  const inside = configurationInsideRepository(assignment.harness, root);
  if (inside.length) return `Harness ${assignment.harness} would read its user configuration from inside the repository: ${inside.join(', ')}. The repository could then supply the client's settings (hooks, environment, credential helper) after the sign-in check. Point it outside the repository. The provider was not started.`;
  if (!adapter.authStatus) return requireAuth ? 'Official subscription authentication could not be checked. The provider was not started.' : undefined;
  let auth: ClientAuthStatus;
  try { auth = await adapter.authStatus(); }
  catch { auth = { state: 'unknown', billing: 'unknown', command: [adapter.command ?? assignment.harness] }; }
  const command = `\`${auth.command.join(' ')}\``;
  if (auth.state !== 'authenticated') return `Harness ${assignment.harness} ${CLIENT_NOT_SIGNED_IN}: ${command} ${auth.state === 'unauthenticated' ? 'reports that it is not signed in' : 'did not report a sign-in state Code Conductor recognises'}. Sign in with the official client (\`ccon doctor\` shows how), then run the task again. The provider was not started.`;
  if (assignment.billingChannel === 'subscription' && auth.billing !== 'subscription') return `Harness ${assignment.harness} ${auth.billing === 'separately_billed' ? 'would use' : 'may use'} ${CLIENT_BILLS_SEPARATELY} (${auth.method ?? 'unrecognised method'}, from ${command}) for an assignment billed to the subscription (subscription_first). Sign in with your subscription in the official client, or remove that credential from the client's own configuration. The provider was not started.`;
  return undefined;
}
