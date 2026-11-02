import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { inspectRepository, getCommit, planChange, applyChange, pushCommit, refreshRemote } from '../lib/git.mjs';

const exec = promisify(execFile);
const oldDate = '2001-02-03T04:05:06+03:00';
async function git(path, ...args) {
  const result = await exec('git', args, {
    cwd: path, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
  return result.stdout.trim();
}

async function fixture(t, { remote = true } = {}) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'commit-bloom-test-'));
  const path = join(root, 'repo');
  await mkdir(path);
  t.after(async () => {
    const actual = await realpath(root);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('commit-bloom-test-'));
    await rm(actual, { recursive: true, force: true });
  });
  await git(path, 'init', '-b', 'main');
  await git(path, 'config', 'user.name', 'Тестовый Автор');
  await git(path, 'config', 'user.email', 'author@example.test');
  await git(path, 'config', 'commit.gpgsign', 'false');
  await git(path, 'config', 'core.autocrlf', 'false');
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    await writeFile(join(path, `file-${i}.txt`), `content ${i}\n`);
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', `Коммит ${i}`, '-m', `Тело сообщения ${i}.`);
    ids.push(await git(path, 'rev-parse', 'HEAD'));
  }
  if (remote) {
    await git(root, 'init', '--bare', 'remote.git');
    await git(path, 'remote', 'add', 'origin', join(root, 'remote.git'));
    await git(path, 'push', 'origin', `${ids[0]}:refs/heads/main`);
  }
  return { root, path, ids, remotePath: join(root, 'remote.git') };
}

test('reads Unicode messages, files, patches, current branch and published markers', async (t) => {
  const repo = await fixture(t);
  const state = await inspectRepository({ path: repo.path });
  assert.equal(state.currentBranch, 'main');
  assert.equal(state.commits.length, 3);
  assert.equal(state.commits[2].published, true);
  assert.equal(state.commits[1].published, false);
  assert.equal(state.commits[0].subject, 'Коммит 3');
  const details = await getCommit({ path: repo.path, oid: repo.ids[1] });
  assert.match(details.message, /Тело сообщения 2/);
  assert.deepEqual(details.files, [{ status: 'A', path: 'file-2.txt' }]);
  assert.match(details.patch, /content 2/);
});

test('counts complete histories even when the displayed list is limited', async (t) => {
  const repo = await fixture(t);
  const state = await inspectRepository({ path: repo.path, limit: 1 });
  assert.equal(state.ahead, 2);
  assert.equal(state.behind, 0);
  assert.equal(state.historyLimited, true);
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].isLocal, true);
});

test('shows remote-only commits and allows reading but never rewriting them', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  await git(repo.path, 'reset', '--hard', repo.ids[0]);
  let state = await inspectRepository({ path: repo.path });
  assert.equal(state.ahead, 0);
  assert.equal(state.behind, 2);
  assert.deepEqual(state.commits.filter(c => !c.isLocal).map(c => c.oid), [repo.ids[2], repo.ids[1]]);
  assert.equal(state.commits.find(c => c.isRemoteHead).oid, repo.ids[2]);
  const details = await getCommit({ path: repo.path, remote: 'origin', oid: repo.ids[2] });
  assert.equal(details.subject, 'Коммит 3');
  await assert.rejects(planChange({ path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[2], message: 'No', push: false }), { code: 'COMMIT_NOT_IN_BRANCH' });
  await git(repo.path, 'commit', '--allow-empty', '-m', 'Локальное ответвление');
  state = await inspectRepository({ path: repo.path });
  assert.equal(state.ahead, 1);
  assert.equal(state.behind, 2);
});

test('refresh follows the push destination and removes a deleted server branch from the cache', async (t) => {
  const repo = await fixture(t);
  const pushPath = join(repo.root, 'push.git');
  await git(repo.root, 'init', '--bare', pushPath);
  await git(repo.path, 'remote', 'set-url', '--push', 'origin', pushPath);
  await git(repo.path, 'push', 'origin', 'main');
  const fresh = await refreshRemote({ path: repo.path, remote: 'origin' });
  assert.equal(fresh.remoteHead, repo.ids[2]);
  assert.equal(fresh.ahead, 0);
  assert.equal(fresh.behind, 0);
  assert.equal(fresh.remoteBranchExists, true);
  assert.ok(Number.isFinite(Date.parse(fresh.remoteCheckedAt)));
  await git(pushPath, 'update-ref', '-d', 'refs/heads/main');
  const missing = await refreshRemote({ path: repo.path, remote: 'origin' });
  assert.equal(missing.remoteHead, null);
  assert.equal(missing.remoteBranchExists, false);
  assert.equal(missing.ahead, 3);
  assert.ok(missing.commits.every(c => c.isLocal && !c.published));
});

