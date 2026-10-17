#!/usr/bin/env node
// A stand-in for gh in tests/scripts/owner-scripts.test.ts. It keeps a small model of one
// repository in the JSON file named by FAKE_GH_STATE, answers the REST calls the owner
// scripts make from it, and appends every call to state.calls.
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const argv = process.argv.slice(2);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const reply = (value) => { if (value !== undefined) process.stdout.write(JSON.stringify(value)); save(); process.exit(0); };
const fail = (message) => { process.stderr.write(`HTTP 404: ${message}\n`); save(); process.exit(1); };
const option = (name) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };

if (argv[0] === 'auth') { state.calls.push({ argv }); reply(); }
if (argv[0] === 'variable') { state.calls.push({ argv }); state.variables[argv[2]] = option('--body'); reply(); }
if (argv[0] === 'attestation') { state.calls.push({ argv }); if (state.attestationOk) reply(); fail('no matching attestation'); }
if (argv[0] === 'issue') { state.calls.push({ argv, body: readFileSync(option('--body-file'), 'utf8') }); reply(); }
if (argv[0] !== 'api') fail(`unexpected gh ${argv.join(' ')}`);

const takesValue = new Set(['--hostname', '--method', '-H', '--input', '--jq']);
const endpoint = argv.slice(1).find((arg, i, rest) => !arg.startsWith('-') && !takesValue.has(rest[i - 1]));
const method = option('--method') ?? 'GET';
const body = option('--input') ? JSON.parse(readFileSync(option('--input'), 'utf8')) : undefined;
state.calls.push({ method, endpoint, body });
const url = new URL(endpoint, 'https://api.invalid/');
const path = url.pathname.slice(1);
const page = Number(url.searchParams.get('page') ?? '1');
const list = (items) => reply(page > 1 ? [] : items);
const repo = `repos/${state.repository}`;

const ruleset = /^rulesets\/(\d+)$/;
const sub = path.startsWith(`${repo}/`) ? path.slice(repo.length + 1) : path === repo ? '' : undefined;
if (sub === undefined) {
  if (path === 'user') reply(state.user);
  if (path.startsWith('users/')) reply({ ...state.user, login: path.slice(6) });
  fail(path);
}
const route = `${method} ${sub}`;
if (route === 'GET ') reply(state.repo);
if (route === 'PATCH ') {
  const { security_and_analysis: security, ...rest } = body;
  Object.assign(state.repo, rest);
  if (security) Object.assign(state.repo.security_and_analysis, security);
  reply(state.repo);
}
if (route === 'GET rulesets') list(state.rulesets.map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement })));
if (route === 'POST rulesets') { const created = { id: state.nextId++, ...body }; state.rulesets.push(created); reply(created); }
if (method === 'PUT' && ruleset.test(sub)) {
  const id = Number(ruleset.exec(sub)[1]);
  state.rulesets = state.rulesets.map((item) => (item.id === id ? { id, ...body } : item));
  reply({ id, ...body });
}
if (method === 'GET' && ruleset.test(sub)) reply(state.rulesets.find((item) => item.id === Number(ruleset.exec(sub)[1])) ?? fail(sub));
if (route === `GET rules/branches/${state.repo?.default_branch}`) {
  list(state.rulesets.filter((item) => item.target === 'branch' && item.enforcement === 'active' && item.conditions.ref_name.include.includes('~DEFAULT_BRANCH'))
    .flatMap((item) => item.rules.map((rule) => ({ ...rule, ruleset_id: item.id })))
    // dropCheck: GitHub does not enforce that check (for example, it was renamed).
    .map((rule) => (rule.type === 'required_status_checks' && state.dropCheck
      ? { ...rule, parameters: { ...rule.parameters, required_status_checks: rule.parameters.required_status_checks.filter((check) => check.context !== state.dropCheck) } }
      : rule)));
}
if (route === 'PUT private-vulnerability-reporting') { if (!state.stuckReporting) state.reporting = true; reply(); }
if (route === 'GET private-vulnerability-reporting') reply({ enabled: state.reporting });
if (route === 'PUT actions/permissions/workflow') { Object.assign(state.workflow, body); reply(); }
if (route === 'GET actions/permissions/workflow') reply(state.workflow);
if (route === 'PUT environments/marketplace') { state.environment = body; reply(body); }
if (route === 'GET environments/marketplace/deployment-branch-policies') reply({ total_count: state.policies.length, branch_policies: state.policies });
if (route === 'POST environments/marketplace/deployment-branch-policies') { const created = { id: state.nextId++, ...body }; state.policies.push(created); reply(created); }
if (route === 'GET branches') list(state.branches);
if (route === 'GET pulls') list(state.pulls.filter((pull) => `${state.repository.split('/')[0]}:${pull.head.ref}` === url.searchParams.get('head')));
if (method === 'GET' && sub.startsWith('compare/')) {
  const head = sub.split('...')[1];
  const ahead = state.branches?.find((branch) => branch.commit.sha === head)?.ahead ?? 0;
  // compare/<commit>...main asks whether the commit is on main.
  const value = head === 'main' ? { status: state.commitOnMain ? 'ahead' : 'diverged' } : { ahead_by: ahead, status: ahead ? 'diverged' : 'behind' };
  if (option('--jq') === '.status') { process.stdout.write(value.status); save(); process.exit(0); }
  reply(value);
}
if (method === 'DELETE' && sub.startsWith('git/refs/heads/')) {
  const name = decodeURIComponent(sub.slice('git/refs/heads/'.length));
  state.branches = state.branches.filter((branch) => branch.name !== name);
  reply();
}
fail(route);
