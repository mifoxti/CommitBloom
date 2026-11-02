import { spawn } from 'node:child_process';
import { realpath, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { terminateProcessTree } from './process-tree.mjs';

export class GitError extends Error {
  constructor(message, code = 'GIT_ERROR', status = 400) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.status = status;
  }
}

const clean = (value) => String(value)
  .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[скрыто]@')
  .replace(/([?&](?:token|access_token|private_token|password)=)[^&\s]*/gi, '$1[скрыто]');

async function git(cwd, args, options = {}) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C.UTF-8' }, options.env);
  const child = spawn('git', ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', ...args], {
    cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let output = [], errors = [], length = 0, truncated = false, settled = false;
    const limit = options.maxOutput ?? 8 * 1024 * 1024;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      // Do not release the operation until the owned transport tree has been stopped.
      const termination = await terminateProcessTree(child);
      const suffix = termination.outcomeUnknown ? ' Не удалось подтвердить остановку всех процессов Git.' : '';
      reject(new GitError(`Git не ответил вовремя.${suffix} Обновите данные перед повтором.`, 'GIT_TIMEOUT', 408));
    }, options.timeout ?? 30000);
    child.stdout.on('data', (chunk) => {
      const remaining = limit - length;
      if (remaining > 0) output.push(chunk.subarray(0, remaining));
      length += chunk.length;
      if (length > limit) truncated = true;
    });
    child.stderr.on('data', (chunk) => { if (errors.reduce((n, part) => n + part.length, 0) < 1024 * 1024) errors.push(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitError(error.code === 'ENOENT' ? 'Git не найден. Добавьте установленный Git в PATH.' : clean(error.message)));
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(output).toString('utf8');
      const stderr = clean(Buffer.concat(errors).toString('utf8')).trim();
      if (truncated && !options.truncate) return reject(new GitError('Ответ Git слишком большой. Выберите более короткую историю.', 'OUTPUT_LIMIT'));
      if (code !== 0 && !options.allowFailure) return reject(new GitError(stderr || `Git завершился с кодом ${code}.`));
      resolve({ stdout: stdout + (truncated && options.truncate ? '\n… вывод сокращён …\n' : ''), stderr, code });
    });
    child.stdin.end(options.input ?? undefined, 'utf8');
  });
}

function requireOid(value) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value ?? '')) throw new GitError('Нужен полный хэш коммита.', 'INVALID_COMMIT');
  return value.toLowerCase();
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function context(path) {
  if (typeof path !== 'string' || !path.trim()) throw new GitError('Выберите папку Git-репозитория.', 'INVALID_PATH');
  let folder;
  try { folder = await realpath(path); } catch { throw new GitError('Указанная папка не найдена.', 'INVALID_PATH'); }
  const root = (await git(folder, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })).stdout.trim() || null;
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).stdout.trim() || null;
  const inProgress = [];
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
    const candidate = (await git(root, ['rev-parse', '--git-path', name])).stdout.trim();
    const absolute = (await import('node:path')).resolve(root, candidate);
    if (await exists(absolute)) inProgress.push(name);
  }
  return { path: root, currentBranch: branch, head, inProgress };
}

async function validateBranch(ctx, branch = ctx.currentBranch) {
  if (!branch || branch !== ctx.currentBranch) throw new GitError('Изменять можно только текущую локальную ветку. Переключите её в Git и обновите список.', 'WRONG_BRANCH', 409);
  if ((await git(ctx.path, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true })).code !== 0) throw new GitError('Некорректное имя ветки.', 'INVALID_BRANCH');
  return branch;
}

async function validateRemote(ctx, remote, required = true) {
  const names = (await git(ctx.path, ['remote'])).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!remote && !required) return names.includes('origin') ? 'origin' : names[0] ?? null;
  if (!names.includes(remote) || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote)) throw new GitError('Выберите настроенный удалённый репозиторий.', 'INVALID_REMOTE');
  return remote;
}

async function cachedRemoteHead(ctx, remote, branch) {
  if (!remote || !branch) return null;
  return (await git(ctx.path, ['rev-parse', '--verify', `refs/remotes/${remote}/${branch}`], { allowFailure: true })).stdout.trim() || null;
}

async function pushDestination(ctx, remote) {
  const urls = (await git(ctx.path, ['remote', 'get-url', '--push', '--all', '--', remote])).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (urls.length !== 1) throw new GitError('У выбранного remote настроено несколько адресов отправки. Для поочерёдной отправки используйте remote с одним push URL.', 'MULTIPLE_PUSH_URLS');
  return urls[0];
}