test('rewrites selected metadata and descendants without touching staged or working files', async (t) => {
  const repo = await fixture(t);
  await writeFile(join(repo.path, 'file-1.txt'), 'staged change\n');
  await git(repo.path, 'add', 'file-1.txt');
  await writeFile(join(repo.path, 'file-1.txt'), 'unstaged change\n');
  const beforeStatus = await git(repo.path, 'status', '--porcelain=v1');
  const beforeTree = await git(repo.path, 'rev-parse', 'HEAD^{tree}');
  const beforeIndex = await git(repo.path, 'write-tree');
  const originalChild = await git(repo.path, 'show', '-s', '--format=%B%n%aI%n%cI', repo.ids[2]);
  const before = Date.now() - 1000;
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Новое сообщение\n\nПодробности на русском.', useCurrentDate: true, push: false };
  const plan = await planChange(request);
  assert.equal(plan.affectedCount, 2);
  assert.equal(plan.publishedAffectedCount, 0);
  const result = await applyChange({ ...request, ...plan });
  assert.notEqual(result.newOid, repo.ids[1]);
  assert.equal(await git(repo.path, 'rev-parse', `${result.head}^{tree}`), beforeTree);
  assert.equal(await git(repo.path, 'write-tree'), beforeIndex);
  assert.equal(await git(repo.path, 'status', '--porcelain=v1'), beforeStatus);
  assert.equal(await readFile(join(repo.path, 'file-1.txt'), 'utf8'), 'unstaged change\n');
  assert.equal(await git(repo.path, 'rev-parse', result.backupRef), repo.ids[2]);
  assert.equal(await git(repo.path, 'show', '-s', '--format=%B%n%aI%n%cI', result.head), originalChild);
  const edited = await getCommit({ path: repo.path, oid: result.newOid });
  assert.equal(edited.message, request.message);
  assert.ok(Date.parse(edited.authorDate) >= before);
  assert.ok(Date.parse(edited.committerDate) >= before);
  assert.equal(edited.authorName, 'Тестовый Автор');
});

test('save-and-push sends only selected unpushed commit, leaving later commits local', async (t) => {
  const repo = await fixture(t);
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Отправленный второй', useCurrentDate: true, push: true };
  const plan = await planChange(request);
  const result = await applyChange({ ...request, ...plan });
  assert.equal(result.pushed, true);
  assert.equal(await git(repo.path, 'ls-remote', 'origin', 'refs/heads/main'), `${result.newOid}\trefs/heads/main`);
  assert.notEqual(result.head, result.newOid);
  assert.equal(await git(repo.path, 'rev-parse', 'HEAD'), result.head);
});

test('custom date updates both identities with the chosen offset and preserves descendant metadata and trees', async (t) => {
  const repo = await fixture(t, { remote: false });
  const original = await getCommit({ path: repo.path, oid: repo.ids[1] });
  const child = await git(repo.path, 'show', '-s', '--format=%B%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%T', repo.ids[2]);
  const tree = await git(repo.path, 'rev-parse', `${repo.ids[1]}^{tree}`);
  const request = { path: repo.path, branch: 'main', oid: repo.ids[1], message: original.message, useCurrentDate: false, customDate: '2020-02-29T23:45:12+05:45', push: false };
  const plan = await planChange(request);
  assert.equal(plan.changed, true);
  assert.equal(plan.affectedCount, 2);
  assert.equal(plan.customDate, request.customDate);
  const result = await applyChange({ ...request, ...plan });
  assert.equal(await git(repo.path, 'show', '-s', '--format=%aI%n%cI', result.newOid), `${request.customDate}\n${request.customDate}`);
  assert.equal(await git(repo.path, 'rev-parse', `${result.newOid}^{tree}`), tree);
  assert.equal(await git(repo.path, 'show', '-s', '--format=%B%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%T', result.head), child);
  const edited = await getCommit({ path: repo.path, oid: result.newOid });
  assert.equal(edited.authorName, original.authorName);
  assert.equal(edited.authorEmail, original.authorEmail);
  assert.equal(edited.authorDate, new Date(request.customDate).toISOString());
  assert.equal(edited.committerDate, edited.authorDate);
});

