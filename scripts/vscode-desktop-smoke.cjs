// Run inside the real VS Code extension test host against an installed VSIX.
// See docs/validation/2026-10-28-linux-vsix-smoke.md for the isolated launch.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
exports.run = async function () {
 const checks = [];
 assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'Use one empty local workspace');
 const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
 assert.equal(vscode.workspace.workspaceFolders[0].uri.scheme, 'file');
 const privateHome = process.env.CODE_CONDUCTOR_HOME;
 assert.ok(privateHome && path.isAbsolute(privateHome), 'Set an explicit absolute disposable CODE_CONDUCTOR_HOME');
 const offset = path.relative(fs.realpathSync(root), fs.realpathSync(privateHome));
 assert.ok(path.isAbsolute(offset) || offset === '..' || offset.startsWith('..' + path.sep), 'Keep private state outside the empty workspace');
 const extension = vscode.extensions.getExtension(process.env.CC_SMOKE_EXTENSION_ID || 'code-conductor-test.code-conductor-vscode');
 assert.ok(extension); await extension.activate(); checks.push('installed extension activated');
 assert.equal(vscode.workspace.isTrusted, true);
 assert.deepEqual(fs.readdirSync(root), []);
 const commands = await vscode.commands.getCommands(true);
 for (const declaration of extension.packageJSON.contributes.commands) assert.ok(commands.includes(declaration.command), declaration.command);
 checks.push('all contributed commands registered');
 await vscode.commands.executeCommand('codeConductor.openFile', undefined, 'config/roles.yaml');
 const config = vscode.window.activeTextEditor.document;
 assert.equal(config.uri.scheme, 'code-conductor-config');
 assert.match(config.getText(), /Effective configuration/); assert.match(config.getText(), /builder/); assert.match(config.getText(), /SHA-256/);
 checks.push('effective packaged defaults opened with provenance');
 await vscode.commands.executeCommand('codeConductor.inspectPacks');
 assert.equal(vscode.window.activeTextEditor.document.uri.scheme, 'code-conductor-packs');
 assert.match(vscode.window.activeTextEditor.document.getText(), /Manifest SHA-256: absent/);
 checks.push('optional absent APM inventory opened');
 const runId = 'CC-desktop-' + crypto.randomUUID();
 const runPath = path.join(process.env.CODE_CONDUCTOR_HOME, 'runs', runId);
 fs.mkdirSync(runPath, { recursive: true, mode: 0o700 });
 const manifest = { runId, task: { id: 'T-desktop', objective: 'Native installed VSIX smoke', repository: root, acceptanceCriteria: [], risk: 'R1', constraints: [], createdAt: new Date().toISOString() }, assignments: [{ id: 'A', taskId: 'T-desktop', agentId: 'builder', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', billingChannel: 'subscription', authority: ['observe'], dependsOn: [] }], results: [], gates: [] };
 try {
  fs.writeFileSync(path.join(runPath, 'manifest.json'), JSON.stringify(manifest));
  await vscode.commands.executeCommand('codeConductor.refreshRuns');
  await vscode.commands.executeCommand('codeConductor.openRun', runId);
  const uri = vscode.Uri.parse('code-conductor-run:/' + runId + '.md');
  const summary = await vscode.workspace.openTextDocument(uri);
  assert.match(summary.getText(), /Native installed VSIX smoke/); checks.push('repository-scoped native run summary opened');
  manifest.task.objective = 'Native refreshed objective';
  fs.writeFileSync(path.join(runPath, 'manifest.json'), JSON.stringify(manifest));
  await vscode.commands.executeCommand('codeConductor.refreshRuns');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(summary.getText(), /Native refreshed objective/); checks.push('open native run summary refreshed');
  const evidenceId = 'E-desktop-' + crypto.randomUUID();
  const stdout = 'Native evidence fixture without a final newline'; const stderr = '';
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const sha256 = crypto.createHash('sha256').update(digest(stdout)).update(digest(stderr)).digest('hex');
  const source = 'desktop smoke fixture (no tool invoked)';
  const outputDirectory = path.join(runPath, 'tool-output'); fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const outputPath = path.join(outputDirectory, evidenceId + '.stdout');
  fs.writeFileSync(outputPath, stdout, { mode: 0o600 }); fs.writeFileSync(path.join(outputDirectory, evidenceId + '.stderr'), stderr, { mode: 0o600 });
  fs.writeFileSync(path.join(outputDirectory, evidenceId + '.json'), JSON.stringify({ runId, evidenceId, source, status: 1, timedOut: false, truncated: false, sha256, digestMethod: 'streams', stdoutSha256: digest(stdout).toString('hex'), stderrSha256: digest(stderr).toString('hex') }), { mode: 0o600 });
  manifest.assignments.push({ id: 'V', taskId: 'T-desktop', agentId: 'validator', role: 'validator', stance: 'neutral', provider: 'local', harness: 'internal', billingChannel: 'local', authority: ['observe'], dependsOn: [] });
  manifest.results.push({ taskId: 'T-desktop', assignmentId: 'V', agentId: 'validator', role: 'validator', stance: 'neutral', provider: 'local', harness: 'internal', billingChannel: 'local', status: 'completed', changes: [], tests: [], evidence: [{ id: evidenceId, kind: 'test', source, summary: 'Synthetic capture for UI integrity checks', sha256, uri: 'command:untrusted.never-invoke' }], findings: [], risks: [], blockers: [], recommendation: 'changes_required' });
  manifest.gates.push({ gate: 'native-fixture', status: 'failed', evidenceIds: [evidenceId] });
  fs.writeFileSync(path.join(runPath, 'manifest.json'), JSON.stringify(manifest)); await vscode.commands.executeCommand('codeConductor.refreshRuns');
  await vscode.commands.executeCommand('codeConductor.openEvidence', runId, evidenceId);
  const evidenceUri = vscode.Uri.from({ scheme: 'code-conductor-evidence', path: `/${runId}/${evidenceId}.txt`, query: root });
  const evidenceDocument = await vscode.workspace.openTextDocument(evidenceUri);
  assert.match(evidenceDocument.getText(), /Native evidence fixture/); assert.match(evidenceDocument.getText(), /Manifest gate verdict: native-fixture: failed/);
  assert.ok(!evidenceDocument.getText().includes('untrusted.never-invoke')); checks.push('native evidence opens verified manifest-bound streams without following evidence URI');
  fs.writeFileSync(outputPath, 'Altered fixture');
  const waitFor = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Native evidence document did not revalidate'); await new Promise(resolve => setTimeout(resolve, 50)); } };
  await waitFor(() => evidenceDocument.getText().includes('cannot be verified')); checks.push('native capture watcher invalidates an altered open evidence document');
  await vscode.commands.executeCommand('codeConductor.openEvidence', runId, evidenceId);
  assert.match(evidenceDocument.getText(), /cannot be verified/); checks.push('reopening cached native evidence revalidates capture');
  fs.writeFileSync(outputPath, stdout); await waitFor(() => evidenceDocument.getText().includes('Native evidence fixture')); checks.push('native evidence refresh restores only matching original capture');
  let listener; let timer;
  const ended = new Promise((resolve, reject) => {
   timer = setTimeout(() => { listener.dispose(); reject(new Error('Native validation task did not complete in 45s')); }, 45000);
   listener = vscode.tasks.onDidEndTaskProcess(event => {
    if (event.execution.task.definition.type === 'code-conductor' && event.execution.task.definition.operation === 'workspace-validate') { clearTimeout(timer); listener.dispose(); resolve(event.exitCode); }
   });
  });
  try { await vscode.commands.executeCommand('codeConductor.validate'); assert.equal(await ended, 0); }
  finally { clearTimeout(timer); listener?.dispose(); }
  checks.push('bundled native ProcessExecution validation completed successfully');
  assert.deepEqual(fs.readdirSync(root), []); checks.push('unrelated workspace stayed empty');
  const reports = path.join(privateHome, 'reports'); fs.mkdirSync(reports, { recursive: true, mode: 0o700 });
  const report = path.join(reports, runId + '.json');
  const bundles = Object.fromEntries(['extension.js', 'ccon.js'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, 'dist', name))).digest('hex')]));
  fs.writeFileSync(report, JSON.stringify({ observedAt: new Date().toISOString(), vscode: vscode.version, platform: process.platform, extension: extension.id, extensionVersion: extension.packageJSON.version, bundles, checks }, null, 2), { mode: 0o600 });
  console.log('Installed VSIX smoke PASS: ' + report);
 } finally { fs.rmSync(runPath, { recursive: true, force: true }); }
};
