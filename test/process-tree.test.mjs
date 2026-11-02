import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../lib/process-tree.mjs';

function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitUntilGone(pid, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (running(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  return !running(pid);
}

function spawnFixture(script) {
  const child = spawn(process.execPath, ['-e', script], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error(`Fixture failed to start: ${errors}`)), 5000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (!output.includes('\n')) reject(new Error(`Fixture exited ${code}: ${errors}`)); });
  });
  return { child, ready };
}

test('requires an owned ChildProcess handle instead of accepting arbitrary PIDs', async () => {
  await assert.rejects(terminateProcessTree(process.pid), TypeError);
  await assert.rejects(terminateProcessTree({ pid: process.pid, exitCode: null, signalCode: null }), TypeError);
});

test('stops an active child and waits until its process has exited', async t => {
  const fixture = spawnFixture('console.log(JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000);');
  t.after(async () => { if (fixture.child.exitCode === null && fixture.child.signalCode === null) await terminateProcessTree(fixture.child); });
  const { pid } = await fixture.ready;
  assert.equal(pid, fixture.child.pid);
  assert.equal(running(pid), true);
  const result = await terminateProcessTree(fixture.child);
  assert.equal(result.terminated, true);
  assert.equal(await waitUntilGone(pid), true);
  if (process.platform === 'win32') {
    assert.equal(result.treeTerminated, true);
    assert.equal(result.outcomeUnknown, false);
  }
});

test('on Windows stops an owned child and its Node grandchild', { skip: process.platform !== 'win32' }, async t => {
  const script = `
    const {spawn} = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {windowsHide:true, shell:false, stdio:'ignore'});
    grandchild.once('spawn', () => console.log(JSON.stringify({pid:process.pid, grandchild:grandchild.pid})));
    grandchild.once('error', error => { console.error(error); process.exit(1); });
    setInterval(() => {}, 1000);
  `;
  const fixture = spawnFixture(script);
  let grandchildPid;
  t.after(async () => {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) await terminateProcessTree(fixture.child);
    // This ID is produced only by the trusted fixture above; never inspect or
    // terminate any process discovered outside this test's own process tree.
    if (grandchildPid && running(grandchildPid)) {
      try { process.kill(grandchildPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const info = await fixture.ready;
  grandchildPid = info.grandchild;
  assert.equal(info.pid, fixture.child.pid);
  assert.equal(running(info.pid), true);
  assert.equal(running(grandchildPid), true);
  const result = await terminateProcessTree(fixture.child);
  assert.equal(result.terminated, true);
  assert.equal(result.treeTerminated, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(await waitUntilGone(info.pid), true);
  assert.equal(await waitUntilGone(grandchildPid), true);
});

test('does not invoke termination against an already exited child handle', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.deepEqual(await terminateProcessTree(child), { terminated: true, treeTerminated: false, outcomeUnknown: true });
});
