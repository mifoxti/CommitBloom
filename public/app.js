'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const el = {
    path: byId('repository-path'), form: byId('repository-form'),
    browse: byId('browse-folder'), open: byId('open-repository'),
    context: byId('repository-context'), branch: byId('current-branch'),
    sync: byId('sync-overview'), ahead: byId('ahead-count'), behind: byId('behind-count'),
    localTip: byId('local-tip'), remoteTip: byId('remote-tip'), target: byId('push-target'),
    freshness: byId('sync-freshness'), reload: byId('reload-repository'),
    location: byId('selected-location'), footnote: byId('history-footnote'),
    remote: byId('remote-select'), fetch: byId('fetch-remote'),
    repoStatus: byId('repository-status'), notice: byId('global-notice'),
    list: byId('commit-list'), count: byId('commit-count'),
    pending: byId('pending-count'), search: byId('commit-search'),
    editor: byId('commit-editor'), empty: byId('editor-empty'),
    subject: byId('commit-subject'), body: byId('commit-body'),
    subjectLength: byId('subject-length'), dateMode: byId('date-mode'),
    customDate: byId('custom-date'), customDateFields: byId('custom-date-fields'), timezone: byId('date-timezone'),
    originalDate: byId('original-date'), newDate: byId('new-date'),
    hash: byId('selected-hash'), status: byId('selected-status'), copy: byId('copy-hash'),
    files: byId('file-list'), fileCount: byId('file-count'), diff: byId('commit-diff'),
    changes: byId('changes-details'), save: byId('save-commit'),
    savePush: byId('save-and-push'), push: byId('push-commit'),
    dialog: byId('review-dialog'), reviewTitle: byId('review-title'),
    reviewDescription: byId('review-description'), summary: byId('review-summary'),
    published: byId('published-warning'), allowPublished: byId('allow-published'),
    reviewError: byId('review-error'), confirm: byId('confirm-review'),
    cancel: byId('cancel-review'), cancelTop: byId('cancel-review-top'),
    activity: byId('activity-list'), activityCount: byId('activity-count'),
    lastActivity: byId('last-activity'), activityPanel: byId('activity-panel'),
    connection: byId('connection-label'), toast: byId('toast'),
  };
  const state = {
    token: '', repository: null, selected: null, busy: false, loadingDetails: false,
    filter: 'all', query: '', preview: null, reviewMode: null,
    detailsRequest: 0, activityCount: 0, toastTimer: null,
    originalSubject: '', originalBody: '', originalDateMode: 'current', originalCustomDate: '',
  };

  // The only boundary between the interface and the local Git service.
  const api = {
    session: () => request('/api/session', null),
    repository: (path, remote) => request('/api/repository', { path, remote }),
    commit: (path, oid, remote) => request('/api/commit', { path, oid, remote }),
    refresh: (path, remote) => request('/api/refresh', { path, remote }),
    pickFolder: (initialPath) => request('/api/pick-folder', { initialPath }),
    preview: (payload) => request('/api/preview', payload),
    apply: (planId, allowPublishedRewrite) => request('/api/apply', { planId, allowPublishedRewrite }),
  };

  async function request(url, payload) {
    const options = { cache: 'no-store', credentials: 'same-origin' };
    if (payload !== null) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json', 'X-CommitBloom-Token': state.token };
      options.body = JSON.stringify(payload);
    }
    let response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new Error('Локальный сервер недоступен. Проверьте, что окно Commit Bloom запущено.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Ошибка запроса (${response.status})`);
      error.code = data.code;
      error.details = data.details;
      throw error;
    }
    return data;
  }

  function icon(name, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    svg.append(use);
    return svg;
  }

  function make(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = String(text);
    return item;
  }

  function formatDate(value, compact = false) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ru-RU', compact
      ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    ).format(date);
  }

  function localDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = (number) => String(number).padStart(2, '0');
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function customDateValue() {
    const value = el.customDate.value;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
    const date = new Date(value);
    // Reject invalid calendar dates and local times skipped by daylight saving changes.
    if (localDate(date) !== (value.length === 16 ? `${value}:00` : value) || date.getTime() < 0) return null;
    const offset = -date.getTimezoneOffset();
    const pad = (number) => String(number).padStart(2, '0');
    const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${localDate(date)}${zone}`;
  }

  function plural(count, forms = ['коммит', 'коммита', 'коммитов']) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    return `${count} ${forms[mod10 === 1 && mod100 !== 11 ? 0 : mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14) ? 1 : 2]}`;
  }

  function setNotice(message, type = '') {
    el.notice.hidden = !message;
    el.notice.className = `notice${type ? ` ${type}` : ''}`;
    el.notice.textContent = message || '';
  }

  function activity(message, type = '') {
    const item = make('li', type);
    const time = make('time', '', new Date().toLocaleTimeString('ru-RU'));
    time.dateTime = new Date().toISOString();
    item.append(time, make('span', '', message));
    el.activity.prepend(item);
    while (el.activity.children.length > 60) el.activity.lastChild.remove();
    state.activityCount += 1;
    el.activityCount.textContent = state.activityCount;
    el.lastActivity.textContent = message;
  }

  function toast(message) {
    clearTimeout(state.toastTimer);
    el.toast.querySelector('span').textContent = message;
    el.toast.hidden = false;
    state.toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4200);
  }

  function setBusy(busy, button) {
    state.busy = busy;
    document.body.classList.toggle('busy', busy);
    document.querySelectorAll('.is-loading').forEach((item) => item.classList.remove('is-loading'));
    if (busy && button) button.classList.add('is-loading');
    updateControls();
  }

  function updateControls() {
    const repo = state.repository;
    const selected = state.selected;
    const blocked = !repo || !selected || selected.isLocal === false || !repo.currentBranch || Boolean(repo.inProgress?.length);
    el.path.disabled = state.busy;
    el.browse.disabled = state.busy;
    el.open.disabled = state.busy;
    el.reload.disabled = state.busy || !repo;
    el.remote.disabled = state.busy || !repo?.remotes?.length;
    el.fetch.disabled = state.busy || !repo?.remote || !repo?.currentBranch;
    el.subject.disabled = state.busy || blocked;
    el.body.disabled = state.busy || blocked;
    el.dateMode.disabled = state.busy || blocked;
    el.customDate.disabled = state.busy || blocked || el.dateMode.value !== 'custom';
    el.save.disabled = state.busy || blocked;
    el.savePush.disabled = state.busy || blocked || !repo?.remote;
    el.push.disabled = state.busy || blocked || !repo?.remote;
    el.copy.disabled = state.busy || !selected;
    el.search.disabled = state.busy || !repo;
    document.querySelectorAll('.commit-item, .list-tab').forEach((item) => { item.disabled = state.busy; });
    el.confirm.disabled = state.busy || (Boolean(state.preview?.requirePublishedAck) && !el.allowPublished.checked);
    el.cancel.disabled = state.busy;
    el.cancelTop.disabled = state.busy;
    el.dialog.setAttribute('aria-busy', String(state.busy));
  }

  async function withBusy(button, action) {
    if (state.busy) return;
    setBusy(true, button);
    try {
      await action();
    } catch (error) {
      setNotice(error.message, 'error');
      activity(error.message, 'error');
      if (el.dialog.open) {
        el.reviewError.hidden = false;
        el.reviewError.textContent = error.message;
      }
    } finally {
      setBusy(false);
    }
  }

  function messageFromEditor() {
    if (state.selected && el.subject.value === state.originalSubject && el.body.value === state.originalBody) {
      return state.selected.message || `${state.selected.subject || ''}\n`;
    }
    const subject = el.subject.value.trim();
    const body = el.body.value.trimEnd();
    return `${subject}${body ? `\n\n${body}` : ''}\n`;
  }

  function hasDraftChanges() {
    return state.selected && (messageFromEditor().trimEnd() !== (state.selected.message || '').trimEnd()
      || el.dateMode.value !== state.originalDateMode
      || (el.dateMode.value === 'custom' && el.customDate.value !== state.originalCustomDate));
  }

  function mayDiscardDraft() {
    return !hasDraftChanges() || window.confirm('Сообщение или дата коммита изменены, но не сохранены. Продолжить без сохранения?');
  }

  function preferredCommit(repository, preferredOid) {
    const commits = repository.commits || [];
    return commits.find((commit) => commit.oid === preferredOid)
      || [...commits].reverse().find((commit) => !commit.published)
      || commits.find((commit) => commit.isLocal !== false)
      || commits[0]
      || null;
  }

  async function renderRepository(repository, preferredOid) {
    state.repository = repository;
    state.detailsRequest += 1;
    el.path.value = repository.path || el.path.value;
    try { localStorage.setItem('commitbloom.repository', el.path.value); } catch { /* Optional local preference. */ }
    el.context.hidden = false;
    el.branch.textContent = repository.currentBranch || 'HEAD без ветки';
    el.branch.title = 'Переключите ветку в Git-клиенте, затем нажмите «Перечитать локальную ветку».';
    el.sync.hidden = false;
    el.remote.replaceChildren();
    const remotes = repository.remotes || [];
    if (!remotes.length) el.remote.append(new Option('Нет сервера', ''));
    for (const remote of remotes) {
      const option = new Option(remote.name, remote.name);
      option.title = remote.url || remote.name;
      option.selected = remote.name === repository.remote;
      el.remote.append(option);
    }
    renderSync(repository);
    if (repository.inProgress?.length) {
      setNotice('В репозитории выполняется Git-операция. Завершите её и откройте папку заново.');
    } else if (!repository.currentBranch) {
      setNotice('Сейчас открыта отдельная версия (detached HEAD). Переключитесь на ветку для редактирования и отправки.');
    } else if (!remotes.length) {
      setNotice('Удалённый репозиторий не настроен. Сообщения и даты можно сохранять локально.');
    } else if (repository.ahead && repository.behind) {
      setNotice('Истории разошлись: есть коммиты только локально и только на сервере. Обновите данные и синхронизируйте ветку в Git-клиенте.');
    } else if (repository.behind) {
      setNotice('На сервере есть коммиты, которых нет локально. Их можно просмотреть; для редактирования сначала получите их в Git-клиенте.');
    } else if (repository.dirty) {
      setNotice('В рабочей папке есть изменения. Файлы и индекс сохранятся: утилита редактирует только сообщения и даты коммитов.');
    } else {
      setNotice('');
    }
    const commit = preferredCommit(repository, preferredOid);
    state.selected = null;
    renderList();
    if (commit) await selectCommit(commit, true);
    else {
      el.editor.hidden = true;
      el.empty.hidden = false;
    }
    updateControls();
  }

  function remoteKnown(repo) {
    return Boolean(repo?.remoteHead) || repo?.remoteBranchExists === false;
  }

  function renderSync(repo) {
    const known = remoteKnown(repo);
    el.ahead.textContent = !repo.remote || known ? repo.ahead : '—';
    el.behind.textContent = repo.remote && known ? repo.behind : '—';
    el.localTip.textContent = `HEAD · ${repo.head?.slice(0, 8) || 'нет коммитов'}`;
    el.remoteTip.textContent = repo.remoteHead ? `Сервер · ${repo.remoteHead.slice(0, 8)}`
      : !repo.remote ? 'Сервер не настроен' : repo.remoteBranchExists === false ? 'Ветка ещё не создана' : 'Нажмите «Обновить с сервера»';
    el.target.textContent = repo.remote && repo.currentBranch ? `${repo.remote}/${repo.remoteBranch}` : 'Отправка недоступна';
    el.freshness.textContent = !repo.remote ? 'Добавьте remote в вашем Git-клиенте.'
      : repo.remoteCheckedAt ? `Проверено: ${formatDate(repo.remoteCheckedAt)}. Данные могут измениться.`
      : 'Локальные данные Git. Обновите с сервера для актуального сравнения.';
    el.repoStatus.textContent = !repo.currentBranch ? 'HEAD без ветки' : !repo.remote ? 'Без сервера' : !known ? 'Сервер не проверен'
      : repo.ahead && repo.behind ? 'Истории разошлись' : repo.behind ? 'Есть новые коммиты на сервере'
      : repo.ahead ? 'Есть локальные коммиты' : 'Ветки совпадают';
    el.repoStatus.classList.toggle('synced', known && !repo.ahead && !repo.behind);
    el.footnote.textContent = repo.historyLimited ? 'Показана часть истории. Счётчики сверху учитывают все коммиты.' : 'Розовый — локально · зелёный — на сервере';
  }

  function commitStatus(commit) {
    if (commit.isLocal === false) return 'Только на сервере';
    if (commit.published) return 'На сервере и локально';
    return !state.repository.remote || remoteKnown(state.repository) ? 'Только локально' : 'Локально · сервер не проверен';
  }

  function renderList() {
    const commits = state.repository?.commits || [];
    const pending = commits.filter((commit) => !commit.published);
    el.count.textContent = state.repository ? commits.length : '—';
    el.pending.textContent = pending.length;
    if (!state.repository) return;
    const query = state.query.trim().toLocaleLowerCase('ru-RU');
    const filtered = commits.filter((commit) => (
      (state.filter !== 'pending' || !commit.published)
      && (state.filter !== 'published' || commit.published)
      && (!query || `${commit.subject} ${commit.message} ${commit.oid} ${commit.authorName}`.toLocaleLowerCase('ru-RU').includes(query))
    ));
    const previousScroll = el.list.scrollTop;
    el.list.replaceChildren();
    if (!filtered.length) {
      const empty = make('div', 'empty-list');
      empty.append(make('h3', '', query ? 'Ничего не найдено' : state.filter === 'pending' ? 'Нет локальных коммитов к отправке' : state.filter === 'published' ? 'Нет серверных коммитов в списке' : 'История пока пуста'));
      empty.append(make('p', '', query ? 'Попробуйте другой заголовок или хэш.' : state.filter === 'pending' ? 'В показанной истории нет неопубликованных коммитов.' : state.filter === 'published' ? 'Обновите сведения с сервера или проверьте выбранный remote.' : 'Создайте первый коммит в вашем Git-клиенте.'));
      el.list.append(empty);
    }
    for (const commit of filtered) {
      const wrapper = make('div', 'commit-list-entry');
      wrapper.setAttribute('role', 'listitem');
      const button = make('button', `commit-item${commit.published ? ' published' : ' pending'}${commit.isLocal === false ? ' remote-only' : ''}${state.selected?.oid === commit.oid ? ' active' : ''}`);
      button.type = 'button';
      button.title = commit.subject || '(без сообщения)';
      button.setAttribute('aria-pressed', String(state.selected?.oid === commit.oid));
      const timeline = make('span', 'commit-timeline');
      timeline.append(make('span', 'commit-dot'));
      const content = make('span', 'commit-content');
      content.append(make('span', 'commit-title', commit.subject || '(без сообщения)'));
      const meta = make('span', 'commit-item-meta');
      meta.append(make('span', 'commit-hash', commit.shortOid || commit.oid.slice(0, 7)));
      meta.append(make('span', commit.published ? 'published-label' : 'pending-label', commitStatus(commit)));
      const date = make('time', 'commit-date', formatDate(commit.authorDate, true));
      date.dateTime = commit.authorDate || '';
      meta.append(date);
      content.append(meta);
      const footer = make('span', 'commit-item-footer');
      footer.append(make('span', '', commit.authorName || 'Автор не указан'));
      if (commit.isHead) footer.append(make('span', 'head-label', `HEAD · ${state.repository.currentBranch || 'без ветки'}`));
      if (commit.isRemoteHead) footer.append(make('span', 'head-label remote-head-label', `${state.repository.remote}/${state.repository.remoteBranch}`));
      content.append(footer);
      button.append(timeline, content);
      button.disabled = state.busy;
      button.addEventListener('click', () => {
        if (state.busy || state.selected?.oid === commit.oid) return;
        selectCommit(commit).catch((error) => setNotice(error.message, 'error'));
      });
      wrapper.append(button);
      el.list.append(wrapper);
    }
    el.list.scrollTop = previousScroll;
  }

  async function selectCommit(commit, skipDraftCheck = false) {
    if (!skipDraftCheck && hasDraftChanges() && state.selected?.oid !== commit.oid && !mayDiscardDraft()) return;
    state.selected = commit;
    renderList();
    el.editor.hidden = false;
    el.empty.hidden = true;
    el.hash.textContent = commit.shortOid || commit.oid.slice(0, 7);
    el.copy.title = commit.oid;
    el.status.textContent = commitStatus(commit);
    el.status.className = `status-badge${commit.published ? ' published' : ''}`;
    byId('editor-title').textContent = commit.isLocal === false ? 'Просмотр серверного коммита' : 'Подготовка к отправке';
    el.location.textContent = commit.isLocal === false
      ? 'Этот коммит есть только на сервере. Доступен просмотр; получите его в Git-клиенте, чтобы редактировать.'
      : commit.published ? `Коммит входит в ${state.repository.remote}/${state.repository.remoteBranch} и в локальную ветку.`
      : !state.repository.remote ? 'Коммит хранится локально. Удалённый репозиторий не настроен.'
      : !remoteKnown(state.repository) ? 'Коммит есть локально. Обновите данные с сервера, чтобы проверить публикацию.'
      : `Коммит отсутствует в ${state.repository.remote}/${state.repository.remoteBranch} по последним данным Git.`;
    const message = (commit.message || commit.subject || '').replace(/\r\n/g, '\n');
    const firstBreak = message.indexOf('\n');
    el.subject.value = firstBreak < 0 ? message : message.slice(0, firstBreak);
    el.body.value = firstBreak < 0 ? '' : message.slice(firstBreak + 1).replace(/^\n/, '').trimEnd();
    state.originalSubject = el.subject.value;
    state.originalBody = el.body.value;
    el.subjectLength.textContent = `${el.subject.value.length} симв.`;
    el.originalDate.textContent = formatDate(commit.authorDate);
    el.originalDate.dateTime = commit.authorDate || '';
    el.originalDate.title = `Дата автора: ${formatDate(commit.authorDate)}\nДата коммиттера: ${formatDate(commit.committerDate)}`;
    el.customDate.value = localDate(commit.authorDate);
    state.originalDateMode = el.dateMode.value;
    state.originalCustomDate = el.customDate.value;
    updateDate();
    el.fileCount.textContent = '…';
    el.files.replaceChildren(make('p', 'files-placeholder', 'Загрузка изменений…'));
    el.diff.textContent = 'Загрузка изменений…';
    state.loadingDetails = true;
    const requestId = ++state.detailsRequest;
    updateControls();
    try {
      const details = await api.commit(state.repository.path, commit.oid, state.repository.remote);
      if (requestId !== state.detailsRequest || state.selected?.oid !== commit.oid) return;
      state.selected = { ...commit, ...details };
      renderFiles(details);
    } catch (error) {
      if (requestId !== state.detailsRequest) return;
      el.files.replaceChildren(make('p', 'files-placeholder', error.message));
      el.diff.textContent = error.message;
      el.fileCount.textContent = '—';
    } finally {
      if (requestId === state.detailsRequest) state.loadingDetails = false;
    }
  }

  function renderFiles(commit) {
    const files = commit.files || [];
    el.fileCount.textContent = files.length;
    el.files.replaceChildren();
    if (!files.length) el.files.append(make('p', 'files-placeholder', 'В этом коммите нет изменений файлов.'));
    for (const file of files) {
      const row = make('div', 'file-row');
      const letter = (file.status || 'M').charAt(0);
      const statusClass = letter === 'A' ? ' added' : letter === 'D' ? ' deleted' : '';
      row.append(make('span', `file-status${statusClass}`, letter), make('span', 'file-path', file.path));
      if (file.additions !== undefined || file.deletions !== undefined) {
        const stat = make('span', 'file-stat');
        stat.append(make('span', 'add', `+${file.additions ?? 0}`), make('span', 'remove', `−${file.deletions ?? 0}`));
        row.append(stat);
      }
      el.files.append(row);
    }
    el.diff.textContent = commit.patch || commit.diff || 'Изменений для показа нет.';
  }

  function updateDate() {
    const custom = el.dateMode.value === 'custom';
    el.customDateFields.hidden = !custom;
    el.customDate.setCustomValidity(custom && !customDateValue() ? 'Укажите корректные дату и время, не ранее 1970 года.' : '');
    const chosenDate = customDateValue();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    el.timezone.textContent = `Часовой пояс компьютера: ${timezone}${chosenDate ? ` (UTC${chosenDate.slice(-6)})` : ''}.`;
    if (!state.selected) return;
    const date = el.dateMode.value === 'current' ? new Date().toISOString() : custom ? chosenDate : state.selected.authorDate;
    if (custom && !date) {
      el.newDate.textContent = 'Укажите дату и время';
      el.newDate.dateTime = '';
      el.newDate.title = 'Введите корректные дату и время.';
      return;
    }
    el.newDate.textContent = formatDate(date);
    el.newDate.dateTime = date || '';
    el.newDate.title = el.dateMode.value === 'current' ? 'Дата автора и дата коммиттера обновятся в момент сохранения.'
      : custom ? `Дата автора и коммиттера: ${date}` : 'Исходные даты будут сохранены.';
  }

  function addSummary(label, value) {
    const row = make('div');
    row.append(make('dt', '', label), make('dd', '', value));
    el.summary.append(row);
  }

  function previewPayload(mode, push) {
    return {
      path: state.repository.path,
      branch: state.repository.currentBranch,
      remote: state.repository.remote,
      oid: state.selected.oid,
      message: mode === 'edit' ? messageFromEditor() : state.selected.message,
      useCurrentDate: mode === 'edit' && el.dateMode.value === 'current',
      ...(mode === 'edit' && el.dateMode.value === 'custom' ? { customDate: customDateValue() } : {}),
      push,
      mode,
    };
  }

  async function prepareReview(mode, push, button) {
    if (!state.selected || state.busy) return;
    if (mode === 'edit' && !el.subject.value.trim()) {
      setNotice('Добавьте заголовок коммита.', 'error');
      el.subject.focus();
      return;
    }
    if (mode === 'edit' && el.dateMode.value === 'custom') {
      updateDate();
      if (!el.customDate.reportValidity()) return;
    }
    await withBusy(button, async () => {
      setNotice('');
      const payload = previewPayload(mode, push);
      const response = await api.preview(payload);
      const plan = response.plan ? { ...response.plan, planId: response.planId } : response;
      const publishedCount = Number(plan.publishedAffectedCount || 0);
      const requirePublishedAck = Boolean(plan.needsForce || plan.requiresForce || (plan.changed && (plan.selectedPublished || publishedCount > 0)));
      state.preview = { ...plan, payload, requirePublishedAck };
      state.reviewMode = { mode, push };
      el.reviewTitle.textContent = push ? 'Всё готово к отправке?' : 'Сохранить изменения?';
      el.reviewDescription.textContent = mode === 'push'
        ? 'Отправится выбранный коммит и необходимая для него история. Сообщение и даты останутся прежними.'
        : push
          ? 'Сообщение и время обновятся перед отправкой. Следующие коммиты останутся в локальной ветке.'
          : 'Сообщение и время изменятся только в локальном репозитории.';
      if (push && (plan.needsForce || plan.requiresForce)) {
        el.reviewDescription.textContent = 'На сервере обновится опубликованная история до текущей удалённой вершины. Последующие локальные коммиты останутся в вашей папке.';
      }
      el.summary.replaceChildren();
      addSummary('Ветка', plan.branch || state.repository.currentBranch);
      if (push) addSummary('Сервер', plan.remote || state.repository.remote);
      if (push && plan.pushUrl) addSummary('Адрес отправки', plan.pushUrl);
      addSummary('Коммит', state.selected.shortOid || state.selected.oid.slice(0, 7));
      if (mode === 'edit') {
        addSummary('Сообщение', el.subject.value.trim());
        addSummary('Дата и время', payload.useCurrentDate ? 'Текущие, в момент сохранения'
          : payload.customDate ? `${formatDate(payload.customDate)} (UTC${payload.customDate.slice(-6)})` : 'Сохранить исходные');
      }
      if (plan.changed && plan.affectedCount !== undefined) addSummary('Обновится', plural(plan.affectedCount));
      const pushCount = plan.pendingPushCount ?? plan.pushCount;
      if (push && Number.isFinite(pushCount)) addSummary('К отправке', plural(pushCount));
      if (Array.isArray(plan.warnings) && plan.warnings.length) addSummary('Обратите внимание', plan.warnings.join('\n'));
      el.published.hidden = !requirePublishedAck;
      const publishedDescription = el.published.querySelector('p');
      publishedDescription.replaceChildren(make('strong', '', 'В истории есть опубликованные коммиты.'),
        document.createTextNode(push ? 'Отправка заменит их в выбранной удалённой ветке.' : 'Изменения создадут локальную историю, которая будет отличаться от опубликованной.'));
      el.allowPublished.checked = false;
      el.reviewError.hidden = true;
      el.confirm.replaceChildren(document.createTextNode(mode === 'push' ? 'Отправить' : push ? 'Сохранить и отправить' : 'Сохранить'), icon(push ? 'upload' : 'check'));
      if (!el.dialog.open) el.dialog.showModal();
      updateControls();
    });
  }

  async function applyReview() {
    const preview = state.preview;
    if (!preview || state.busy) return;
    if (preview.requirePublishedAck && !el.allowPublished.checked) return;
    await withBusy(el.confirm, async () => {
      el.reviewError.hidden = true;
      const response = await api.apply(preview.planId, el.allowPublished.checked);
      const result = response.result || response;
      const repository = response.state || response.repository;
      el.dialog.close();
      state.preview = null;
      let refreshError = '';
      try {
        if (repository) await renderRepository(repository, result.pushed ? undefined : result.newOid || state.selected?.oid);
        else await renderRepository(await api.repository(preview.payload.path, preview.payload.remote), result.pushed ? undefined : result.newOid);
      } catch (error) {
        refreshError = error.message || response.stateError || 'Не удалось прочитать новое состояние репозитория.';
        state.repository = null;
        state.selected = null;
        state.detailsRequest += 1;
        state.loadingDetails = false;
        el.context.hidden = true;
        el.sync.hidden = true;
        el.editor.hidden = true;
        el.empty.hidden = false;
        el.count.textContent = '—';
        el.pending.textContent = '0';
        const empty = make('div', 'empty-list');
        empty.append(make('h3', '', 'Список не обновился'), make('p', '', 'Нажмите «Открыть», чтобы прочитать новое состояние репозитория.'));
        el.list.replaceChildren(empty);
      }
      const refreshNotice = refreshError ? ' Список не обновился; нажмите «Открыть».' : '';
      if (result.pushError) {
        const detail = typeof result.pushError === 'string' ? result.pushError : result.pushError.message || 'Не удалось связаться с сервером.';
        const message = result.pushOutcomeUnknown
          ? `Изменения сохранены локально. Результат отправки не подтверждён: ${detail} Обновите сведения с сервера перед повторной отправкой.`
          : `Изменения сохранены локально, но отправка не удалась: ${detail}`;
        setNotice(message + refreshNotice, 'error');
        activity(message, 'error');
        el.activityPanel.open = true;
      } else {
        const message = result.pushed ? refreshError ? 'Коммит отправлен на сервер.' : 'Коммит отправлен. Можно переходить к следующему.' : result.alreadyPublished ? 'Коммит уже опубликован на сервере.' : preview.changed === false ? 'Изменений в коммите нет.' : 'Сообщение и дата сохранены локально.';
        setNotice(message + refreshNotice, refreshError ? '' : 'success');
        activity(message, 'success');
        toast(result.pushed || result.alreadyPublished ? 'Коммит на сервере' : 'Коммит сохранён');
      }
      if (refreshError) {
        activity(`Список не обновился; нажмите «Открыть». ${refreshError}`, 'error');
        el.activityPanel.open = true;
      }
      if (result.backupRef) activity(`Резервная копия истории: ${result.backupRef}`);
      updateControls();
    });
  }

  async function openRepository(path, remote, preferredOid) {
    await withBusy(el.open, async () => {
      if (!path.trim()) throw new Error('Укажите папку Git-репозитория.');
      setNotice('');
      const repository = await api.repository(path.trim(), remote);
      await renderRepository(repository, preferredOid);
      activity(`Открыт репозиторий ${repository.path}`);
    });
  }

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!mayDiscardDraft()) return;
    openRepository(el.path.value);
  });
  el.browse.addEventListener('click', () => withBusy(el.browse, async () => {
    const result = await api.pickFolder(el.path.value.trim() || undefined);
    if (result.cancelled || !result.path) return;
    if (!mayDiscardDraft()) return;
    el.path.value = result.path;
    const repository = await api.repository(result.path);
    await renderRepository(repository);
    activity(`Открыт репозиторий ${repository.path}`);
  }));
  el.remote.addEventListener('change', () => {
    if (!mayDiscardDraft()) { el.remote.value = state.repository.remote || ''; return; }
    openRepository(state.repository.path, el.remote.value, state.selected?.oid);
  });
  el.reload.addEventListener('click', () => {
    if (!mayDiscardDraft()) return;
    openRepository(state.repository.path, state.repository.remote, state.selected?.oid);
  });
  el.fetch.addEventListener('click', () => {
    if (!mayDiscardDraft()) return;
    withBusy(el.fetch, async () => {
      const repository = await api.refresh(state.repository.path, state.repository.remote);
      await renderRepository(repository, state.selected?.oid);
      activity('Сведения с удалённого репозитория обновлены.', 'success');
      toast('Состояние сервера обновлено');
    });
  });
  el.search.addEventListener('input', () => { state.query = el.search.value; renderList(); });
  window.addEventListener('focus', () => {
    if (!state.repository || state.busy || el.dialog.open || hasDraftChanges()) return;
    openRepository(state.repository.path, state.repository.remote, state.selected?.oid);
  });
  document.querySelectorAll('.list-tab').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.list-tab').forEach((item) => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    renderList();
  }));
  document.querySelectorAll('.diff-tab').forEach((button) => button.addEventListener('click', () => {
    const showDiff = button.dataset.view === 'diff';
    el.files.hidden = showDiff;
    el.diff.hidden = !showDiff;
    document.querySelectorAll('.diff-tab').forEach((item) => item.classList.toggle('active', item === button));
  }));
  el.subject.addEventListener('input', () => { el.subjectLength.textContent = `${el.subject.value.length} симв.`; });
  el.dateMode.addEventListener('change', () => { updateDate(); updateControls(); });
  el.customDate.addEventListener('input', updateDate);
  el.copy.addEventListener('click', async () => {
    if (!state.selected) return;
    try { await navigator.clipboard.writeText(state.selected.oid); toast('Хэш скопирован'); }
    catch { setNotice(`Хэш коммита: ${state.selected.oid}`); }
  });
  el.save.addEventListener('click', () => prepareReview('edit', false, el.save));
  el.savePush.addEventListener('click', () => prepareReview('edit', true, el.savePush));
  el.push.addEventListener('click', () => prepareReview('push', true, el.push));
  el.allowPublished.addEventListener('change', updateControls);
  el.confirm.addEventListener('click', applyReview);
  const cancelReview = () => { if (!state.busy) { el.dialog.close(); state.preview = null; } };
  el.cancel.addEventListener('click', cancelReview);
  el.cancelTop.addEventListener('click', cancelReview);
  el.dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); else state.preview = null; });
  el.dialog.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
  window.addEventListener('beforeunload', (event) => {
    if (state.busy || hasDraftChanges()) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !el.dialog.open && !el.savePush.disabled) {
      event.preventDefault();
      prepareReview('edit', true, el.savePush);
    }
  });
  setInterval(updateDate, 1000);

  async function init() {
    updateControls();
    try {
      const session = await api.session();
      state.token = session.token;
      el.connection.classList.add('connected');
      el.connection.replaceChildren(make('span', 'connection-dot'), document.createTextNode(`Сервер доступен · ${session.version || '1.0'}`));
      let rememberedPath = '';
      try { rememberedPath = localStorage.getItem('commitbloom.repository') || ''; } catch { /* Storage can be disabled. */ }
      el.path.value = session.defaultPath || rememberedPath;
      activity('Commit Bloom готов к работе.');
      if (el.path.value) await openRepository(el.path.value);
    } catch (error) {
      el.connection.replaceChildren(make('span', 'connection-dot'), document.createTextNode('Сервер недоступен'));
      setNotice(error.message, 'error');
      activity(error.message, 'error');
    }
  }

  init();
})();
