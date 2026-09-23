// Replayarr UI. Page structure follows Sonarr: Promotions stand in for
// series, events for episodes, and a request is a monitored event.

const $ = (selector, root = document) => root.querySelector(selector);
const content = $('#content');
const toolbar = $('#toolbar');
const modalRoot = $('#modal-root');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const today = () => new Date().toISOString().slice(0, 10);

let promotionsCache = [];
let indexersCache = [];
let providersCache = [];

// Sonarr-style indexer types: what each needs and how it is described.
const INDEXER_TYPES = {
  prowlarr: { label: 'Prowlarr', protocol: 'Torrent / Usenet', about: 'Searches every indexer in one Prowlarr instance. Add a second entry for a separate Usenet Prowlarr.' },
  bitmagnet: { label: 'Bitmagnet', protocol: 'Torrent', about: 'Your local DHT index. Fast, returns info hashes directly; results go to qBittorrent.' },
  easynews: { label: 'Easynews', protocol: 'Direct download', about: 'Searches Easynews and downloads matches directly over HTTPS with the built-in downloader.' },
};
const PROTOCOL_LABELS = { torrent: ['torrent', 'label-success'], usenet: ['nzb', 'label-info'], easynews: ['easynews', 'label-purple'] };
const CLIENT_LABELS = { qbittorrent: 'qBittorrent', sabnzbd: 'SABnzbd', easynews: 'Easynews' };
let pollTimer = null;
let renderToken = 0;

// --- API ----------------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  // The server only accepts JSON on writes (its CSRF guard), so every
  // POST/PUT carries a JSON body even when there is nothing to send.
  const writes = method === 'POST' || method === 'PUT';
  const response = await fetch('/api' + path, {
    method,
    headers: writes ? { 'content-type': 'application/json' } : {},
    body: writes ? JSON.stringify(body ?? {}) : undefined,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function message(text, type = 'info') {
  const el = document.createElement('div');
  el.className = `message ${type}`;
  el.textContent = text;
  $('#messages').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
}

async function run(action, success) {
  try {
    const result = await action();
    if (success) message(typeof success === 'function' ? success(result) : success, 'success');
    return result;
  } catch (error) {
    message(error.message, 'error');
    return undefined;
  }
}

// --- formatting ---------------------------------------------------------
function formatDate(iso, { weekday = false } = {}) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', ...(weekday ? { weekday: 'short' } : {}), timeZone: 'UTC' })
    .format(new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso));
}
function formatDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
function relative(iso) {
  if (!iso) return '';
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return rtf.format(Math.round(minutes / 60), 'hour');
  return rtf.format(Math.round(minutes / 1440), 'day');
}
function formatSize(bytes) {
  const value = Number(bytes);
  if (!value) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}
function age(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days < 1) return `${Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / 3600000))} hours`;
  return `${days} day${days === 1 ? '' : 's'}`;
}

// Sonarr's episode status, derived from the event, its request and library item.
function eventStatus(event) {
  const request = event.request;
  if (event.library) return { key: 'downloaded', label: 'Downloaded', css: 'success' };
  if (request?.status === 'downloading') return { key: 'downloading', label: request.job ? `Downloading ${Math.round((request.job.progress || 0) * 100)}%` : 'Downloading', css: 'purple' };
  if (request?.status === 'importing') return { key: 'downloading', label: 'Importing', css: 'purple' };
  if (request?.status === 'review') return { key: 'review', label: 'Needs Review', css: 'warning' };
  if (request?.status === 'failed') return { key: 'missing', label: 'Failed', css: 'danger' };
  if (request?.status === 'searching') return { key: 'missing', label: 'Searching', css: 'info' };
  if (event.date > today()) return { key: 'unaired', label: 'Unaired', css: 'primary' };
  if (request) return { key: 'missing', label: 'Missing', css: 'danger' };
  return { key: 'unmonitored', label: 'Unmonitored', css: 'default' };
}
const statusLabel = (status) => `<span class="label label-${status.css}">${esc(status.label)}</span>`;

function promotionOf(event) {
  return promotionsCache.find((p) => p.id === event?.promotionId) || null;
}

// --- layout -------------------------------------------------------------
const NAV = [
  { key: 'promotions', label: 'Promotions', icon: 'promotions', href: '#/promotions', children: [['Add New', '#/add'], ['Library', '#/library']] },
  { key: 'calendar', label: 'Calendar', icon: 'calendar', href: '#/calendar' },
  { key: 'activity', label: 'Activity', icon: 'activity', href: '#/activity/queue', count: 'queue', children: [['Queue', '#/activity/queue'], ['History', '#/activity/history']] },
  { key: 'wanted', label: 'Wanted', icon: 'wanted', href: '#/wanted/missing', count: 'review', children: [['Missing', '#/wanted/missing'], ['Needs Review', '#/wanted/review']] },
  { key: 'metadata', label: 'Metadata', icon: 'metadata', href: '#/metadata/promotions', children: [
    ['Promotions', '#/metadata/promotions'], ['Providers', '#/metadata/providers'], ['Matching Rules', '#/metadata/rules'], ['Settings', '#/metadata/settings']] },
  { key: 'settings', label: 'Settings', icon: 'settings', href: '#/settings/mediamanagement', children: [
    ['Media Management', '#/settings/mediamanagement'], ['Indexers', '#/settings/indexers'], ['Download Clients', '#/settings/downloadclients'],
    ['General', '#/settings/general']] },
  { key: 'system', label: 'System', icon: 'system', href: '#/system/status', children: [['Status', '#/system/status'], ['Tasks', '#/system/tasks'], ['Events', '#/system/events']] },
];
const sectionOf = { promotions: 'promotions', promotion: 'promotions', add: 'promotions', library: 'promotions', calendar: 'calendar', activity: 'activity', wanted: 'wanted', metadata: 'metadata', settings: 'settings', system: 'system' };
let navCounts = { queue: 0, review: 0 };

function renderSidebar(route) {
  const section = sectionOf[route[0]] || 'promotions';
  const current = '#/' + route.join('/');
  $('#sidebar').innerHTML = NAV.map((item) => {
    const count = item.count && navCounts[item.count] ? `<span class="count ${item.count === 'review' ? 'warning' : ''}">${navCounts[item.count]}</span>` : '';
    const children = item.children ? `<div class="nav-children">${item.children.map(([label, href]) =>
      `<a href="${href}" class="${current.startsWith(href) ? 'active' : ''}">${label}</a>`).join('')}</div>` : '';
    return `<div class="nav-item ${item.key === section ? 'active' : ''}"><a href="${item.href}">${icon(item.icon)}<span>${item.label}</span>${count}</a>${children}</div>`;
  }).join('');
}

function toolbarButton(action, iconName, label, { disabled = false, id = '' } = {}) {
  return `<button type="button" class="toolbar-button" data-action="${action}" ${id ? `id="${id}"` : ''} ${disabled ? 'disabled' : ''}>${icon(iconName)}<span class="label-text">${label}</span></button>`;
}
function setToolbar(left = '', right = '') {
  toolbar.innerHTML = `<div class="toolbar-group">${left}</div><div class="toolbar-group">${right}</div>`;
}

async function refreshChrome() {
  try {
    const [queue, requests, health] = await Promise.all([api('/queue'), api('/requests'), api('/health')]);
    navCounts = { queue: queue.length, review: requests.filter((r) => r.status === 'review').length };
    const badge = $('#health-badge');
    const errors = health.filter((h) => h.type === 'error').length;
    badge.hidden = !health.length;
    badge.textContent = health.length;
    badge.classList.toggle('warning', !errors);
  } catch { /* the page itself reports connection problems */ }
}

// --- shared pieces ------------------------------------------------------
// A chosen logo wins; otherwise the promotion's shipped artwork, else its name.
const logoOf = (promotion) => promotion.logo || promotion.defaultLogo || '';
function posterStyle(promotion) {
  const logo = logoOf(promotion);
  return logo ? `style="background-image:url('${esc(logo)}')"` : '';
}
function posterFallback(promotion) {
  return logoOf(promotion) ? '' : `<span class="poster-fallback">${esc(promotion.name)}</span>`;
}

function eventRows(events, { showPromotion = false } = {}) {
  return events.map((event) => {
    const status = eventStatus(event);
    const requested = !!event.request;
    const promotion = promotionOf(event);
    return `<tr data-event="${esc(event.id)}">
      <td class="narrow"><button class="icon-button monitor-toggle ${requested ? 'on' : ''}" data-action="toggle-monitor" title="${requested ? 'Requested: click to stop monitoring' : 'Not requested: click to monitor'}" aria-label="Toggle request" ${event.library ? 'disabled' : ''}>${icon(requested || event.library ? 'bookmark-fill' : 'bookmark')}</button></td>
      ${showPromotion ? `<td class="nowrap"><a href="#/promotion/${esc(promotion?.id || '')}">${esc(promotion?.name || 'Unknown')}</a></td>` : ''}
      <td class="title-cell">${esc(event.title)}${event.library ? `<div class="evidence">${esc(event.library.path)}</div>` : ''}${event.request?.error && status.key !== 'downloaded' ? `<div class="evidence">${esc(event.request.error)}</div>` : ''}</td>
      <td class="nowrap hide-sm">${formatDate(event.date)}${event.time ? ` <span class="muted">${esc(event.time)} UTC</span>` : ''}</td>
      <td class="narrow">${statusLabel(status)}</td>
      <td class="actions">
        <button class="icon-button" data-action="auto-search" title="Automatic search" aria-label="Automatic search" ${event.library || ['downloading', 'importing'].includes(event.request?.status) ? 'disabled' : ''}>${icon('search')}</button>
        <button class="icon-button" data-action="interactive-search" title="Interactive search" aria-label="Interactive search" ${event.library ? 'disabled' : ''}>${icon('user')}</button>
      </td>
    </tr>`;
  }).join('');
}