test('custom date supports future times and negative offsets when saving and pushing', async (t) => {
  const repo = await fixture(t);
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], customDate: '2032-12-31T23:59:58-03:30', push: true };
  const result = await applyChange({ ...request, ...await planChange(request) });
  assert.equal(result.pushed, true);
  assert.equal(await git(repo.path, 'show', '-s', '--format=%aI%n%cI', result.newOid), `${request.customDate}\n${request.customDate}`);
  assert.equal(await git(repo.path, 'ls-remote', 'origin', 'refs/heads/main'), `${result.newOid}\trefs/heads/main`);
});

test('the original custom date is a no-op and leaving dates unspecified preserves both identities', async (t) => {
  const repo = await fixture(t, { remote: false });
  const request = { path: repo.path, branch: 'main', oid: repo.ids[1], customDate: oldDate, push: false };
  const plan = await planChange(request);
  assert.equal(plan.changed, false);
  const result = await applyChange({ ...request, ...plan });
  assert.equal(result.newOid, repo.ids[1]);
  assert.equal(result.head, repo.ids[2]);
  assert.equal(result.backupRef, null);
  const edit = { ...request, customDate: undefined, message: 'Only the message changes' };
  const saved = await applyChange({ ...edit, ...await planChange(edit) });
  assert.equal(await git(repo.path, 'show', '-s', '--format=%aI%n%cI', saved.newOid), `${oldDate}\n${oldDate}`);
});

test('rejects invalid, ambiguous or out-of-range custom dates before rewriting', async (t) => {
  const repo = await fixture(t, { remote: false });
  const request = { path: repo.path, branch: 'main', oid: repo.ids[1], push: false };
  for (const customDate of ['', 'tomorrow', 123, {}, '2025-02-29T12:00:00Z', '2024-02-30T12:00:00Z', '2024-13-01T12:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T12:60:00Z', '2024-01-01T12:00:60Z', '2024-01-01T12:00:00', '2024-01-01T12:00:00+24:00', '2024-01-01T12:00:00+03:60', '1969-12-31T23:59:59Z', '1970-01-01T00:00:00+03:00']) {
    await assert.rejects(planChange({ ...request, customDate }), { code: 'INVALID_DATE' }, String(customDate));
  }
  await assert.rejects(planChange({ ...request, customDate: '2024-01-01T12:00:00Z', useCurrentDate: true }), { code: 'INVALID_DATE' });
  assert.equal(await git(repo.path, 'rev-parse', 'HEAD'), repo.ids[2]);
  assert.equal(await git(repo.path, 'for-each-ref', 'refs/commit-bloom'), '');
});

test('unchanged push-only does not rewrite metadata or create backup refs', async (t) => {
  const repo = await fixture(t);
  const commit = await getCommit({ path: repo.path, oid: repo.ids[1] });
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: commit.message, useCurrentDate: false, push: true };
  const plan = await planChange(request);
  assert.equal(plan.changed, false);
  assert.equal(plan.affectedCount, 0);
  const result = await applyChange({ ...request, ...plan });
  assert.equal(result.newOid, repo.ids[1]);
  assert.equal(result.head, repo.ids[2]);
  assert.equal(result.backupRef, null);
  assert.equal(result.pushed, true);
  const again = await pushCommit({ ...request, expectedRemoteHead: repo.ids[1] });
  assert.equal(again.alreadyPublished, true);
});

test('explicit pushOnly ignores edited text and all date fields', async (t) => {
  const repo = await fixture(t);
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Этот текст не должен примениться', useCurrentDate: true, customDate: 'invalid unsaved date', push: true, pushOnly: true };
  const plan = await planChange(request);
  assert.equal(plan.changed, false);
  assert.equal(plan.useCurrentDate, false);
  assert.equal(plan.customDate, null);
  const result = await applyChange({ ...request, ...plan });
  assert.equal(result.newOid, repo.ids[1]);
  assert.equal(result.head, repo.ids[2]);
  assert.equal(result.backupRef, null);
  assert.equal(result.pushed, true);
});