async function liveRemoteHead(ctx, remote, branch) {
  const destination = await pushDestination(ctx, remote);
  const response = await git(ctx.path, ['ls-remote', '--heads', '--', destination, `refs/heads/${branch}`], { timeout: 15000 });
  const line = response.stdout.trim().split(/\r?\n/).find((line) => line.split(/\s+/)[1] === `refs/heads/${branch}`);
  return line ? requireOid(line.split(/\s+/)[0]) : null;
}

async function ensureRemoteObject(ctx, remote, branch, oid) {
  if (!oid) return;
  const present = await git(ctx.path, ['cat-file', '-e', `${oid}^{commit}`], { allowFailure: true });
  if (present.code === 0) return;
  const destination = await pushDestination(ctx, remote);
  await git(ctx.path, ['fetch', '--no-tags', '--', destination, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { timeout: 15000 });
  if ((await git(ctx.path, ['cat-file', '-e', `${oid}^{commit}`], { allowFailure: true })).code !== 0) throw new GitError('Удалённая ветка изменилась. Обновите список и повторите операцию.', 'REMOTE_CHANGED', 409);
}

async function ancestor(ctx, older, newer) {
  if (!older || !newer) return false;
  const result = await git(ctx.path, ['merge-base', '--is-ancestor', older, newer], { allowFailure: true });
  if (result.code > 1) throw new GitError(result.stderr || 'Не удалось сравнить историю коммитов.');
  return result.code === 0;
}

/** Metadata rewrites survive restarts, but only a chain reachable from this branch is usable. */
async function rewriteLineage(ctx, originalOid) {
  if (!originalOid) return { oid: null, remapped: false };
  let oid = originalOid;
  const seen = new Set();
  for (let step = 0; step < 2000; step++) {
    if (seen.has(oid)) throw new GitError('Обнаружен цикл в сохранённой истории изменений Commit Bloom.', 'INVALID_LINEAGE', 409);
    seen.add(oid);
    const result = await git(ctx.path, ['rev-parse', '--verify', `refs/commit-bloom/rewrites/${oid}^{commit}`], { allowFailure: true });
    if (result.code !== 0) return { oid, remapped: oid !== originalOid };
    oid = requireOid(result.stdout.trim());
  }
  throw new GitError('Сохранённая цепочка изменений слишком длинная.', 'INVALID_LINEAGE', 409);
}

function parseIdentity(line) {
  const match = /^(.*) <([^>]*)> (\d+ [+-]\d{4})$/.exec(line ?? '');
  if (!match) throw new GitError('Не удалось прочитать автора коммита.', 'COMMIT_FORMAT');
  return { name: match[1], email: match[2], date: match[3] };
}

async function rawCommit(ctx, oid) {
  const raw = (await git(ctx.path, ['cat-file', 'commit', requireOid(oid)])).stdout;
  const boundary = raw.indexOf('\n\n');
  if (boundary < 0) throw new GitError('Некорректный объект коммита.', 'COMMIT_FORMAT');
  const headers = raw.slice(0, boundary);
  const lines = headers.split('\n');
  const get = (name) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
  return {
    oid,
    tree: requireOid(get('tree')),
    parents: lines.filter((line) => line.startsWith('parent ')).map((line) => requireOid(line.slice(7))),
    author: parseIdentity(get('author')),
    committer: parseIdentity(get('committer')),
    message: raw.slice(boundary + 2),
    signed: /^(?:gpgsig|gpgsig-sha256|mergetag) /m.test(headers),
    encoding: get('encoding') ?? 'UTF-8',
    extraHeaders: lines.filter((line) => line && !line.startsWith(' ') && !/^(?:tree|parent|author|committer|encoding|gpgsig|gpgsig-sha256|mergetag) /.test(line)),
  };
}

function displayCommit(commit) {
  const toIso = (date) => new Date(Number(date.split(' ')[0]) * 1000).toISOString();
  return {
    oid: commit.oid, shortOid: commit.oid.slice(0, 8), parents: commit.parents,
    subject: commit.message.split('\n')[0], message: commit.message.replace(/\n$/, ''),
    authorName: commit.author.name, authorEmail: commit.author.email,
    authorDate: toIso(commit.author.date), committerDate: toIso(commit.committer.date), signed: commit.signed,
  };
}

function normalizedMessage(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 1024 * 1024) throw new GitError('Введите непустое сообщение коммита без нулевых символов.', 'INVALID_MESSAGE');
  const message = value.replace(/\r\n/g, '\n');
  return message.endsWith('\n') ? message : `${message}\n`;
}