function promotionGrid(list) {
  return `<div class="poster-grid">${list.sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const pct = p.stats.requested ? Math.round((p.stats.downloaded / p.stats.requested) * 100) : 0;
    return `<a class="poster-card" href="#/promotion/${esc(p.id)}">
      <div class="poster logo" ${posterStyle(p)}>${posterFallback(p)}${p.stats.requested ? '<span class="poster-flag" title="Has requested events"></span>' : ''}</div>
      <div class="progress-bar ${pct < 100 && p.stats.requested ? 'partial' : ''}" title="${p.stats.downloaded} of ${p.stats.requested} requested events downloaded"><span style="width:${p.stats.requested ? Math.max(pct, 2) : 0}%"></span></div>
      <div class="poster-info"><div class="poster-title">${esc(p.name)}</div>
      <div class="poster-meta">${p.refreshState === 'queued' ? 'Queued for refresh' : p.refreshing ? 'Refreshing…' : p.refreshError ? 'Refresh failed' : p.stats.nextDate ? `Next: ${formatDate(p.stats.nextDate)}` : `${p.stats.events} event${p.stats.events === 1 ? '' : 's'}`}</div>
      <div class="poster-meta">${p.stats.downloaded} / ${p.stats.requested} downloaded</div></div>
    </a>`;
  }).join('')}</div>`;
}

// While a metadata refresh runs, pages that show promotions re-render every
// few seconds so counts and status fill in.
async function refreshBanner() {
  const status = await api('/metadata/status').catch(() => null);
  if (!status?.running) return '';
  schedulePoll(3000);
  const current = promotionsCache.find((p) => p.id === status.current)?.name || status.current;
  return `<div class="alert">${icon('refresh')}<div>Refreshing metadata: <strong>${esc(current || '…')}</strong>${status.queued.length ? ` · ${status.queued.length} more queued` : ''}. TheSportsDB promotions can take a few minutes.</div></div>`;
}

// Requesting is idempotent server-side, and returns the full request view.
function ensureRequest(eventId) {
  return api('/requests', { method: 'POST', body: { eventId } });
}