test('rewritten UTF8 messages override an incompatible configured commit encoding', async (t) => {
  const repo = await fixture(t, { remote: false });
  await git(repo.path, 'config', 'i18n.commitEncoding', 'ISO-8859-1');
  const request = { path: repo.path, branch: 'main', oid: repo.ids[1], message: 'Русское сообщение 🌸', useCurrentDate: false, push: false };
  const plan = await planChange(request);
  const result = await applyChange({ ...request, ...plan });
  const raw = await git(repo.path, 'cat-file', 'commit', result.newOid);
  assert.doesNotMatch(raw, /^encoding /m);
  assert.match(raw, /Русское сообщение 🌸/);
});

test('published rewrite requires opt-in and preserves already-published descendants', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Переписанный опубликованный', useCurrentDate: false, push: true };
  const plan = await planChange(request);
  assert.equal(plan.needsForce, true);
  assert.equal(plan.publishedAffectedCount, 2);
  await assert.rejects(applyChange({ ...request, ...plan }), { code: 'PUBLISHED_CONFIRMATION' });
  assert.equal(await git(repo.path, 'rev-parse', 'HEAD'), repo.ids[2]);
  const result = await applyChange({ ...request, ...plan, allowPublishedRewrite: true });
  assert.equal(result.pushed, true);
  assert.notEqual(result.head, result.newOid);
  assert.equal(await git(repo.path, 'ls-remote', 'origin', 'refs/heads/main'), `${result.head}\trefs/heads/main`);
  assert.equal(await git(repo.path, 'rev-parse', `${result.head}^{tree}`), await git(repo.path, 'rev-parse', `${repo.ids[2]}^{tree}`));
});

test('stale local plan and changed remote are rejected before rewriting', async (t) => {
  const repo = await fixture(t);
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Передвинутый план', useCurrentDate: true, push: true };
  const plan = await planChange(request);
  await git(repo.path, 'push', 'origin', `${repo.ids[1]}:refs/heads/main`);
  await assert.rejects(applyChange({ ...request, ...plan }), { code: 'REMOTE_CHANGED' });
  assert.equal(await git(repo.path, 'rev-parse', 'HEAD'), repo.ids[2]);
  const localPlan = await planChange({ ...request, push: false });
  await git(repo.path, 'commit', '--allow-empty', '-m', 'Concurrent commit');
  await assert.rejects(applyChange({ ...request, ...localPlan }), { code: 'HEAD_CHANGED' });
});

test('preserves merge graph and secondary parent when rewriting a mainline ancestor', async (t) => {
  const repo = await fixture(t, { remote: false });
  await git(repo.path, 'switch', '-c', 'side', repo.ids[0]);
  await writeFile(join(repo.path, 'side.txt'), 'side\n');
  await git(repo.path, 'add', '.');
  await git(repo.path, 'commit', '-m', 'Side');
  const side = await git(repo.path, 'rev-parse', 'HEAD');
  await git(repo.path, 'switch', 'main');
  await git(repo.path, 'merge', '--no-ff', 'side', '-m', 'Merge side');
  const beforeTree = await git(repo.path, 'rev-parse', 'HEAD^{tree}');
  const request = { path: repo.path, branch: 'main', oid: repo.ids[1], message: 'Изменённый предок', useCurrentDate: false, push: false };
  const plan = await planChange(request);
  const result = await applyChange({ ...request, ...plan });
  const merge = await getCommit({ path: repo.path, oid: result.head });
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.parents[1], side);
  assert.equal(await git(repo.path, 'rev-parse', 'HEAD^{tree}'), beforeTree);
});

test('blocks in-progress operations, wrong branches and command-like remote inputs', async (t) => {
  const repo = await fixture(t);
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Safe', useCurrentDate: false, push: false };
  await assert.rejects(planChange({ ...request, branch: 'other' }), { code: 'WRONG_BRANCH' });
  await assert.rejects(planChange({ ...request, remote: '--upload-pack=bad' }), { code: 'INVALID_REMOTE' });
  const gitPath = await git(repo.path, 'rev-parse', '--git-path', 'rebase-merge');
  await mkdir(join(repo.path, gitPath));
  await assert.rejects(planChange(request), { code: 'OPERATION_IN_PROGRESS' });
});