function normalizedDate(request) {
  if (request.pushOnly || request.customDate === undefined || request.customDate === null) return null;
  const value = request.customDate;
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const invalid = () => new GitError('Укажите корректные дату и время с часовым поясом, не ранее 1970 года.', 'INVALID_DATE');
  if (!match || request.useCurrentDate) throw invalid();
  const [, year, month, day, hour, minute, second, zone, , zoneHour = '0', zoneMinute = '0'] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (Number(year) < 1970 || calendar.getUTCFullYear() !== Number(year)
    || calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day)
    || calendar.getUTCHours() !== Number(hour) || calendar.getUTCMinutes() !== Number(minute)
    || calendar.getUTCSeconds() !== Number(second) || Number(zoneHour) > 23 || Number(zoneMinute) > 59
    || !Number.isFinite(Date.parse(value)) || Date.parse(value) < 0) throw invalid();
  // Git stores whole seconds and a numeric UTC offset.
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${zone === 'Z' ? '+00:00' : zone}`;
}

function rawDate(value) {
  return `${Math.floor(Date.parse(value) / 1000)} ${value.slice(-6).replace(':', '')}`;
}

async function affectedCommits(ctx, oid) {
  if (!await ancestor(ctx, oid, ctx.head)) throw new GitError('Коммит не входит в текущую ветку.', 'COMMIT_NOT_IN_BRANCH');
  const rest = (await git(ctx.path, ['rev-list', '--reverse', '--topo-order', '--ancestry-path', `${oid}..${ctx.head}`])).stdout.trim().split('\n').filter(Boolean);
  if (rest.length > 1000) throw new GitError('За коммитом больше 1000 потомков. Выберите более новый коммит.', 'HISTORY_LIMIT');
  return [oid, ...rest];
}

export async function inspectRepository(request) {
  const ctx = await context(request.path);
  const branches = (await git(ctx.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).stdout.trim().split('\n').filter(Boolean);
  const remoteNames = (await git(ctx.path, ['remote'])).stdout.trim().split('\n').filter(Boolean);
  const remotes = await Promise.all(remoteNames.map(async (name) => ({ name, url: clean((await git(ctx.path, ['remote', 'get-url', '--', name])).stdout.trim()) })));
  const remote = remoteNames.includes(request.remote) ? request.remote : remoteNames.includes('origin') ? 'origin' : remoteNames[0] ?? null;
  const remoteHead = await cachedRemoteHead(ctx, remote, ctx.currentBranch);
  const limit = Math.min(200, Math.max(1, Number(request.limit) || 80));
  const ids = ctx.head ? (await git(ctx.path, ['rev-list', '--first-parent', `--max-count=${limit}`, ctx.head])).stdout.trim().split('\n').filter(Boolean) : [];
  const remoteIds = remoteHead ? (await git(ctx.path, ['rev-list', '--first-parent', `--max-count=${limit}`, remoteHead, ...(ctx.head ? [`^${ctx.head}`] : [])])).stdout.trim().split('\n').filter(Boolean) : [];
  let ahead = ctx.head ? Number((await git(ctx.path, ['rev-list', '--count', ctx.head])).stdout.trim()) : 0;
  let behind = 0;
  if (remoteHead) {
    if (ctx.head) [ahead, behind] = (await git(ctx.path, ['rev-list', '--left-right', '--count', `${ctx.head}...${remoteHead}`])).stdout.trim().split(/\s+/).map(Number);
    else behind = Number((await git(ctx.path, ['rev-list', '--count', remoteHead])).stdout.trim());
  }
  const commits = [];
  for (const oid of [...ids, ...remoteIds]) {
    const entry = displayCommit(await rawCommit(ctx, oid));
    entry.isHead = oid === ctx.head;
    entry.isRemoteHead = oid === remoteHead;
    entry.isLocal = !remoteIds.includes(oid);
    entry.published = remoteHead ? await ancestor(ctx, oid, remoteHead) : false;
    commits.push(entry);
  }
  const dirty = Boolean((await git(ctx.path, ['status', '--porcelain=v1', '--untracked-files=normal'])).stdout);
  return { ...ctx, branches, remotes, remote, remoteBranch: ctx.currentBranch, remoteHead, ahead, behind, dirty, commits, historyLimited: ids.length === limit || remoteIds.length === limit };
}

export async function getCommit(request) {
  const ctx = await context(request.path);
  const commit = await rawCommit(ctx, requireOid(request.oid));
  const remote = await validateRemote(ctx, request.remote, false);
  const remoteHead = await cachedRemoteHead(ctx, remote, ctx.currentBranch);
  if (!await ancestor(ctx, commit.oid, ctx.head) && !await ancestor(ctx, commit.oid, remoteHead)) throw new GitError('Коммит не входит в текущую или выбранную удалённую ветку.', 'COMMIT_NOT_IN_BRANCH');
  const args = commit.parents.length ? ['diff', commit.parents[0], commit.oid] : ['diff-tree', '--root', '--no-commit-id', '-r', commit.oid];
  const fileArgs = commit.parents.length ? ['diff', '--no-renames', '--name-status', '-z', commit.parents[0], commit.oid, '--'] : ['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', '--name-status', '-z', commit.oid, '--'];
  const names = (await git(ctx.path, fileArgs)).stdout.split('\0');
  const files = [];
  for (let i = 0; i + 1 < names.length; i += 2) if (names[i]) files.push({ status: names[i], path: names[i + 1] });
  const patch = (await git(ctx.path, [...args.slice(0, 1), '--no-ext-diff', '--no-textconv', '-p', ...args.slice(1), '--'], { maxOutput: 256000, truncate: true })).stdout;
  return { ...displayCommit(commit), files, patch };
}

export async function refreshRemote(request) {
  const ctx = await context(request.path);
  const remote = await validateRemote(ctx, request.remote);
  const branch = await validateBranch(ctx);
  const destination = await pushDestination(ctx, remote);
  const remoteHead = await liveRemoteHead(ctx, remote, branch);
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  if (remoteHead) {
    await git(ctx.path, ['fetch', '--no-tags', '--', destination, `+refs/heads/${branch}:${trackingRef}`], { timeout: 15000 });
  } else {
    await git(ctx.path, ['update-ref', '-d', trackingRef]);
  }
  return { ...await inspectRepository({ ...request, path: ctx.path, remote }), remoteCheckedAt: new Date().toISOString(), remoteBranchExists: Boolean(remoteHead) };
}

export async function planChange(request) {
  const customDate = normalizedDate(request);
  const ctx = await context(request.path);
  const branch = await validateBranch(ctx, request.branch);
  if (ctx.inProgress.length) throw new GitError('В репозитории идёт rebase, merge или другая Git-операция. Сначала завершите её.', 'OPERATION_IN_PROGRESS', 409);
  if (!ctx.head) throw new GitError('В этой ветке пока нет коммитов.', 'EMPTY_REPOSITORY');
  const oid = requireOid(request.oid);
  const selected = await rawCommit(ctx, oid);
  const message = request.pushOnly ? selected.message : normalizedMessage(request.message ?? selected.message);
  const dateChanged = customDate !== null && (rawDate(customDate) !== selected.author.date || rawDate(customDate) !== selected.committer.date);
  const changed = !request.pushOnly && (message !== selected.message || Boolean(request.useCurrentDate) || dateChanged);
  const affectedOids = changed ? await affectedCommits(ctx, oid) : (await ancestor(ctx, oid, ctx.head) ? [] : await affectedCommits(ctx, oid));
  if (changed) {
    for (const id of affectedOids) {
      const commit = id === oid ? selected : await rawCommit(ctx, id);
      if (commit.signed) throw new GitError('В изменяемой цепочке есть подписанные коммиты. Утилита не удаляет подписи: используйте Git с повторной подписью.', 'SIGNED_HISTORY');
      if (!/^utf-?8$/i.test(commit.encoding) || commit.extraHeaders.length) throw new GitError('Цепочка содержит нестандартные заголовки или кодировку. Используйте Git, чтобы сохранить эти данные.', 'UNSUPPORTED_COMMIT');
    }
  }
  const remote = await validateRemote(ctx, request.remote, Boolean(request.push));
  const remoteHead = request.push ? await liveRemoteHead(ctx, remote, branch) : await cachedRemoteHead(ctx, remote, branch);
  if (remoteHead && request.push) await ensureRemoteObject(ctx, remote, branch, remoteHead);
  const alreadyOnServer = !changed && remoteHead && await ancestor(ctx, oid, remoteHead);
  const actualRemoteInBranch = remoteHead && await ancestor(ctx, remoteHead, ctx.head);
  const lineage = alreadyOnServer || actualRemoteInBranch ? { oid: remoteHead, remapped: false } : await rewriteLineage(ctx, remoteHead);
  const usableLineage = lineage.remapped && await ancestor(ctx, lineage.oid, ctx.head);
  const effectiveRemoteHead = usableLineage ? lineage.oid : remoteHead;
  const selectedPublished = effectiveRemoteHead ? await ancestor(ctx, oid, effectiveRemoteHead) : false;
  let publishedAffectedCount = 0;
  for (const id of affectedOids) if (effectiveRemoteHead && await ancestor(ctx, id, effectiveRemoteHead)) publishedAffectedCount++;
  let pushTargetOid = oid;
  let needsForce = Boolean(request.push && changed && selectedPublished);
  if (request.push && remoteHead) {
    if (usableLineage) {
      // Never drop descendants already on the server when the selected commit is older.
      if (await ancestor(ctx, oid, effectiveRemoteHead)) pushTargetOid = effectiveRemoteHead;
      else if (!await ancestor(ctx, effectiveRemoteHead, oid)) throw new GitError('Выбранный коммит не продолжает сохранённую опубликованную цепочку. Выберите коммит после неё.', 'DIVERGED_HISTORY', 409);
      needsForce = true;
    } else if (changed && selectedPublished) {
      if (!await ancestor(ctx, remoteHead, ctx.head)) throw new GitError('На сервере есть коммиты, которых нет в локальной ветке. Сначала синхронизируйте ветку.', 'REMOTE_AHEAD', 409);
      pushTargetOid = remoteHead;
    } else if (!selectedPublished && !await ancestor(ctx, remoteHead, oid)) {
      throw new GitError('Истории локальной и удалённой веток разошлись. Сначала синхронизируйте ветку.', 'DIVERGED_HISTORY', 409);
    }
  }
  const warnings = [];
  if (publishedAffectedCount) warnings.push(`Изменятся хэши опубликованных коммитов: ${publishedAffectedCount}.`);
  if (usableLineage && request.push) warnings.push('На сервер будет отправлена ранее сохранённая цепочка изменений Commit Bloom. Потребуется защищённая перезапись истории.');
  if (changed && affectedOids.length > 1) warnings.push(`Хэши следующих коммитов тоже изменятся: ${affectedOids.length - 1}. Содержимое файлов сохранится.`);
  return {
    path: ctx.path, branch, remote, oid, message: message.replace(/\n$/, ''), useCurrentDate: !request.pushOnly && Boolean(request.useCurrentDate), push: Boolean(request.push), pushOnly: Boolean(request.pushOnly),
    customDate,
    changed, affectedOids, affectedCount: affectedOids.length, selectedPublished, publishedAffectedCount,
    needsForce, requiresForce: needsForce, remoteHead, expectedHead: ctx.head, expectedRemoteHead: remoteHead,
    pushTargetOid, rewrittenRemoteHead: usableLineage ? effectiveRemoteHead : null,
    pushUrl: request.push ? clean(await pushDestination(ctx, remote)) : null, warnings,
  };
}

async function performPush(ctx, { branch, remote, oid, expectedRemoteHead, force = false }) {
  const live = await liveRemoteHead(ctx, remote, branch);
  if (live !== expectedRemoteHead) throw new GitError('Удалённая ветка изменилась. Обновите данные перед отправкой.', 'REMOTE_CHANGED', 409);
  await ensureRemoteObject(ctx, remote, branch, live);
  if (live === oid || (!force && live && await ancestor(ctx, oid, live))) return { pushed: false, alreadyPublished: true };
  if (!force && live && !await ancestor(ctx, live, oid)) throw new GitError('Отправка потребует перезаписи удалённой истории. Обновите данные и проверьте план.', 'NON_FAST_FORWARD', 409);
  const args = ['push', '--porcelain'];
  if (force) args.push(`--force-with-lease=refs/heads/${branch}:${live ?? ''}`);
  args.push('--', remote, `${oid}:refs/heads/${branch}`);
  const result = await git(ctx.path, args, { timeout: 15000 });
  return { pushed: true, alreadyPublished: false, output: clean(result.stdout.trim()) };
}

export async function pushCommit(request) {
  const push = { ...request, push: true, pushOnly: true };
  const plan = await planChange(push);
  return applyChange({
    ...push,
    expectedHead: request.expectedHead ?? plan.expectedHead,
    expectedRemoteHead: Object.hasOwn(request, 'expectedRemoteHead') ? request.expectedRemoteHead : plan.expectedRemoteHead,
  });
}

export async function applyChange(request) {
  if (!request.expectedHead) throw new GitError('Сначала просмотрите план изменения.', 'PLAN_REQUIRED', 409);
  const plan = await planChange(request);
  if (plan.expectedHead !== request.expectedHead) throw new GitError('Локальная ветка изменилась. Обновите данные и повторите операцию.', 'HEAD_CHANGED', 409);
  if (plan.push && plan.expectedRemoteHead !== request.expectedRemoteHead) throw new GitError('Удалённая ветка изменилась. Обновите данные и повторите операцию.', 'REMOTE_CHANGED', 409);
  if ((plan.publishedAffectedCount || plan.needsForce) && !request.allowPublishedRewrite) throw new GitError('Подтвердите изменение уже опубликованной истории.', 'PUBLISHED_CONFIRMATION', 409);
  const ctx = await context(plan.path);
  const mapping = new Map();
  let backupRef = null;
  let newOid = plan.oid;
  let head = ctx.head;
  if (plan.changed) {
    const date = plan.customDate ?? (plan.useCurrentDate ? new Date().toISOString() : null);
    for (const id of plan.affectedOids) {
      const commit = await rawCommit(ctx, id);
      const authorDate = id === plan.oid && date !== null ? date : commit.author.date;
      const committerDate = id === plan.oid && date !== null ? date : commit.committer.date;
      const args = ['-c', 'commit.gpgsign=false', '-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', commit.tree];
      for (const parent of commit.parents) args.push('-p', mapping.get(parent) ?? parent);
      args.push('-F', '-');
      const newId = (await git(ctx.path, args, {
        input: id === plan.oid ? normalizedMessage(plan.message) : commit.message,
        env: {
          GIT_AUTHOR_NAME: commit.author.name, GIT_AUTHOR_EMAIL: commit.author.email, GIT_AUTHOR_DATE: authorDate,
          GIT_COMMITTER_NAME: commit.committer.name, GIT_COMMITTER_EMAIL: commit.committer.email, GIT_COMMITTER_DATE: committerDate,
        },
      })).stdout.trim();
      mapping.set(id, requireOid(newId));
    }
    newOid = mapping.get(plan.oid);
    head = mapping.get(plan.expectedHead);
    const latest = await context(plan.path);
    if (latest.head !== plan.expectedHead || latest.currentBranch !== plan.branch || latest.inProgress.length) throw new GitError('Состояние репозитория изменилось. Обновите данные.', 'HEAD_CHANGED', 409);
    backupRef = `refs/commit-bloom/backups/${Date.now()}-${randomUUID().slice(0, 8)}`;
    const lineageUpdates = [];
    for (const [oldId, newId] of mapping) {
      if (oldId === newId) continue;
      const ref = `refs/commit-bloom/rewrites/${oldId}`;
      const previous = (await git(ctx.path, ['rev-parse', '--verify', ref], { allowFailure: true })).stdout.trim();
      if (previous !== newId) lineageUpdates.push(previous ? `update ${ref} ${newId} ${previous}` : `create ${ref} ${newId}`);
    }
    await git(ctx.path, ['update-ref', '-m', 'Commit Bloom: edit commit metadata', '--stdin'], {
      input: `start\ncreate ${backupRef} ${plan.expectedHead}\nupdate refs/heads/${plan.branch} ${head} ${plan.expectedHead}\n${lineageUpdates.length ? `${lineageUpdates.join('\n')}\n` : ''}prepare\ncommit\n`,
    });
  }
  const result = { oldOid: plan.oid, newOid, head, backupRef, pushed: false, remap: Object.fromEntries(mapping) };
  if (plan.push) {
    try {
      const pushOid = mapping.get(plan.pushTargetOid) ?? plan.pushTargetOid;
      Object.assign(result, await performPush({ ...ctx, head }, { branch: plan.branch, remote: plan.remote, oid: pushOid, expectedRemoteHead: plan.expectedRemoteHead, force: plan.needsForce && Boolean(request.allowPublishedRewrite) }));
      result.pushedOid = pushOid;
    } catch (error) {
      result.pushError = clean(error.message);
      result.pushErrorCode = error.code ?? 'PUSH_FAILED';
      if (error.code === 'GIT_TIMEOUT') result.pushOutcomeUnknown = true;
    }
  }
  return result;
}