// --- pages --------------------------------------------------------------
const pages = {
  async promotions() {
    setToolbar(
      toolbarButton('sync-events', 'refresh', 'Refresh Metadata') + toolbarButton('search-missing', 'search', 'Search Missing'),
      toolbarButton('go-add', 'plus', 'Add Promotion'),
    );
    const promotions = await api('/promotions');
    promotionsCache = promotions;
    const withEvents = promotions.filter((p) => p.followed || p.stats.events > 0);
    const banner = await refreshBanner();
    if (!withEvents.length) {
      return `${banner}<div class="empty-state"><h2>No promotions yet</h2><p><a href="#/add">Add a promotion</a> to start fetching its schedule, as you would add a series in Sonarr.</p></div>`;
    }
    return banner + promotionGrid(withEvents);
  },


  async promotion([id]) {
    setToolbar(
      toolbarButton('refresh-promotion', 'refresh', 'Refresh') + toolbarButton('search-promotion', 'search', 'Search Monitored') + toolbarButton('logo-picker', 'image', 'Logo'),
      toolbarButton('expand-all', 'list', 'Expand All') + toolbarButton('collapse-all', 'grid', 'Collapse All'),
    );
    promotionsCache = await api('/promotions');
    const promotion = promotionsCache.find((p) => p.id === id);
    if (!promotion) return `<div class="empty-state"><h2>Promotion not found</h2></div>`;
    const events = await api(`/events?promotion=${encodeURIComponent(id)}&limit=1000`);
    const byYear = new Map();
    for (const event of events) {
      const year = event.date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(event);
    }
    const { stats } = promotion;
    const seasons = [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, list], index) => {
      const requested = list.filter((e) => e.request || e.library).length;
      const downloaded = list.filter((e) => e.library).length;
      return `<section class="season ${index > 0 ? 'collapsed' : ''}">
        <div class="season-header" data-action="toggle-season"><h2>Season ${year}</h2>
          <span class="label ${requested && downloaded === requested ? 'label-success' : requested ? 'label-danger' : 'label-default'}">${downloaded} / ${requested}</span>
          <span class="muted">${list.length} event${list.length === 1 ? '' : 's'}</span><span class="toggle">▾</span></div>
        <div class="season-body"><table class="table"><thead><tr><th></th><th>Title</th><th class="hide-sm">Date</th><th>Status</th><th></th></tr></thead>
        <tbody>${eventRows(list.sort((a, b) => b.date.localeCompare(a.date)))}</tbody></table></div>
      </section>`;
    }).join('');
    return `<div class="details-header">
        <div class="poster logo" data-action="logo-picker" data-id="${esc(promotion.id)}" title="Change logo" style="cursor:pointer;${logoOf(promotion) ? `background-image:url('${esc(logoOf(promotion))}')` : ''}">${posterFallback(promotion)}</div>
        <div class="details-info"><h1 class="details-title">${esc(promotion.name)}</h1>
          <div class="details-sub">${promotion.custom ? 'Custom promotion' : 'Built-in promotion'} · ${esc(promotion.providerName)}${promotion.overlay ? ' · learned aliases applied' : ''}</div>
          ${promotion.refreshError ? `<div class="alert alert-warning">${icon('warning')}<div>Last refresh failed: ${esc(promotion.refreshError)} <a href="#/metadata/promotions">Metadata</a></div></div>` : ''}
          <div class="labels"><span class="label label-outline">${stats.events} events</span><span class="label label-outline">${stats.requested} requested</span>
            <span class="label ${stats.requested && stats.downloaded === stats.requested ? 'label-success' : 'label-outline'}">${stats.downloaded} downloaded</span>
            ${stats.nextDate ? `<span class="label label-primary">Next ${formatDate(stats.nextDate)}</span>` : ''}
            ${promotion.followed ? '<span class="label label-success">Followed</span>' : `<button class="button button-primary" data-action="follow-promotion" data-id="${esc(promotion.id)}">${icon('plus')} Follow</button>`}</div></div>
      </div>${seasons || '<div class="empty-state">No events for this promotion yet.</div>'}`;
  },

  async add() {
    setToolbar(toolbarButton('sync-events', 'refresh', 'Refresh Metadata'), toolbarButton('manual-event', 'plus', 'Add Event Manually'));
    promotionsCache = await api('/promotions');
    const available = promotionsCache.filter((p) => !p.followed).sort((a, b) => a.name.localeCompare(b.name));
    return `<h1 class="page-title">Add New Promotion</h1>
      <p class="muted">Following a promotion fetches its schedule and keeps it up to date. Change its provider, start date or logo under <a href="#/metadata/promotions">Metadata › Promotions</a>.</p>
      <div class="header-search" style="max-width:none;margin:0 0 20px"><input id="promo-filter" type="search" placeholder="Filter promotions" autocomplete="off"></div>
      ${available.length ? `<div class="poster-grid" id="add-promos">${available.map((p) => `<div class="poster-card add-promo" data-name="${esc(p.name.toLowerCase())}">
        <div class="poster logo" ${posterStyle(p)}>${posterFallback(p)}</div>
        <div class="poster-info"><div class="poster-title">${esc(p.name)}</div><div class="poster-meta">${esc(p.providerName)}</div></div>
        <button class="button button-primary" data-action="follow-promotion" data-id="${esc(p.id)}">${icon('plus')} Add</button></div>`).join('')}</div>`
        : '<div class="empty-state">You follow every promotion. Create more under <a href="#/metadata/rules">Metadata › Matching Rules</a>.</div>'}
      <h2 class="page-title" style="margin-top:30px">Find an Event</h2>
      <div class="header-search" style="max-width:none;margin:0 0 20px"><input id="add-search" type="search" placeholder="Search fetched events by team, promotion or name" autocomplete="off"></div>
      <div class="table-panel" id="add-results"><div class="empty-state">Start typing to find an event from your followed promotions.</div></div>`;
  },

  async metadata([tab = 'promotions']) {
    if (tab === 'settings') return pages.settings(['metadatakeys']);
    if (tab === 'rules') return pages.settings(['promotions']);
    if (tab === 'providers') {
      setToolbar(toolbarButton('add-provider', 'plus', 'Add Provider'));
      const providers = await api('/metadata/providers');
      providersCache = providers;
      return `<h1 class="page-title">Providers</h1>
        <p class="muted">Where schedules come from. Shipped providers cover the built-in promotions; add your own for another league, team or any public JSON schedule, then assign it under Promotions.</p>
        <div id="provider-preview"></div>
        <div class="table-panel"><table class="table"><thead><tr><th>Provider</th><th class="hide-sm">Adapter</th><th>Used By</th><th>Kind</th><th></th></tr></thead><tbody>
        ${providers.map((p) => `<tr><td><strong>${esc(p.name)}</strong><div class="evidence">${esc(p.id)}</div></td>
          <td class="hide-sm"><span class="label label-info">${esc(p.source.type)}</span><div class="evidence">${esc(p.description)}</div></td>
          <td>${esc(p.usedBy.join(', ') || '—')}</td>
          <td>${p.system ? '<span class="label label-default">Shipped</span>' : '<span class="label label-success">Custom</span>'}</td>
          <td class="actions"><button class="button" data-action="preview-provider" data-id="${esc(p.id)}">Test &amp; Preview</button>
            ${p.system ? '' : `<button class="icon-button danger" data-action="delete-provider" data-id="${esc(p.id)}" title="Delete" aria-label="Delete provider">${icon('trash')}</button>`}</td></tr>`).join('')}
        </tbody></table></div>`;
    }
    setToolbar(toolbarButton('sync-events', 'refresh', 'Refresh Followed'), toolbarButton('go-add', 'plus', 'Add Promotion'));
    const [list, providers] = await Promise.all([api('/promotions'), api('/metadata/providers')]);
    promotionsCache = list;
    providersCache = providers;
    const banner = await refreshBanner();
    const sorted = list.slice().sort((a, b) => (b.followed - a.followed) || a.name.localeCompare(b.name));
    return `<h1 class="page-title">Promotions</h1>${banner}
      <div class="table-panel"><table class="table"><thead><tr><th>Promotion</th><th>Follow</th><th>Provider</th><th class="hide-sm">Start Date</th><th class="hide-sm">Events</th><th>Last Refresh</th><th></th></tr></thead><tbody>
      ${sorted.map((p) => `<tr data-id="${esc(p.id)}">
        <td><div class="promo-cell"><button class="logo-thumb ${logoOf(p) ? '' : 'empty'}" data-action="logo-picker" data-id="${esc(p.id)}" title="Choose logo" aria-label="Choose logo for ${esc(p.name)}" ${logoOf(p) ? `style="background-image:url('${esc(logoOf(p))}')"` : ''}>${logoOf(p) ? '' : icon('image')}</button>
          <div><a href="#/promotion/${esc(p.id)}">${esc(p.name)}</a><div class="evidence">${esc(p.id)}${p.custom ? ' · custom' : ''}</div></div></div></td>
        <td><label class="switch" title="${p.followed ? 'Following' : 'Not followed'}"><input type="checkbox" data-change="follow" ${p.followed ? 'checked' : ''} aria-label="Follow ${esc(p.name)}"><span></span></label></td>
        <td><select class="inline-input" data-change="provider" aria-label="Provider for ${esc(p.name)}">${providers.map((pr) => `<option value="${esc(pr.id)}" ${(p.providerId ? p.providerId === pr.id : pr.usedBy.includes(p.name)) ? 'selected' : ''}>${esc(pr.name)}</option>`).join('')}
          ${!p.providerId && !providers.some((pr) => pr.usedBy.includes(p.name)) ? `<option value="" selected>${esc(p.providerName)}</option>` : ''}</select></td>
        <td class="hide-sm"><input class="inline-input" type="date" data-change="start" value="${esc(p.startDate || '')}" aria-label="Start date for ${esc(p.name)}"></td>
        <td class="hide-sm">${p.stats.events}</td>
        <td class="nowrap">${p.refreshState === 'queued' ? '<span class="label label-default">Queued</span>' : p.refreshing ? '<span class="label label-info">Refreshing…</span>'
          : p.refreshError ? `<span class="rejection" tabindex="0">${icon('warning')}<span class="tip">${esc(p.refreshError)}</span></span> <span class="muted">${relative(p.refreshedAt)}</span>`
          : p.refreshedAt ? `<span class="muted" title="${esc(formatDateTime(p.refreshedAt))}">${relative(p.refreshedAt)} · ${p.refreshCount}</span>` : '<span class="muted">Never</span>'}</td>
        <td class="actions"><button class="icon-button" data-action="refresh-promotion" data-id="${esc(p.id)}" title="Refresh now" aria-label="Refresh ${esc(p.name)}" ${p.refreshing ? 'disabled' : ''}>${icon('refresh')}</button></td></tr>`).join('')}
      </tbody></table></div>`;
  },

  async library() {
    setToolbar();
    promotionsCache = await api('/promotions');
    const items = await api('/library');
    if (!items.length) return `<h1 class="page-title">Library</h1><div class="empty-state">Nothing has been imported yet.</div>`;
    return `<h1 class="page-title">Library</h1><div class="table-panel"><table class="table"><thead><tr><th>Promotion</th><th>Event</th><th class="hide-sm">Date</th><th>Quality</th><th class="hide-sm">Size</th><th class="hide-sm">Imported</th></tr></thead><tbody>
      ${items.map((item) => `<tr><td class="nowrap">${esc(promotionOf(item.event)?.name || '')}</td><td class="title-cell">${esc(item.event?.title)}<div class="evidence">${esc(item.path)}</div></td>
        <td class="nowrap hide-sm">${formatDate(item.event?.date)}</td><td>${item.quality ? `<span class="label label-default">${esc(item.quality)}</span>` : ''}</td>
        <td class="nowrap hide-sm">${formatSize(item.size)}</td><td class="nowrap hide-sm" title="${esc(formatDateTime(item.importedAt))}">${relative(item.importedAt)}</td></tr>`).join('')}
    </tbody></table></div>`;
  },

  async calendar([offset = '0']) {
    const weeks = Number(offset) || 0;
    setToolbar(
      toolbarButton('calendar-prev', 'retry', 'Previous') + toolbarButton('calendar-today', 'calendar', 'Today') + toolbarButton('calendar-next', 'refresh', 'Next'),
      toolbarButton('sync-events', 'refresh', 'Refresh Events'),
    );
    promotionsCache = await api('/promotions');
    const start = new Date(Date.now() + weeks * 7 * 86400000 - 3 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.parse(start) + 21 * 86400000).toISOString().slice(0, 10);
    const events = (await api(`/events?from=${start}&to=${end}&limit=1000`)).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const days = new Map();
    for (const event of events) {
      if (!days.has(event.date)) days.set(event.date, []);
      days.get(event.date).push(event);
    }
    const body = [...days.entries()].map(([date, list]) => `<div class="agenda-day"><div class="agenda-date ${date === today() ? 'today' : ''}">${formatDate(date, { weekday: true })}</div>
      ${list.map((event) => {
        const status = eventStatus(event);
        return `<div class="agenda-event ${status.key}" data-event="${esc(event.id)}"><span class="muted">${esc(event.time || '')}</span>
          <div><a href="#/promotion/${esc(event.promotionId || '')}">${esc(promotionOf(event)?.name || '')}</a> · ${esc(event.title)}</div>
          <div class="nowrap">${statusLabel(status)} <button class="icon-button monitor-toggle ${event.request ? 'on' : ''}" data-action="toggle-monitor" aria-label="Toggle request" ${event.library ? 'disabled' : ''}>${icon(event.request || event.library ? 'bookmark-fill' : 'bookmark')}</button></div></div>`;
      }).join('')}</div>`).join('');
    return `<h1 class="page-title">${formatDate(start)} – ${formatDate(end)}</h1>${body || '<div class="empty-state">No events in this period.</div>'}
      <div class="legend"><span style="--c:var(--unaired)">Unaired</span><span style="--c:var(--danger)">Missing</span><span style="--c:var(--purple)">Downloading</span><span style="--c:var(--success)">Downloaded</span><span style="--c:var(--border-strong)">Unmonitored</span></div>`;
  },

  async activity([tab = 'queue']) {
    if (tab === 'history') {
      setToolbar(toolbarButton('reload', 'refresh', 'Refresh'));
      const rows = await api('/activity');
      const kinds = { request: 'label-info', match: 'label-warning', download: 'label-purple', ready: 'label-success', warning: 'label-danger', search: 'label-default', metadata: 'label-primary' };
      return `<div class="table-panel"><table class="table"><thead><tr><th>Event Type</th><th>Details</th><th class="hide-sm">Date</th></tr></thead><tbody>
        ${rows.map((row) => `<tr><td class="narrow"><span class="label ${kinds[row.kind] || 'label-default'}">${esc(row.kind)}</span></td><td class="title-cell">${esc(row.text)}</td><td class="nowrap hide-sm" title="${esc(formatDateTime(row.createdAt))}">${relative(row.createdAt)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No history yet.</td></tr>'}
      </tbody></table></div>`;
    }
    setToolbar(toolbarButton('check-downloads', 'refresh', 'Refresh'));
    promotionsCache = await api('/promotions');
    const queue = await api('/queue');
    schedulePoll(5000);
    if (!queue.length) return `<div class="empty-state"><h2>Queue is empty</h2><p>Approved releases appear here while they download and import.</p></div>`;
    return `<div class="table-panel"><table class="table"><thead><tr><th></th><th>Promotion</th><th>Event</th><th class="hide-sm">Release</th><th>Quality</th><th class="hide-sm">Client</th><th>Progress</th></tr></thead><tbody>
      ${queue.map((job) => {
        const event = job.request.event;
        const pct = Math.round((job.progress || 0) * 100);
        const state = job.request.status === 'importing' ? 'Importing' : job.state === 'queued' ? 'Queued' : `${pct}%`;
        return `<tr><td class="narrow">${job.error ? `<span class="rejection" tabindex="0">${icon('warning')}<span class="tip">${esc(job.error)}</span></span>` : icon('download')}</td>
          <td class="nowrap">${esc(promotionOf(event)?.name || '')}</td><td class="title-cell">${esc(event?.title)}</td>
          <td class="title-cell hide-sm evidence">${esc(job.candidate?.title)}</td><td>${job.candidate?.quality ? `<span class="label label-default">${esc(job.candidate.quality)}</span>` : ''}</td>
          <td class="nowrap hide-sm">${CLIENT_LABELS[job.client] || job.client}</td>
          <td style="min-width:130px"><div class="progress-bar tall"><span style="width:${job.request.status === 'importing' ? 100 : pct}%"></span><span class="progress-label">${state}</span></div></td></tr>`;
      }).join('')}
    </tbody></table></div>`;
  },

  async wanted([tab = 'missing']) {
    promotionsCache = await api('/promotions');
    const requests = await api('/requests');
    if (tab === 'review') {
      setToolbar(toolbarButton('reload', 'refresh', 'Refresh'));
      const review = requests.filter((r) => r.status === 'review');
      if (!review.length) return `<div class="empty-state"><h2>Nothing to review</h2><p>Events with matching releases wait here until you pick one.</p></div>`;
      return `<div class="alert">${icon('warning')}<div>Replayarr does not grab automatically in Phase 1. Open an event to compare the matching releases and choose one.</div></div>
        <div class="table-panel"><table class="table"><thead><tr><th>Promotion</th><th>Event</th><th class="hide-sm">Date</th><th>Matches</th><th></th></tr></thead><tbody>
        ${review.map((r) => `<tr data-event="${esc(r.eventId)}" data-request="${r.id}"><td class="nowrap">${esc(promotionOf(r.event)?.name || '')}</td><td class="title-cell">${esc(r.event?.title)}</td>
          <td class="nowrap hide-sm">${formatDate(r.event?.date)}</td><td><span class="label label-warning">${r.matchedCount}</span></td>
          <td class="actions"><button class="button button-primary" data-action="interactive-search">${icon('user')} Review</button></td></tr>`).join('')}
        </tbody></table></div>`;
    }
    setToolbar(toolbarButton('search-missing', 'search', 'Search All'), toolbarButton('reload', 'refresh', 'Refresh'));
    // Like Sonarr, "missing" means aired and not yet downloaded.
    const missing = requests.filter((r) => ['wanted', 'searching', 'failed'].includes(r.status) && r.event?.date <= today());
    if (!missing.length) return `<div class="empty-state"><h2>No missing events</h2><p>Every requested event has a release or is downloading.</p></div>`;
    return `<div class="table-panel"><table class="table"><thead><tr><th>Promotion</th><th>Event</th><th class="hide-sm">Date</th><th>Status</th><th class="hide-sm">Next Search</th><th></th></tr></thead><tbody>
      ${missing.map((r) => {
        const status = eventStatus({ ...r.event, request: r, library: r.library });
        return `<tr data-event="${esc(r.eventId)}" data-request="${r.id}"><td class="nowrap">${esc(promotionOf(r.event)?.name || '')}</td>
          <td class="title-cell">${esc(r.event?.title)}${r.error ? `<div class="evidence">${esc(r.error)}</div>` : ''}</td><td class="nowrap hide-sm">${formatDate(r.event?.date)}</td>
          <td class="narrow">${statusLabel(status)}</td><td class="nowrap hide-sm muted">${r.status === 'wanted' && r.nextSearchAt ? relative(r.nextSearchAt) : ''}</td>
          <td class="actions">${r.status === 'failed' ? `<button class="icon-button" data-action="retry" title="Retry" aria-label="Retry">${icon('retry')}</button>` : ''}
            <button class="icon-button" data-action="auto-search" title="Automatic search" aria-label="Automatic search" ${r.status === 'searching' ? 'disabled' : ''}>${icon('search')}</button>
            <button class="icon-button" data-action="interactive-search" title="Interactive search" aria-label="Interactive search">${icon('user')}</button>
            <button class="icon-button danger" data-action="remove-request" title="Remove request" aria-label="Remove request">${icon('trash')}</button></td></tr>`;
      }).join('')}
    </tbody></table></div>`;
  },

  async settings([tab = 'mediamanagement']) {
    setToolbar(toolbarButton('save-settings', 'save', 'Save Changes'));
    const { settings, rules } = await api('/settings');
    const field = (name, label, value, { type = 'text', help = '', placeholder = '', options } = {}) => `<div class="form-group"><label class="form-label" for="f-${name}">${label}</label><div class="form-input">
      ${options ? `<select id="f-${name}" name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
        : `<input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`}
      ${help ? `<div class="form-help">${help}</div>` : ''}</div></div>`;
    const test = (service) => `<div class="form-group"><span></span><div class="form-inline"><button type="button" class="button" data-action="test-service" data-service="${service}">${icon('check')} Test</button><span class="test-result" data-result="${service}"></span></div></div>`;
    let body = '';
    if (tab === 'mediamanagement') {
      body = `<fieldset class="fieldset" style="border:0;padding:0"><legend>Library</legend>
        ${field('library.root', 'Library Folder', settings.library.root, { placeholder: '/media/sports', help: 'Where imported events are placed. Point Plex, Jellyfin or Emby at this folder.' })}
        ${field('library.mode', 'Import Mode', settings.library.mode, { options: [['hardlink', 'Hardlink (fall back to copy)'], ['copy', 'Copy'], ['move', 'Move']], help: 'Hardlinks keep torrents seeding without using extra space. Move stops a torrent from seeding.' })}
        ${field('library.minSizeMb', 'Minimum File Size (MB)', settings.library.minSizeMb, { type: 'number', help: 'Files smaller than this are rejected as samples or clips.' })}</fieldset>
        <fieldset class="fieldset" style="border:0;padding:0"><legend>Event Naming</legend>
        ${field('library.naming', 'Event Format', settings.library.naming, { help: 'Tokens: {promotion} {title} {date} {year} {quality} {release}. Use / for folders.' })}
        <div class="form-group"><span class="form-label">Example</span><div class="form-input"><code id="naming-example"></code></div></div></fieldset>`;
    } else if (tab === 'indexers') {
      indexersCache = settings.indexers;
      body = `<fieldset class="fieldset" style="border:0;padding:0"><legend>Indexers</legend>
        <div class="cards">${settings.indexers.map((indexer) => `<button type="button" class="card indexer-card" data-action="edit-indexer" data-id="${esc(indexer.id)}">
            <h3>${esc(indexer.name)}</h3>
            <div class="labels"><span class="label label-default">${esc(INDEXER_TYPES[indexer.type]?.label || indexer.type)}</span>
              <span class="label label-outline">${esc(INDEXER_TYPES[indexer.type]?.protocol || '')}</span>
              ${indexer.enabled ? '<span class="label label-success">Enabled</span>' : '<span class="label label-danger">Disabled</span>'}
              <span class="label label-outline">${indexer.maxQueries} queries</span></div></button>`).join('')}
          <button type="button" class="card indexer-card add-card" data-action="add-indexer" aria-label="Add indexer">${icon('plus')}</button></div>
        <p class="form-help" style="max-width:none">Every enabled indexer is searched with the promotion's search titles, most precise first, up to its query limit. A release found by several indexers is listed once.</p></fieldset>
        <fieldset class="fieldset" style="border:0;padding:0"><legend>Release Preferences</legend>
        ${field('preferences.protocol', 'Preferred Protocol', settings.preferences.protocol, { options: [['any', 'No preference'], ['usenet', 'Prefer Usenet'], ['torrent', 'Prefer Torrent']] })}
        ${field('preferences.minSeeders', 'Minimum Seeders', settings.preferences.minSeeders, { type: 'number' })}</fieldset>`;
    } else if (tab === 'downloadclients') {
      const mappings = settings.pathMappings.length ? settings.pathMappings : [{ remote: '', local: '' }];
      body = `<fieldset class="fieldset" style="border:0;padding:0"><legend>qBittorrent</legend>
        ${field('qbittorrent.url', 'URL', settings.qbittorrent.url, { placeholder: 'http://qbittorrent:8080' })}
        ${field('qbittorrent.apiKey', 'API Key', settings.qbittorrent.apiKey, { type: 'password', help: 'qBittorrent 5.2 or newer: Options › WebUI › API Key. When set, the username and password are not used.' })}
        ${field('qbittorrent.username', 'Username', settings.qbittorrent.username, { help: 'Only needed without an API key.' })}
        ${field('qbittorrent.password', 'Password', settings.qbittorrent.password, { type: 'password' })}
        ${field('qbittorrent.category', 'Category', settings.qbittorrent.category)}
        ${field('qbittorrent.savePath', 'Save Path', settings.qbittorrent.savePath, { placeholder: '/downloads/replays', help: 'Where qBittorrent saves Replayarr's torrents, as a path inside qBittorrent. Blank uses the category's save path. Add a Remote Path Mapping below if Replayarr sees that folder under a different path.' })}
        ${test('qbittorrent')}</fieldset>
        <fieldset class="fieldset" style="border:0;padding:0"><legend>SABnzbd</legend>
        ${field('sabnzbd.url', 'URL', settings.sabnzbd.url, { placeholder: 'http://sabnzbd:8080' })}
        ${field('sabnzbd.apiKey', 'API Key', settings.sabnzbd.apiKey, { type: 'password', help: 'SABnzbd › Config › General › Security.' })}
        ${field('sabnzbd.category', 'Category', settings.sabnzbd.category)}
        ${test('sabnzbd')}</fieldset>
        <fieldset class="fieldset" style="border:0;padding:0"><legend>Remote Path Mappings</legend>
        <p class="form-help" style="max-width:none">Needed when a download client reports paths that Replayarr sees differently, for example across Docker containers.</p>
        <div class="table-panel"><table class="table" id="mappings"><thead><tr><th>Remote Path</th><th>Local Path</th><th></th></tr></thead><tbody>
        ${mappings.map((m) => `<tr><td class="form-input"><input data-map="remote" value="${esc(m.remote)}" placeholder="/downloads"></td><td class="form-input"><input data-map="local" value="${esc(m.local)}" placeholder="/data/downloads"></td><td class="actions"><button class="icon-button danger" data-action="remove-mapping" aria-label="Remove mapping">${icon('trash')}</button></td></tr>`).join('')}
        </tbody></table><button type="button" class="button" data-action="add-mapping" style="margin-top:10px">${icon('plus')} Add Mapping</button></div></fieldset>`;
    } else if (tab === 'metadatakeys') {
      const m = settings.metadata;
      body = `<fieldset class="fieldset" style="border:0;padding:0"><legend>Schedule</legend>
        ${field('metadata.daysBack', 'Import Past Days', m.daysBack, { type: 'number', help: 'How far back a refresh fetches, unless a promotion has its own start date. Longer windows make TheSportsDB refreshes much slower.' })}
        ${field('metadata.daysAhead', 'Import Upcoming Days', m.daysAhead, { type: 'number' })}
        ${field('metadata.refreshHours', 'Refresh Every (hours)', m.refreshHours, { type: 'number', help: 'Followed promotions refresh in the background on this interval.' })}</fieldset>
        <fieldset class="fieldset" style="border:0;padding:0"><legend>API Keys</legend>
        ${field('metadata.tsdbApiKey', 'TheSportsDB', m.tsdbApiKey, { help: '123 is TheSportsDB\'s free key. A Patreon key lifts its rate and result limits.' })}
        ${field('metadata.footballDataApiKey', 'football-data.org', m.footballDataApiKey, { type: 'password', help: 'Needed for the Premier League and other football-data providers. Free at football-data.org/client/register.' })}
        ${field('metadata.apiFootballApiKey', 'API-Football', m.apiFootballApiKey, { type: 'password', help: 'Only for API-Football providers.' })}
        ${field('metadata.tmdbApiKey', 'TMDB', m.tmdbApiKey, { type: 'password', help: 'Needed for Match of the Day and other TMDB providers. Free at themoviedb.org.' })}</fieldset>`;
    } else if (tab === 'promotions') {
      promotionsCache = await api('/promotions');
      setToolbar(toolbarButton('promotion-rule', 'plus', 'Add Rule'));
      return `<h1 class="page-title">Matching Rules</h1>
        <p class="form-help" style="max-width:none">Matching comes from SSS's promotion matchers. Add learned aliases to a built-in promotion, or create a custom promotion, when releases use names the matchers do not know.</p>
        <div class="table-panel"><table class="table"><thead><tr><th>Promotion</th><th>Type</th><th class="hide-sm">Aliases</th><th></th></tr></thead><tbody>
        ${promotionsCache.map((p) => {
          const rule = rules.find((r) => r.id === p.id);
          return `<tr><td>${esc(p.name)} <span class="muted">(${esc(p.id)})</span></td><td class="nowrap">${p.custom ? '<span class="label label-info">Custom</span>' : '<span class="label label-default">Built-in</span>'} ${p.overlay ? '<span class="label label-warning">Learned aliases</span>' : ''}</td>
            <td class="hide-sm evidence">${esc((rule?.spec.promotionAliases || []).join(', '))}</td>
            <td class="actions"><button class="icon-button" data-action="promotion-rule" data-id="${esc(p.id)}" title="Edit rules" aria-label="Edit rules">${icon('settings')}</button>
            ${rule ? `<button class="icon-button danger" data-action="delete-rule" data-id="${esc(p.id)}" title="Remove rules" aria-label="Remove rules">${icon('trash')}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`;
    } else if (tab === 'general') {
      setToolbar();
      const status = await api('/system/status');
      body = `<fieldset class="fieldset" style="border:0;padding:0"><legend>Security</legend>
        <p>Set <code>REPLAYARR_USERNAME</code> and <code>REPLAYARR_PASSWORD</code> in the environment to require a login. Replayarr listens on <code>HOST</code> (default 127.0.0.1) and <code>PORT</code> (default 4173).</p></fieldset>
        <fieldset class="fieldset" style="border:0;padding:0"><legend>Storage</legend><p>Database: <code>${esc(status.database)}</code> (set <code>REPLAYARR_DB</code> to move it).</p></fieldset>`;
    }
    return `<div class="settings-section" id="settings-form">${body}</div>`;
  },

  async system([tab = 'status']) {
    setToolbar();
    if (tab === 'tasks') {
      const tasks = await api('/system/tasks');
      return `<div class="table-panel"><table class="table"><thead><tr><th>Name</th><th class="hide-sm">Interval</th><th>Last Execution</th><th></th></tr></thead><tbody>
        ${tasks.map((t) => `<tr><td>${esc(t.title)}</td><td class="hide-sm">${esc(t.interval)}</td><td title="${esc(formatDateTime(t.lastRun))}">${t.lastRun ? relative(t.lastRun) : '<span class="muted">Never</span>'}</td>
          <td class="actions"><button class="icon-button" data-action="run-task" data-task="${esc(t.name)}" title="Run now" aria-label="Run ${esc(t.title)} now">${icon('refresh')}</button></td></tr>`).join('')}
      </tbody></table></div>`;
    }
    if (tab === 'events') {
      setToolbar(toolbarButton('reload', 'refresh', 'Refresh'));
      const rows = (await api('/activity')).filter((r) => ['warning', 'metadata'].includes(r.kind));
      return `<div class="table-panel"><table class="table"><thead><tr><th></th><th>Message</th><th class="hide-sm">Time</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td class="narrow">${r.kind === 'warning' ? `<span class="label label-warning">Warn</span>` : `<span class="label label-info">Info</span>`}</td><td class="title-cell">${esc(r.text)}</td><td class="nowrap hide-sm">${formatDateTime(r.createdAt)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No warnings.</td></tr>'}
      </tbody></table></div>`;
    }
    const [health, status] = await Promise.all([api('/health'), api('/system/status')]);
    return `<fieldset class="fieldset" style="border:0;padding:0"><legend>Health</legend>
      ${health.length ? health.map((h) => `<div class="alert alert-${h.type}">${icon('warning')}<div>${esc(h.message)} ${h.link ? `<a href="#/${esc(h.link)}">Fix</a>` : ''}</div></div>`).join('') : `<div class="alert alert-success">${icon('check')}<div>No issues with your configuration.</div></div>`}</fieldset>
      <fieldset class="fieldset" style="border:0;padding:0"><legend>About</legend><table class="table info-table"><tbody>
        <tr><td>Version</td><td>${esc(status.version)}</td></tr><tr><td>Node.js</td><td>${esc(status.node)} (${esc(status.platform)})</td></tr>
        <tr><td>Database</td><td class="title-cell">${esc(status.database)}</td></tr><tr><td>Promotions</td><td>${status.promotions}</td></tr>
        <tr><td>Started</td><td>${formatDateTime(status.startedAt)}</td></tr>
        <tr><td>Matching</td><td>Ported from SeriousSportSync</td></tr></tbody></table></fieldset>`;
  },
};

// --- modals -------------------------------------------------------------
function openModal(html, { small = false } = {}) {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal ${small ? 'small' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  $('.modal input, .modal select, .modal button', modalRoot)?.focus();
}
function closeModal() { modalRoot.innerHTML = ''; }

async function interactiveSearch(eventId, { searchFirst = true } = {}) {
  const request = await run(() => ensureRequest(eventId));
  if (!request) return;
  openModal(`<div class="modal-header"><span>Interactive Search – ${esc(request.event?.title || '')}</span><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body" id="release-body"><div class="empty-state">Loading…</div></div>
    <div class="modal-footer"><button class="button" data-action="modal-search" data-request="${request.id}">${icon('search')} Search Again</button><button class="button" data-action="close-modal">Close</button></div>`);
  const canSearch = ['wanted', 'review'].includes(request.status);
  if (searchFirst && canSearch && !request.matchedCount) await searchInModal(request.id);
  else await renderReleases(request.id);
}

async function searchInModal(requestId) {
  const body = $('#release-body');
  if (body) body.innerHTML = '<div class="empty-state">Searching Prowlarr…</div>';
  await run(() => api(`/requests/${requestId}/search`, { method: 'POST' }));
  await renderReleases(requestId);
}

async function renderReleases(requestId) {
  const body = $('#release-body');
  if (!body) return;
  const detail = await run(() => api(`/requests/${requestId}`));
  if (!detail) return;
  const locked = ['downloading', 'importing', 'ready'].includes(detail.status);
  const last = detail.searches[0];
  const summary = last ? `<p class="muted">Last search ${relative(last.createdAt)}: ${last.queries.length} quer${last.queries.length === 1 ? 'y' : 'ies'}, ${last.resultCount} results, ${last.matchedCount} matched${last.error ? ` · <span class="error-text">${esc(last.error)}</span>` : ''}.</p>` : '';
  if (!detail.candidates.length) {
    body.innerHTML = `${summary}<div class="empty-state"><h2>No results found</h2><p>${last ? 'Nothing matched this event yet. Replayarr retries automatically.' : 'Search to look for releases.'}</p></div>`;
    return;
  }
  body.innerHTML = `${summary}${locked ? `<div class="alert">${icon('download')}<div>A release for this event is already ${esc(detail.status)}.</div></div>` : ''}
    <table class="table"><thead><tr><th class="hide-sm">Source</th><th class="hide-sm">Age</th><th>Title</th><th class="hide-sm">Indexer</th><th>Size</th><th class="hide-sm">Peers</th><th>Quality</th><th>Score</th><th></th><th></th></tr></thead><tbody>
    ${detail.candidates.map((c) => {
      const rejected = c.decision !== 'matched';
      const chosen = detail.candidateId === c.id;
      return `<tr class="${rejected ? 'rejected' : ''}"><td class="hide-sm"><span class="label ${(PROTOCOL_LABELS[c.protocol] || PROTOCOL_LABELS.torrent)[1]}">${(PROTOCOL_LABELS[c.protocol] || PROTOCOL_LABELS.torrent)[0]}</span></td>
        <td class="nowrap hide-sm">${esc(age(c.publishedAt))}</td>
        <td class="title-cell">${esc(c.title)}${!rejected ? `<div class="evidence">${esc(c.evidence.join(' · '))}</div>` : ''}</td>
        <td class="hide-sm">${esc(c.source && c.indexer && c.indexer !== c.source ? `${c.source} · ${c.indexer}` : (c.source || c.indexer || ''))}</td><td class="nowrap">${formatSize(c.size)}</td>
        <td class="hide-sm">${c.protocol === 'torrent' ? esc(c.seeders ?? '') : ''}</td>
        <td>${c.quality ? `<span class="label label-default">${esc(c.quality)}</span>` : ''}</td>
        <td class="score">${rejected ? '' : c.score}</td>
        <td class="narrow">${rejected ? `<span class="rejection" tabindex="0" aria-label="Rejected">${icon('warning')}<span class="tip">${esc(c.reason || 'Did not match this event')}</span></span>` : ''}</td>
        <td class="actions">${chosen ? `<span class="label label-purple">Grabbed</span>` : `<button class="icon-button" data-action="grab" data-request="${detail.id}" data-candidate="${c.id}" title="${rejected ? 'Only a release that matched this event can be grabbed' : 'Download'}" aria-label="Download" ${rejected || locked ? 'disabled' : ''}>${icon('download')}</button>`}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function manualEventModal() {
  openModal(`<div class="modal-header"><span>Add Event Manually</span><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <form id="manual-form" class="modal-body">
      <div class="form-group"><label class="form-label" for="m-promotion">Promotion</label><div class="form-input"><select id="m-promotion" name="promotionId">${promotionsCache.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><div class="form-help">The promotion decides how releases are matched.</div></div></div>
      <div class="form-group"><label class="form-label" for="m-title">Event Name</label><div class="form-input"><input id="m-title" name="title" required placeholder="Arsenal vs Manchester City"><div class="form-help">Write fixtures as "Home vs Away" so both teams are checked.</div></div></div>
      <div class="form-group"><label class="form-label" for="m-date">Date</label><div class="form-input"><input id="m-date" name="date" type="date" required></div></div>
      <div class="form-group"><label class="form-label" for="m-time">Start Time (UTC)</label><div class="form-input"><input id="m-time" name="time" type="time"></div></div>
      <div class="form-group"><label class="form-label" for="m-aliases">Aliases</label><div class="form-input"><textarea id="m-aliases" name="aliases" placeholder="One per line"></textarea></div></div>
      <div class="form-group"><span></span><label class="form-inline"><input type="checkbox" name="request" checked> Request this event</label></div>
    </form>
    <div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="manual-form">Add Event</button></div>`, { small: true });
}

async function promotionRuleModal(id) {
  const { rules } = await api('/settings');
  const rule = rules.find((r) => r.id === id);
  const promotion = promotionsCache.find((p) => p.id === id);
  const kind = promotion && !promotion.custom ? 'overlay' : 'custom';
  const spec = rule?.spec || {};
  const list = (value) => esc((value || []).join('\n'));
  openModal(`<div class="modal-header"><span>${promotion ? `${esc(promotion.name)} rules` : 'New custom promotion'}</span><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <form id="rule-form" class="modal-body" data-kind="${kind}">
      ${kind === 'custom' ? `<div class="form-group"><label class="form-label" for="r-id">Id</label><div class="form-input"><input id="r-id" name="id" value="${esc(id || '')}" ${id ? 'readonly' : ''} required pattern="[a-z0-9][a-z0-9-]{1,40}" placeholder="pll"><div class="form-help">Lowercase; used as the event id prefix.</div></div></div>
        <div class="form-group"><label class="form-label" for="r-name">Name</label><div class="form-input"><input id="r-name" name="name" value="${esc(spec.name || promotion?.name || '')}" required placeholder="Professional Fighters League"></div></div>`
        : `<input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="name" value="${esc(promotion.name)}"><div class="alert">${icon('warning')}<div>Learned rules are layered over the built-in matcher. The built-in rules still apply.</div></div>`}
      <div class="form-group"><label class="form-label" for="r-examples">Example Releases</label><div class="form-input"><textarea id="r-examples" name="examples" placeholder="PFL.2026.09.19.Finals.1080p.WEB.h264-SPORTS"></textarea><div class="form-help">Paste real release names for this promotion and Replayarr will suggest rules (SSS's alias learner).</div></div></div>
      <div class="form-group"><label class="form-label" for="r-bad">Wrong Releases</label><div class="form-input"><textarea id="r-bad" name="badExamples" placeholder="Releases that must not match"></textarea></div></div>
      <div class="form-group"><span></span><div><button type="button" class="button" data-action="suggest-rules">Suggest From Examples</button></div></div>
      <div class="form-group"><label class="form-label" for="r-aliases">Aliases</label><div class="form-input"><textarea id="r-aliases" name="promotionAliases">${list(spec.promotionAliases)}</textarea></div></div>
      <div class="form-group"><label class="form-label" for="r-keywords">Required Keywords</label><div class="form-input"><textarea id="r-keywords" name="relevanceKeywords">${list(spec.relevanceKeywords)}</textarea><div class="form-help">A release must contain one of these unless both teams matched.</div></div></div>
      <div class="form-group"><label class="form-label" for="r-exclusions">Exclusions</label><div class="form-input"><textarea id="r-exclusions" name="exclusionKeywords">${list(spec.exclusionKeywords)}</textarea></div></div>
      <div class="form-group"><label class="form-label" for="r-templates">Search Templates</label><div class="form-input"><textarea id="r-templates" name="searchTitleTemplates">${list(spec.searchTitleTemplates)}</textarea><div class="form-help">Tokens: {name} {promotion} {year} {date} {date_dotted} {date_spaced} {date_compact}</div></div></div>
      <div class="form-group"><span></span><label class="form-inline"><input type="checkbox" name="requireDateInTitle" ${spec.requireDateInTitle ? 'checked' : ''}> Require the event date in release names</label></div>
    </form>
    <div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="rule-form">Save</button></div>`);
}

function indexerModal(indexer) {
  const isNew = !indexer.id;
  const type = INDEXER_TYPES[indexer.type];
  const input = (name, label, value, { type: inputType = 'text', help = '', placeholder = '' } = {}) => `<div class="form-group"><label class="form-label" for="ix-${name}">${label}</label><div class="form-input">
    <input id="ix-${name}" name="${name}" type="${inputType}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" autocomplete="off">${help ? `<div class="form-help">${help}</div>` : ''}</div></div>`;
  const fields = {
    prowlarr: input('url', 'URL', indexer.url, { placeholder: 'http://prowlarr:9696' })
      + input('apiKey', 'API Key', indexer.apiKey, { type: 'password', help: 'Prowlarr › Settings › General › API Key.' })
      + input('timeoutMs', 'Query Timeout (ms)', indexer.timeoutMs ?? 20000, { type: 'number' }),
    bitmagnet: input('url', 'URL', indexer.url, { placeholder: 'http://gluetun:3333', help: 'The Bitmagnet web address; /graphql is added automatically.' })
      + input('limit', 'Results Per Query', indexer.limit ?? 100, { type: 'number', help: 'Ordered by seeders, so a limit keeps the best-seeded end.' })
      + input('timeoutMs', 'Query Timeout (ms)', indexer.timeoutMs ?? 15000, { type: 'number' }),
    easynews: input('username', 'Username', indexer.username)
      + input('password', 'Password', indexer.password, { type: 'password' })
      + input('downloadFolder', 'Download Folder', indexer.downloadFolder, { placeholder: '/data/downloads/easynews', help: 'Where Replayarr saves Easynews files before importing. Put it on the same drive as the library so imports can be hardlinks.' })
      + input('timeoutMs', 'Search Timeout (ms)', indexer.timeoutMs ?? 20000, { type: 'number' }),
  }[indexer.type];
  const defaultQueries = { prowlarr: 6, bitmagnet: 12, easynews: 4 }[indexer.type];
  openModal(`<div class="modal-header"><span>${isNew ? 'Add' : 'Edit'} Indexer – ${esc(type.label)}</span><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <form id="indexer-form" class="modal-body" data-id="${esc(indexer.id || '')}" data-type="${esc(indexer.type)}">
      <p class="form-help" style="max-width:none;margin-top:0">${esc(type.about)}</p>
      ${input('name', 'Name', indexer.name || type.label)}
      <div class="form-group"><span></span><label class="form-inline"><input type="checkbox" name="enabled" ${indexer.enabled === false ? '' : 'checked'}> Enable</label></div>
      ${fields}
      ${input('maxQueries', 'Queries Per Search', indexer.maxQueries ?? defaultQueries, { type: 'number', help: 'How many of the promotion\'s search titles to send, most precise first.' })}
    </form>
    <div class="modal-footer">${isNew ? '' : '<button class="button button-danger" data-action="delete-indexer" style="margin-right:auto">Delete</button>'}
      <span class="test-result" data-result="indexer" style="align-self:center"></span>
      <button class="button" data-action="test-indexer">${icon('check')} Test</button>
      <button class="button" data-action="close-modal">Cancel</button>
      <button class="button button-primary" type="submit" form="indexer-form">Save</button></div>`, { small: true });
}

function indexerTypeModal() {
  openModal(`<div class="modal-header"><span>Add Indexer</span><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body"><div class="cards">${Object.entries(INDEXER_TYPES).map(([key, type]) => `<button type="button" class="card indexer-card" data-action="new-indexer" data-type="${key}">
      <h3>${esc(type.label)}</h3><p class="form-help" style="margin:0">${esc(type.about)}</p></button>`).join('')}</div></div>`, { small: true });
}

function readIndexerForm() {
  const form = $('#indexer-form');
  const data = { id: form.dataset.id || undefined, type: form.dataset.type, enabled: form.elements.enabled.checked };
  for (const el of form.querySelectorAll('input[name]')) if (el.type !== 'checkbox') data[el.name] = el.value;
  return data;
}

async function saveIndexers(list, success) {
  const saved = await run(() => api('/settings', { method: 'PUT', body: { indexers: list } }), success);
  if (saved) { indexersCache = saved.indexers; closeModal(); render({ quiet: true }); }
}

async function logoModal(id, query = '') {
  const promotion = promotionsCache.find((p) => p.id === id) || (await api('/promotions')).find((p) => p.id === id);
  if (!promotion) return;
  openModal(`<div class="modal-header"><span>Logo – ${esc(promotion.name)}</span><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body" data-promotion="${esc(id)}">
      <div class="logo-current"><div class="img" style="${logoOf(promotion) ? `background-image:url('${esc(logoOf(promotion))}')` : ''}"></div>
        <div><div>${promotion.logo ? 'Custom logo' : promotion.defaultLogo ? 'Shipped artwork' : 'No logo'}</div>
        ${promotion.logo ? `<button class="button" data-action="logo-reset" data-id="${esc(id)}" style="margin-top:8px">Reset to default</button>` : ''}</div></div>
      <div class="form-inline" style="margin-bottom:14px">
        <input class="inline-input" id="logo-query" style="max-width:none;flex:1" value="${esc(query)}" placeholder="Search Wikipedia and Wikimedia Commons, e.g. ${esc(promotion.name)} logo">
        <button class="button" data-action="logo-search" data-id="${esc(id)}">${icon('search')} Search</button>
      </div>
      <div class="form-inline" style="margin-bottom:14px">
        <input class="inline-input" id="logo-url" style="max-width:none;flex:1" placeholder="https://… image URL">
        <button class="button" data-action="logo-use-url" data-id="${esc(id)}">Use URL</button>
        <label class="button">${icon('download')} Upload<input type="file" id="logo-file" data-id="${esc(id)}" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden></label>
      </div>
      <div id="logo-results"><div class="empty-state">Finding logos…</div></div>
    </div>`);
  const out = $('#logo-results');
  const result = await run(() => api(`/metadata/promotions/${encodeURIComponent(id)}/logos?q=${encodeURIComponent(query)}`));
  if (!result || !out) return;
  if (!result.candidates.length) {
    out.innerHTML = `<div class="empty-state">No logos found${result.errors.length ? ` (${esc(result.errors.join('; '))})` : ''}. Try another search, a URL or an upload.</div>`;
    return;
  }
  out.innerHTML = `<div class="logo-grid">${result.candidates.map((c) => `<button type="button" class="logo-tile ${c.url === promotion.logo ? 'current' : ''}" data-action="logo-choose" data-id="${esc(id)}" data-url="${esc(c.url)}" title="${esc(c.url)}">
    <div class="img" style="background-image:url('${esc(c.thumb)}')"></div><small><strong>${esc(c.source)}</strong><br>${esc(c.label)}</small></button>`).join('')}</div>`;
  // Hide candidates whose image does not load, so broken art is never offered.
  for (const tile of out.querySelectorAll('.logo-tile')) {
    const probe = new Image();
    probe.onerror = () => tile.remove();
    probe.src = tile.querySelector('.img').style.backgroundImage.slice(5, -2);
  }
}

async function setLogo(id, logoUrl) {
  const ok = await run(() => api(`/metadata/promotions/${encodeURIComponent(id)}`, { method: 'PUT', body: { logoUrl } }), logoUrl ? 'Logo updated' : 'Logo reset');
  if (ok) { closeModal(); render({ quiet: true }); }
}

const PROVIDER_TYPES = [
  ['json-feed', 'Custom JSON/API schedule'], ['thesportsdb', 'TheSportsDB league'], ['espn', 'ESPN league'],
  ['football-data', 'football-data.org'], ['api-football', 'API-Football competition'], ['uefa', 'UEFA official competition'],
  ['tmdb', 'TMDB TV series'], ['mlb', 'MLB official schedule'], ['onefc', 'ONE official schedule'], ['aew', 'AEW official schedule'],
];
function providerModal() {
  const input = (name, label, { placeholder = '', help = '', type = 'text' } = {}) => `<div class="form-group"><label class="form-label" for="pv-${name}">${label}</label><div class="form-input"><input id="pv-${name}" name="${name}" type="${type}" placeholder="${esc(placeholder)}" autocomplete="off">${help ? `<div class="form-help">${help}</div>` : ''}</div></div>`;
  const group = (type, html) => `<div class="provider-fields" data-type="${type}">${html}</div>`;
  openModal(`<div class="modal-header"><span>Add Provider</span><button class="icon-button" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <form id="provider-form" class="modal-body">
      ${input('name', 'Name', { placeholder: 'ESPN · NHL' })}
      ${input('id', 'Provider ID', { placeholder: 'espn-nhl', help: 'Lowercase letters, numbers, - and _. Filled in from the name.' })}
      <div class="form-group"><label class="form-label" for="pv-type">Type</label><div class="form-input"><select id="pv-type" name="type">${PROVIDER_TYPES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div></div>
      ${group('json-feed', input('url', 'JSON/API URL', { type: 'url', placeholder: 'https://api.example.com/events' })
        + input('arrayPath', 'Event List Path', { placeholder: 'data.events', help: 'Leave blank when the response itself is a list.' })
        + input('nameField', 'Event Name Field', { placeholder: 'title' }) + input('dateField', 'Event Date Field', { placeholder: 'start.date' })
        + input('idField', 'Event ID Field', { placeholder: 'id (optional)' }) + input('timeField', 'Start Time Field', { placeholder: 'start.time (optional)' })
        + input('venueField', 'Venue Field', { placeholder: 'optional' }) + input('posterField', 'Artwork Field', { placeholder: 'optional' })
        + input('descriptionField', 'Description Field', { placeholder: 'optional' }))}
      ${group('thesportsdb', input('leagueId', 'League ID', { placeholder: '4424', help: 'The number in a thesportsdb.com league URL.' }))}
      ${group('espn', input('league', 'League', { placeholder: 'nhl, nfl, nba, mlb, eng.1, usa.1…' }))}
      ${group('football-data', input('competitionId', 'Competition ID/Code', { placeholder: 'PL or 2021' }) + input('teamId', 'Team ID', { placeholder: '66 (instead of a competition)' }))}
      ${group('api-football', input('apiFootballLeagueId', 'Competition ID', { placeholder: '2' }))}
      ${group('uefa', input('uefaCompetitionId', 'Competition ID', { placeholder: '1', help: 'Champions League is 1. No API key needed.' }))}
      ${group('tmdb', input('tvIds', 'TV IDs', { placeholder: '224, 3231' }))}
      ${group('mlb', '<p class="muted">No settings: uses MLB\'s official schedule.</p>')}
      ${group('onefc', '<p class="muted">No settings: uses ONE\'s official schedule.</p>')}
      ${group('aew', '<p class="muted">No settings: uses AEW\'s official schedule.</p>')}
      <div id="draft-preview"></div>
    </form>
    <div class="modal-footer"><button class="button" data-action="preview-draft">Test &amp; Preview</button><button class="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit" form="provider-form">Save</button></div>`, { small: true });
  showProviderFields();
}
function showProviderFields() {
  const type = $('#pv-type')?.value;
  document.querySelectorAll('.provider-fields').forEach((el) => { el.hidden = el.dataset.type !== type; });
}
function readProviderForm() {
  const form = $('#provider-form');
  const data = { type: form.elements.type.value };
  for (const el of form.querySelectorAll('input[name]')) {
    if (el.closest('.provider-fields')?.hidden) continue;
    if (el.value.trim()) data[el.name] = el.value.trim();
  }
  return data;
}
function previewHtml(result) {
  if (!result.ok) return `<div class="alert alert-error">${icon('warning')}<div>Test failed: ${esc(result.error || 'unknown error')}</div></div>`;
  const rows = (result.events || []).map((e) => `<div class="evidence">${esc(e.date || 'No date')} · ${esc(e.name)}${e.venue ? ' · ' + esc(e.venue) : ''}</div>`).join('');
  return `<div class="alert alert-success">${icon('check')}<div>Connected to ${esc(result.source.name)} · ${result.normalized} event${result.normalized === 1 ? '' : 's'} read${rows ? `<div style="margin-top:6px">${rows}</div>` : '<div class="evidence">No events in the preview window.</div>'}</div></div>`;
}

// --- router -------------------------------------------------------------
function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return parts.length ? parts : ['promotions'];
}

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => render({ quiet: true }), ms);
}

async function render({ quiet = false } = {}) {
  clearTimeout(pollTimer);
  const token = ++renderToken;
  const route = currentRoute();
  const page = pages[route[0]] || pages.promotions;
  renderSidebar(route);
  document.body.classList.remove('sidebar-open');
  if (!quiet) content.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const html = await page(route.slice(1));
    if (token !== renderToken) return;
    content.innerHTML = html;
    afterRender(route);
  } catch (error) {
    if (token !== renderToken) return;
    content.innerHTML = `<div class="alert alert-error">${icon('warning')}<div>${esc(error.message)}</div></div>`;
  }
  refreshChrome().then(() => { if (token === renderToken) renderSidebar(route); });
}

function afterRender(route) {
  if (route[0] === 'settings' && route[1] === 'mediamanagement') updateNamingExample();
  if (route[0] === 'add') $('#add-search')?.focus();
}

function updateNamingExample() {
  const input = $('[name="library.naming"]');
  const out = $('#naming-example');
  if (!input || !out) return;
  const tokens = { promotion: 'Premier League', title: 'Arsenal vs Manchester City', date: '2026-09-21', year: '2026', quality: '1080p', release: 'EPL.2026.09.21.Arsenal.vs.Man.City.1080p.WEB' };
  out.textContent = input.value.replace(/\{(\w+)\}/g, (_, key) => tokens[key] ?? '') + '.mkv';
}

// --- actions ------------------------------------------------------------
function collectSettings() {
  const form = $('#settings-form');
  const out = {};
  for (const input of form.querySelectorAll('[name]')) {
    const [section, key] = input.name.split('.');
    (out[section] ||= {})[key] = input.value;
  }
  const mappings = $('#mappings');
  if (mappings) {
    out.pathMappings = [...mappings.querySelectorAll('tbody tr')].map((row) => ({
      remote: $('[data-map="remote"]', row).value, local: $('[data-map="local"]', row).value,
    }));
  }
  return out;
}

const actions = {
  'close-modal': (el, event) => { if (event.target === el || el.tagName === 'BUTTON') closeModal(); },
  reload: () => render(),
  'go-add': () => { location.hash = '#/add'; },
  'manual-event': async () => { promotionsCache = promotionsCache.length ? promotionsCache : await api('/promotions'); manualEventModal(); },
  'sync-events': async () => {
    const status = await run(() => api('/metadata/refresh', { method: 'POST' }));
    if (status) message(status.running ? 'Refreshing followed promotions in the background' : 'No followed promotions to refresh', status.running ? 'success' : 'info');
    render({ quiet: true });
  },
  'refresh-promotion': async (el) => {
    const id = el.dataset.id || currentRoute()[1];
    await run(() => api('/metadata/refresh', { method: 'POST', body: { ids: [id] } }), 'Refresh started');
    render({ quiet: true });
  },
  'follow-promotion': async (el) => {
    const id = el.dataset.id;
    const ok = await run(() => api(`/metadata/promotions/${encodeURIComponent(id)}`, { method: 'PUT', body: { followed: true } }), 'Promotion added; fetching its schedule');
    if (ok) location.hash = `#/promotion/${id}`;
  },
  'logo-picker': (el) => logoModal(el.dataset.id || currentRoute()[1]),
  'logo-search': (el) => logoModal(el.dataset.id, $('#logo-query')?.value.trim() || ''),
  'logo-choose': (el) => setLogo(el.dataset.id, el.dataset.url),
  'logo-use-url': (el) => {
    const url = $('#logo-url')?.value.trim();
    if (url) setLogo(el.dataset.id, url);
  },
  'logo-reset': (el) => setLogo(el.dataset.id, ''),
  'add-provider': () => providerModal(),
  'preview-provider': async (el) => {
    const out = $('#provider-preview');
    out.innerHTML = `<div class="alert">${icon('refresh')}<div>Testing ${esc(el.closest('tr').querySelector('strong').textContent)}…</div></div>`;
    const result = await api('/metadata/providers/preview', { method: 'POST', body: { providerId: el.dataset.id } }).catch((error) => ({ ok: false, error: error.message }));
    out.innerHTML = previewHtml(result);
  },
  'preview-draft': async () => {
    const out = $('#draft-preview');
    out.innerHTML = `<div class="alert">${icon('refresh')}<div>Testing without saving…</div></div>`;
    const result = await api('/metadata/providers/preview', { method: 'POST', body: readProviderForm() }).catch((error) => ({ ok: false, error: error.message }));
    out.innerHTML = previewHtml(result);
  },
  'delete-provider': async (el) => {
    if (!confirm('Delete this provider? Promotions using it go back to their shipped source.')) return;
    await run(() => api(`/metadata/providers/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' }), 'Provider deleted');
    render({ quiet: true });
  },
  'search-missing': async () => {
    await run(() => api('/system/tasks/search-missing', { method: 'POST' }), (r) => `Search queued for ${r.queued} missing event${r.queued === 1 ? '' : 's'}`);
    render();
  },
  'check-downloads': async () => { await run(() => api('/system/tasks/check-downloads', { method: 'POST' })); render(); },
  'search-promotion': async () => {
    const id = currentRoute()[1];
    const requests = (await api('/requests')).filter((r) => r.event?.promotionId === id && r.status === 'wanted');
    for (const r of requests) await run(() => api(`/requests/${r.id}/search`, { method: 'POST' }));
    message(`Searched ${requests.length} monitored event${requests.length === 1 ? '' : 's'}`, 'success');
    render();
  },
  'expand-all': () => document.querySelectorAll('.season').forEach((s) => s.classList.remove('collapsed')),
  'collapse-all': () => document.querySelectorAll('.season').forEach((s) => s.classList.add('collapsed')),
  'toggle-season': (el) => el.closest('.season').classList.toggle('collapsed'),
  'calendar-prev': () => { location.hash = `#/calendar/${(Number(currentRoute()[1]) || 0) - 1}`; },
  'calendar-next': () => { location.hash = `#/calendar/${(Number(currentRoute()[1]) || 0) + 1}`; },
  'calendar-today': () => { location.hash = '#/calendar'; },
  'toggle-monitor': async (el) => {
    const eventId = el.closest('[data-event]').dataset.event;
    const events = await api('/events?limit=1000');
    const event = events.find((e) => e.id === eventId);
    if (event?.request) {
      if (['downloading', 'importing'].includes(event.request.status)
        && !confirm('This event is downloading. Stop monitoring it? The download stays in your client.')) return;
      await run(() => api(`/requests/${event.request.id}`, { method: 'DELETE' }), 'Event unmonitored');
    } else {
      await run(() => api('/requests', { method: 'POST', body: { eventId } }), 'Event requested');
    }
    render({ quiet: true });
  },
  'auto-search': async (el) => {
    const eventId = el.closest('[data-event]').dataset.event;
    el.disabled = true;
    const request = await run(() => ensureRequest(eventId));
    if (request) {
      const result = await run(() => api(`/requests/${request.id}/search`, { method: 'POST' }));
      if (result) message(result.status === 'review' ? `${result.matchedCount} matching release${result.matchedCount === 1 ? '' : 's'} found` : (result.error || 'No matching release yet'), result.status === 'review' ? 'success' : 'info');
    }
    render({ quiet: true });
  },
  'interactive-search': (el) => interactiveSearch(el.closest('[data-event]').dataset.event),
  'modal-search': (el) => searchInModal(el.dataset.request),
  grab: async (el) => {
    el.disabled = true;
    const ok = await run(() => api(`/requests/${el.dataset.request}/approve`, { method: 'POST', body: { candidateId: Number(el.dataset.candidate) } }), 'Release sent to download client');
    if (ok) { closeModal(); render({ quiet: true }); } else el.disabled = false;
  },
  retry: async (el) => { await run(() => api(`/requests/${el.closest('[data-request]').dataset.request}/retry`, { method: 'POST' }), 'Retrying'); render({ quiet: true }); },
  'remove-request': async (el) => {
    if (!confirm('Remove this request?')) return;
    await run(() => api(`/requests/${el.closest('[data-request]').dataset.request}`, { method: 'DELETE' }), 'Request removed');
    render({ quiet: true });
  },
  'save-settings': async () => {
    const saved = await run(() => api('/settings', { method: 'PUT', body: collectSettings() }), 'Settings saved');
    if (saved) render({ quiet: true });
  },
  'test-service': async (el) => {
    const service = el.dataset.service;
    const out = $(`[data-result="${service}"]`);
    out.className = 'test-result';
    out.textContent = 'Saving and testing…';
    try {
      await api('/settings', { method: 'PUT', body: collectSettings() });
      const result = await api(`/settings/test/${service}`, { method: 'POST' });
      out.className = 'test-result ok';
      out.textContent = result.message;
    } catch (error) {
      out.className = 'test-result fail';
      out.textContent = error.message;
    }
  },
  'add-mapping': () => {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="form-input"><input data-map="remote" placeholder="/downloads"></td><td class="form-input"><input data-map="local" placeholder="/data/downloads"></td><td class="actions"><button class="icon-button danger" data-action="remove-mapping" aria-label="Remove mapping">${icon('trash')}</button></td>`;
    $('#mappings tbody').append(row);
  },
  'remove-mapping': (el) => el.closest('tr').remove(),
  'run-task': async (el) => {
    el.classList.add('spinning');
    await run(() => api(`/system/tasks/${el.dataset.task}`, { method: 'POST' }), 'Task complete');
    render({ quiet: true });
  },
  'add-indexer': () => indexerTypeModal(),
  'new-indexer': (el) => indexerModal({ type: el.dataset.type }),
  'edit-indexer': (el) => indexerModal(indexersCache.find((i) => i.id === el.dataset.id)),
  'test-indexer': async () => {
    const out = $('[data-result="indexer"]');
    out.className = 'test-result';
    out.textContent = 'Testing…';
    try {
      const result = await api('/indexers/test', { method: 'POST', body: readIndexerForm() });
      out.className = 'test-result ok';
      out.textContent = result.message;
    } catch (error) {
      out.className = 'test-result fail';
      out.textContent = error.message;
    }
  },
  'delete-indexer': async () => {
    const { id } = readIndexerForm();
    if (!confirm('Delete this indexer?')) return;
    await saveIndexers(indexersCache.filter((i) => i.id !== id), 'Indexer deleted');
  },
  'promotion-rule': async (el) => { promotionsCache = promotionsCache.length ? promotionsCache : await api('/promotions'); promotionRuleModal(el.dataset.id || ''); },
  'delete-rule': async (el) => {
    if (!confirm('Remove these rules?')) return;
    await run(() => api(`/promotion-rules/${el.dataset.id}`, { method: 'DELETE' }), 'Rules removed');
    render({ quiet: true });
  },
  'suggest-rules': async () => {
    const form = $('#rule-form');
    const suggestion = await run(() => api('/promotion-rules/suggest', { method: 'POST', body: {
      name: form.elements.name.value, examples: form.elements.examples.value, badExamples: form.elements.badExamples.value,
    } }));
    if (!suggestion) return;
    form.elements.promotionAliases.value = suggestion.aliases.join('\n');
    form.elements.relevanceKeywords.value = suggestion.keywords.join('\n');
    form.elements.exclusionKeywords.value = suggestion.exclusions.join('\n');
    form.elements.searchTitleTemplates.value = suggestion.searchTitleTemplates.join('\n');
    message('Rules suggested from your examples; review them before saving', 'success');
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const handler = actions[el.dataset.action];
  if (handler) handler(el, event);
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'manual-form') {
    const data = Object.fromEntries(new FormData(form));
    const created = await run(() => api('/events', { method: 'POST', body: { ...data, aliases: data.aliases } }), 'Event added');
    if (!created) return;
    if (data.request) await run(() => api('/requests', { method: 'POST', body: { eventId: created.id } }));
    closeModal();
    location.hash = `#/promotion/${created.promotionId}`;
    render();
  }
  if (form.id === 'provider-form') {
    const data = readProviderForm();
    const saved = await run(() => api('/metadata/providers', { method: 'POST', body: data }), 'Provider saved; assign it under Metadata › Promotions');
    if (saved) { closeModal(); render({ quiet: true }); }
  }
  if (form.id === 'indexer-form') {
    const data = readIndexerForm();
    const list = data.id ? indexersCache.map((i) => (i.id === data.id ? data : i)) : [...indexersCache, data];
    await saveIndexers(list, 'Indexer saved');
  }
  if (form.id === 'rule-form') {
    const lines = (name) => form.elements[name].value.split('\n').map((v) => v.trim()).filter(Boolean);
    const spec = {
      name: form.elements.name.value.trim(),
      promotionAliases: lines('promotionAliases'), relevanceKeywords: lines('relevanceKeywords'),
      exclusionKeywords: lines('exclusionKeywords'), searchTitleTemplates: lines('searchTitleTemplates'),
      requireDateInTitle: form.elements.requireDateInTitle.checked,
    };
    const ok = await run(() => api('/promotion-rules', { method: 'PUT', body: { id: form.elements.id.value, kind: form.dataset.kind, spec } }), 'Rules saved');
    if (ok) { closeModal(); render(); }
  }
});

// Add New: search synced events that are not yet requested.
let addTimer = null;
document.addEventListener('input', (event) => {
  if (event.target.name === 'library.naming') updateNamingExample();
  if (event.target.id === 'promo-filter') {
    const q = event.target.value.trim().toLowerCase();
    document.querySelectorAll('#add-promos .add-promo').forEach((card) => { card.hidden = q && !card.dataset.name.includes(q); });
  }
  if (event.target.id === 'pv-name' && !$('#pv-id').dataset.manual) {
    $('#pv-id').value = event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }
  if (event.target.id === 'pv-id') event.target.dataset.manual = '1';
  if (event.target.id === 'add-search') {
    clearTimeout(addTimer);
    addTimer = setTimeout(async () => {
      const q = event.target.value.trim();
      const out = $('#add-results');
      if (!out) return;
      if (q.length < 2) { out.innerHTML = '<div class="empty-state">Start typing to find an event from your SSS calendar.</div>'; return; }
      const events = await api(`/events?q=${encodeURIComponent(q)}&limit=100`);
      out.innerHTML = events.length ? `<table class="table"><thead><tr><th></th><th>Promotion</th><th>Event</th><th class="hide-sm">Date</th><th>Status</th><th></th></tr></thead><tbody>${eventRows(events, { showPromotion: true })}</tbody></table>`
        : `<div class="empty-state">No events match "${esc(q)}". <a href="#" data-action="manual-event">Add it manually</a>.</div>`;
    }, 200);
  }
  if (event.target.id === 'global-search') globalSearch(event.target.value);
});

let searchTimer = null;
function globalSearch(value) {
  clearTimeout(searchTimer);
  const box = $('#search-results');
  const q = value.trim().toLowerCase();
  if (q.length < 2) { box.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    if (!promotionsCache.length) promotionsCache = await api('/promotions');
    const promotions = promotionsCache.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q)).slice(0, 5);
    const events = (await api(`/events?q=${encodeURIComponent(q)}&limit=8`));
    box.innerHTML = promotions.map((p) => `<a href="#/promotion/${esc(p.id)}"><span>${esc(p.name)}</span><small>Promotion</small></a>`).join('')
      + events.map((e) => `<a href="#/promotion/${esc(e.promotionId || '')}"><span>${esc(e.title)}</span><small>${formatDate(e.date)}</small></a>`).join('')
      || '<div class="empty">No results</div>';
    box.hidden = false;
  }, 150);
}
document.addEventListener('focusout', (event) => {
  if (event.target.id === 'global-search') setTimeout(() => { $('#search-results').hidden = true; }, 150);
});

