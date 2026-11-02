import { createServer as createHttpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as git from './lib/git.mjs';
import { chooseFolder } from './lib/folder-picker.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function cleanError(message) {
  return String(message || 'Операция не выполнена.')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1***@')
    .slice(0, 12_000);
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
    throw fail(415, 'Ожидается JSON-запрос.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw fail(413, 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw fail(400, 'Некорректный JSON-запрос.');
  }
}

function repositoryPath(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) {
    throw fail(400, 'Укажите полный путь к папке репозитория.');
  }
  return value.trim();
}

function tokenMatches(candidate, token) {
  if (typeof candidate !== 'string') return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** No dependencies; exported separately so the HTTP boundary can be tested. */
export function createApp({ defaultPath = '', engine = git, picker = chooseFolder } = {}) {
  const token = randomBytes(32).toString('hex');
  const plans = new Map();
  let applying = false;
  let picking = false;

  const server = createHttpServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };

    try {
      const port = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      const origins = new Set([...hosts].map(host => `http://${host}`));
      if (!hosts.has(request.headers.host)) throw fail(403, 'Недопустимый адрес запроса.');
      if (request.headers.origin && !origins.has(request.headers.origin)) {
        throw fail(403, 'Запрос с другого сайта отклонён.');
      }
      const url = new URL(request.url, `http://127.0.0.1:${port}`);

      if (request.method === 'GET') {
        if (url.pathname === '/api/session') {
          return send(200, { token, defaultPath, version: '1.0.0' });
        }
        if (url.pathname === '/favicon.ico') {
          response.writeHead(204);
          return response.end();
        }
        const file = staticFiles.get(url.pathname);
        if (!file) return send(404, { error: 'Страница не найдена.' });
        const data = await readFile(join(directory, 'public', file[0]));
        response.writeHead(200, { 'Content-Type': file[1] });
        return response.end(data);
      }

      if (request.method !== 'POST') throw fail(405, 'Метод не поддерживается.');
      if (!origins.has(request.headers.origin) || !tokenMatches(request.headers['x-commitbloom-token'], token)) {
        throw fail(403, 'Откройте приложение заново: сессия недействительна.');
      }
      const input = await readJson(request);

      if (url.pathname === '/api/pick-folder') {
        if (picking) throw fail(409, 'Выбор папки уже открыт.');
        picking = true;
        try { return send(200, await picker(typeof input.initialPath === 'string' ? input.initialPath : defaultPath)); }
        finally { picking = false; }
      }

      if (url.pathname === '/api/repository') {
        return send(200, await engine.inspectRepository({ path: repositoryPath(input.path), remote: input.remote }));
      }
      if (url.pathname === '/api/commit') {
        return send(200, await engine.getCommit({ path: repositoryPath(input.path), oid: input.oid, ...(input.remote ? { remote: input.remote } : {}) }));
      }
      if (url.pathname === '/api/refresh') {
        const path = repositoryPath(input.path);
        return send(200, await engine.refreshRemote({ path, remote: input.remote }));
      }
      if (url.pathname === '/api/preview') {
        const data = {
          path: repositoryPath(input.path), branch: input.branch, remote: input.remote,
          oid: input.oid, message: input.message, useCurrentDate: input.useCurrentDate === true,
          push: input.push === true,
        };
        if (input.customDate !== undefined) data.customDate = input.customDate;
        if (input.mode === 'push') {
          data.message = (await engine.getCommit({ path: data.path, oid: data.oid })).message;
          data.useCurrentDate = false;
          delete data.customDate;
          data.push = true;
          data.pushOnly = true;
        }
        const plan = await engine.planChange(data);
        for (const [key, value] of plans) {
          if (Date.now() - value.created > 10 * 60_000) plans.delete(key);
        }
        if (plans.size >= 50) plans.delete(plans.keys().next().value);
        const planId = randomBytes(20).toString('hex');
        plans.set(planId, { data, plan, created: Date.now() });
        return send(200, { ...plan, planId });
      }
      if (url.pathname === '/api/apply') {
        if (applying) throw fail(409, 'Дождитесь завершения текущей операции.');
        const reviewed = plans.get(input.planId);
        if (!reviewed || Date.now() - reviewed.created > 10 * 60_000) {
          throw fail(409, 'Предпросмотр устарел. Проверьте изменения ещё раз.');
        }
        plans.delete(input.planId);
        applying = true;
        try {
          const result = await engine.applyChange({
            ...reviewed.data,
            expectedHead: reviewed.plan.expectedHead,
            expectedRemoteHead: reviewed.plan.expectedRemoteHead,
            allowPublishedRewrite: input.allowPublishedRewrite === true,
          });
          let state;
          let stateError;
          try { state = await engine.inspectRepository({ path: reviewed.data.path, remote: reviewed.data.remote }); }
          catch (error) { stateError = cleanError(error.message); }
          return send(200, { result, state, stateError });
        } finally { applying = false; }
      }
      throw fail(404, 'Операция не найдена.');
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status : 400;
      send(status, { error: cleanError(error.message), code: error.code });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, token };
}

function openBrowser(url) {
  let child;
  if (process.platform === 'win32') {
    child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  } else if (process.platform === 'darwin') {
    child = spawn('open', [url], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  }
  child.on('error', () => console.log(`Откройте в браузере: ${url}`));
  child.unref();
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const selectedPath = option('--repo', '');
  let defaultPath = selectedPath ? resolve(selectedPath) : '';
  if (!defaultPath) {
    const adjacent = resolve(directory, '../New');
    if (await stat(join(adjacent, '.git')).catch(() => null)) defaultPath = adjacent;
  }
  const port = Number(option('--port', process.env.COMMIT_BLOOM_PORT || '4313'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Неверный номер порта.');
  const { server } = createApp({ defaultPath });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n  Commit Bloom\n  ${url}\n\n  Ctrl+C — остановить утилиту.\n`);
  if (args.includes('--open')) openBrowser(url);
  const close = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.code === 'EADDRINUSE'
      ? 'Порт занят. Откройте http://127.0.0.1:4313 или запустите с --port 4314.'
      : cleanError(error.message));
    process.exitCode = 1;
  });
}