test('blocks signed history rather than dropping signatures', async (t) => {
  const repo = await fixture(t, { remote: false });
  const original = await git(repo.path, 'cat-file', 'commit', repo.ids[2]);
  const raw = original.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake-signature\n -----END PGP SIGNATURE-----\n\n') + '\n';
  // Hash only the generated fixture file; no repository hooks or signing tools run.
  const objectFile = join(repo.root, 'signed-commit.txt');
  await writeFile(objectFile, raw);
  const signedOid = await git(repo.path, 'hash-object', '-t', 'commit', '-w', objectFile);
  await git(repo.path, 'update-ref', 'refs/heads/main', signedOid);
  const request = { path: repo.path, branch: 'main', oid: signedOid, message: 'Edit signed', useCurrentDate: false, push: false };
  await assert.rejects(planChange(request), { code: 'SIGNED_HISTORY' });
});

test('saved published rewrite can later be pushed with lineage and keeps published descendants', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  const save = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Сначала сохранить', useCurrentDate: false, push: false };
  const saved = await applyChange({ ...save, ...await planChange(save), allowPublishedRewrite: true });
  assert.equal(await git(repo.path, 'rev-parse', `refs/commit-bloom/rewrites/${repo.ids[2]}`), saved.head);
  assert.equal(await git(repo.path, 'ls-remote', 'origin', 'refs/heads/main'), `${repo.ids[2]}\trefs/heads/main`);
  const push = { path: repo.path, branch: 'main', remote: 'origin', oid: saved.newOid, pushOnly: true, push: true };
  const plan = await planChange(push);
  assert.equal(plan.changed, false);
  assert.equal(plan.needsForce, true);
  assert.equal(plan.pushTargetOid, saved.head);
  await assert.rejects(applyChange({ ...push, ...plan }), { code: 'PUBLISHED_CONFIRMATION' });
  const sent = await applyChange({ ...push, ...plan, allowPublishedRewrite: true });
  assert.equal(sent.pushed, true);
  assert.equal(sent.pushedOid, saved.head);
  assert.equal(await git(repo.path, 'ls-remote', 'origin', 'refs/heads/main'), `${saved.head}\trefs/heads/main`);
});

test('failed protected push can be retried after a successful local rewrite', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  const hook = join(repo.path, '.git', 'hooks', 'pre-push');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Сохранено, но не отправлено', useCurrentDate: false, push: true };
  const first = await applyChange({ ...request, ...await planChange(request), allowPublishedRewrite: true });
  assert.equal(first.pushed, false);
  assert.ok(first.pushError);
  assert.notEqual(first.head, repo.ids[2]);
  await unlink(hook);
  const retry = { path: repo.path, branch: 'main', remote: 'origin', oid: first.newOid, push: true, pushOnly: true };
  const plan = await planChange(retry);
  assert.equal(plan.needsForce, true);
  const result = await applyChange({ ...retry, ...plan, allowPublishedRewrite: true });
  assert.equal(result.pushed, true);
  assert.equal(result.pushedOid, first.head);
});

test('repeated saved rewrites follow persisted lineage across each changed hash', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  const initial = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Редакция первая', useCurrentDate: false, push: false };
  const first = await applyChange({ ...initial, ...await planChange(initial), allowPublishedRewrite: true });
  const again = { ...initial, oid: first.newOid, message: 'Редакция вторая' };
  const second = await applyChange({ ...again, ...await planChange(again), allowPublishedRewrite: true });
  const push = { path: repo.path, branch: 'main', remote: 'origin', oid: second.newOid, push: true, pushOnly: true };
  const plan = await planChange(push);
  assert.equal(plan.rewrittenRemoteHead, second.head);
  const result = await applyChange({ ...push, ...plan, allowPublishedRewrite: true });
  assert.equal(result.pushedOid, second.head);
  assert.equal(await git(repo.path, 'rev-parse', `${second.head}^{tree}`), await git(repo.path, 'rev-parse', `${repo.ids[2]}^{tree}`));
});