document.addEventListener('change', async (event) => {
  const el = event.target;
  if (el.id === 'pv-type') return showProviderFields();
  if (el.id === 'logo-file' && el.files?.[0]) {
    const file = el.files[0];
    if (file.size > 2 * 1024 * 1024) return message('Logos must be 2 MB or smaller.', 'error');
    const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
    const ok = await run(() => api(`/metadata/promotions/${encodeURIComponent(el.dataset.id)}/logo`, { method: 'POST', body: { dataUrl } }), 'Logo uploaded');
    if (ok) { closeModal(); render({ quiet: true }); }
    return;
  }
  const kind = el.dataset.change;
  if (!kind) return;
  const id = el.closest('[data-id]')?.dataset.id;
  const body = kind === 'follow' ? { followed: el.checked } : kind === 'provider' ? { providerId: el.value || null } : { startDate: el.value || null };
  if (kind === 'follow' && !el.checked && !confirm('Stop following this promotion? Its fetched events stay until the next refresh cleans them up; requested ones are kept.')) { el.checked = true; return; }
  const ok = await run(() => api(`/metadata/promotions/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    kind === 'follow' ? (el.checked ? 'Following; fetching its schedule' : 'No longer following') : 'Saved; refreshing with the new setting');
  if (ok) render({ quiet: true });
});

$('#sidebar-toggle').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalRoot.innerHTML) closeModal();
  if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); $('#global-search').focus(); }
});
window.addEventListener('hashchange', () => { closeModal(); $('#global-search').value = ''; $('#search-results').hidden = true; render(); });
render();
