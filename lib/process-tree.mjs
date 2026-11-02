import { ChildProcess, spawn } from 'node:child_process';

function isActive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function watchClose(child) {
  let closed = !isActive(child);
  let resolveClose;
  const completion = new Promise(resolve => { resolveClose = resolve; });
  const onClose = () => { closed = true; resolveClose(true); };
  child.once('close', onClose);
  if (closed) resolveClose(true);
  return {
    async wait(timeout) {
      if (closed) return true;
      let timer;
      const expired = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); });
      const result = await Promise.race([completion, expired]);
      clearTimeout(timer);
      return result;
    },
    dispose() { child.removeListener('close', onClose); },
  };
}

async function killOwnChild(child, watcher) {
  try { if (isActive(child)) child.kill(); } catch { /* Return uncertainty below. */ }
  if (await watcher.wait(1500)) return true;
  if (process.platform !== 'win32') {
    try { if (isActive(child)) child.kill('SIGKILL'); } catch { /* Return uncertainty below. */ }
  }
  return watcher.wait(1500);
}

function windowsTreeKill(pid) {
  return new Promise(resolve => {
    const taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, shell: false, stdio: 'ignore',
    });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // taskkill is our own helper, never a process discovered by PID search.
      try { taskkill.kill(); } catch { /* The outcome stays uncertain. */ }
      finish({ ok: false, error: 'Не удалось дождаться остановки дерева Git-процессов.' });
    }, 5000);
    taskkill.once('error', () => finish({ ok: false, error: 'Не удалось запустить taskkill для остановки дерева Git-процессов.' }));
    taskkill.once('close', code => finish(code === 0
      ? { ok: true }
      : { ok: false, error: 'taskkill не подтвердил остановку дерева Git-процессов.' }));
  });
}

/**
 * Stop only the active ChildProcess handle owned by the caller.
 * Windows Git transport helpers must be stopped with their parent, before the
 * caller releases its operation lock. Killing a timed-out push cannot prove
 * that the server did not already accept it; the caller must recheck the ref.
 */
export async function terminateProcessTree(child) {
  if (!(child instanceof ChildProcess)) throw new TypeError('Ожидается собственный ChildProcess, а не PID.');
  if (!Number.isInteger(child.pid) || child.pid <= 0 || !isActive(child)) {
    return { terminated: !isActive(child), treeTerminated: false, outcomeUnknown: true };
  }
  const watcher = watchClose(child);
  try {
    if (process.platform === 'win32') {
      // The handle is checked before spawning taskkill; no process enumeration
      // or user-supplied PID can reach this operation.
      if (!isActive(child)) return { terminated: true, treeTerminated: false, outcomeUnknown: true };
      const tree = await windowsTreeKill(child.pid);
      const terminated = tree.ok ? await watcher.wait(3000) : await killOwnChild(child, watcher);
      return {
        terminated,
        treeTerminated: tree.ok && terminated,
        outcomeUnknown: !tree.ok || !terminated,
        ...(!tree.ok ? { error: tree.error } : !terminated ? { error: 'Git-процесс не подтвердил завершение после остановки дерева.' } : {}),
      };
    }
    const terminated = await killOwnChild(child, watcher);
    return {
      terminated, treeTerminated: false, outcomeUnknown: true,
      ...(!terminated ? { error: 'Не удалось подтвердить завершение Git-процесса.' } : {}),
    };
  } finally {
    watcher.dispose();
  }
}