test('unknown remote advancement is rejected rather than treating it as an app rewrite', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  const save = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Локальное изменение', useCurrentDate: false, push: false };
  const saved = await applyChange({ ...save, ...await planChange(save), allowPublishedRewrite: true });
  const originalTree = await git(repo.path, 'rev-parse', `${repo.ids[2]}^{tree}`);
  const unrelatedTip = await git(repo.path, 'commit-tree', originalTree, '-p', repo.ids[2], '-m', 'Independent remote advancement');
  await git(repo.path, 'push', 'origin', `${unrelatedTip}:refs/heads/main`);
  const push = { path: repo.path, branch: 'main', remote: 'origin', oid: saved.newOid, pushOnly: true, push: true };
  await assert.rejects(planChange(push), { code: 'DIVERGED_HISTORY' });
  assert.equal(await git(repo.path, 'rev-parse', 'HEAD'), saved.head);
});

test('push-only common published ancestor never sends a later saved rewrite', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  const save = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Ещё не отправленная правка', useCurrentDate: false, push: false };
  const saved = await applyChange({ ...save, ...await planChange(save), allowPublishedRewrite: true });
  const push = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[0], pushOnly: true, push: true };
  const plan = await planChange(push);
  assert.equal(plan.needsForce, false);
  assert.equal(plan.pushTargetOid, repo.ids[0]);
  const result = await applyChange({ ...push, ...plan });
  assert.equal(result.alreadyPublished, true);
  assert.equal(result.pushed, false);
  assert.equal(await git(repo.path, 'rev-parse', 'HEAD'), saved.head);
  assert.equal(await git(repo.path, 'ls-remote', 'origin', 'refs/heads/main'), `${repo.ids[2]}\trefs/heads/main`);
});

test('push planning reads the single push URL even when fetch URL points elsewhere', async (t) => {
  const repo = await fixture(t);
  const other = join(repo.root, 'push-only.git');
  await git(repo.root, 'init', '--bare', other);
  await git(repo.path, 'remote', 'set-url', '--add', '--push', 'origin', other);
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], pushOnly: true, push: true };
  const plan = await planChange(request);
  assert.equal(plan.expectedRemoteHead, null);
  assert.equal(plan.pushUrl, other);
  const result = await applyChange({ ...request, ...plan });
  assert.equal(result.pushed, true);
  assert.equal((await inspectRepository({ path: repo.path, remote: 'origin' })).remoteHead, repo.ids[1]);
  assert.equal(await git(repo.path, 'ls-remote', other, 'refs/heads/main'), `${repo.ids[1]}\trefs/heads/main`);
  assert.equal(await git(repo.path, 'ls-remote', join(repo.root, 'remote.git'), 'refs/heads/main'), `${repo.ids[0]}\trefs/heads/main`);
});

test('multiple push URLs are rejected before either server is written', async (t) => {
  const repo = await fixture(t);
  const other = join(repo.root, 'second-push.git');
  await git(repo.root, 'init', '--bare', other);
  await git(repo.path, 'remote', 'set-url', '--add', '--push', 'origin', repo.remotePath);
  await git(repo.path, 'remote', 'set-url', '--add', '--push', 'origin', other);
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], pushOnly: true, push: true };
  await assert.rejects(planChange(request), { code: 'MULTIPLE_PUSH_URLS' });
  assert.equal(await git(repo.path, 'ls-remote', repo.remotePath, 'refs/heads/main'), `${repo.ids[0]}\trefs/heads/main`);
  assert.equal(await git(repo.path, 'ls-remote', other, 'refs/heads/main'), '');
});

test('restoring original metadata then editing again does not follow stale lineage cycles', async (t) => {
  const repo = await fixture(t);
  await git(repo.path, 'push', 'origin', 'main');
  const original = await getCommit({ path: repo.path, oid: repo.ids[1] });
  const request = { path: repo.path, branch: 'main', remote: 'origin', oid: repo.ids[1], message: 'Временная редакция', useCurrentDate: false, push: false };
  const first = await applyChange({ ...request, ...await planChange(request), allowPublishedRewrite: true });
  const restore = { ...request, oid: first.newOid, message: original.message };
  const restored = await applyChange({ ...restore, ...await planChange(restore), allowPublishedRewrite: true });
  assert.equal(restored.newOid, repo.ids[1]);
  assert.equal(restored.head, repo.ids[2]);
  const final = { ...request, message: 'Окончательная редакция', push: true };
  const plan = await planChange(final);
  assert.equal(plan.needsForce, true);
  const sent = await applyChange({ ...final, ...plan, allowPublishedRewrite: true });
  assert.equal(sent.pushed, true);
  assert.notEqual(sent.head, repo.ids[2]);
});
