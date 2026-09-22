import { events, releases, initialState, addRequest, advanceRequest, selectRelease, requestFor, counts } from './model.js';

const storageKey = 'replayarr-prototype-v1';
const view = document.querySelector('#view');
const toast = document.querySelector('#toast');
let page = 'overview';
let sport = 'All sports';
let query = '';
let selectedRequest = null;
let state = loadState();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && Array.isArray(saved.requests) && Array.isArray(saved.activity)) return saved;
  } catch {}
  return initialState();
}

function persist() {
  localStorage.setItem(storageKey, JSON.stringify(state));
  render();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

function heading(eyebrow, title, detail, action = '') {
  return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${detail}</p></div>${action}</div>`;
}

function statusPill(status) {
  const labels = { queued: 'Queued', searching: 'Searching', review: 'Needs review', downloading: 'Downloading', importing: 'Importing', ready: 'Ready to watch' };
  return `<span class="status status-${status}"><span class="status-dot"></span>${labels[status] || status}</span>`;
}

function eventCard(event, compact = false) {
  const request = requestFor(state, event.id);
  const action = request
    ? `<span class="card-state">${statusPill(request.status)}</span>`
    : `<button class="button button-light" data-action="request" data-event="${event.id}">Request replay <span>↗</span></button>`;
  return `<article class="event-card ${compact ? 'compact' : ''}">
    <div class="event-art art-${event.tone}"><span class="art-lines"></span><span class="art-kicker">${event.sport} <i>•</i> ${event.league}</span><strong>${event.team}</strong><span class="art-arrow">↗</span></div>
    <div class="event-info"><div class="event-date">${formatDate(event.date)} <span>·</span> ${event.time}</div><h3>${escapeHtml(event.title)}</h3><div class="event-foot"><span>${event.sport}</span>${action}</div></div>
  </article>`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z'));
}

function overview() {
  const count = counts(state);
  const recent = events.slice(0, 4);
  const needsReview = state.requests.filter((item) => item.status === 'review');
  return `
    ${heading('GOOD TO HAVE YOU BACK', 'Your sports, <em>on replay.</em>', 'Track events, find the right release, and build the library you actually want.', '<a class="button button-primary" href="#discover">Explore events <span>↗</span></a>')}
    <section class="hero">
      <div class="hero-copy"><span class="hero-tag"><span class="live-dot"></span> REPLAYARR PROTOTYPE</span><h2>Never miss the<br><i>moment again.</i></h2><p>From the final whistle to your library. One clear place to request, review and follow every replay.</p><a class="hero-link" href="#discover">Browse recent events <span>→</span></a></div>
      <div class="hero-visual" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="play-glow">▶</div><div class="hero-visual-label">EVERY GAME.<br>ON YOUR TIME.</div></div>
    </section>
    <section class="stats" aria-label="Request statistics">
      <div class="stat"><span>WANTED EVENTS</span><strong>${count.wanted}</strong><small>Across your watchlist</small></div>
      <div class="stat"><span>NEEDS REVIEW</span><strong class="amber-text">${count.review}</strong><small>Choose a matching release</small></div>
      <div class="stat"><span>IN PROGRESS</span><strong>${count.active}</strong><small>Searching or importing</small></div>
      <div class="stat"><span>IN LIBRARY</span><strong class="mint-text">${count.ready}</strong><small>Ready to watch</small></div>
    </section>
    <section class="section-block"><div class="section-title"><div><span class="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Action needed</h2></div><a href="#requests">View all requests <span>→</span></a></div>
      ${needsReview.length ? needsReview.map((item) => requestRow(item)).join('') : '<div class="empty">Nothing needs review right now. New matches will appear here.</div>'}
    </section>
    <section class="section-block"><div class="section-title"><div><span class="eyebrow">THE LATEST</span><h2>Recent events</h2></div><a href="#discover">Explore all events <span>→</span></a></div><div class="event-grid">${recent.map((item) => eventCard(item, true)).join('')}</div></section>`;
}

function discover() {
  const sports = ['All sports', ...new Set(events.map((event) => event.sport))];
  const matches = events.filter((event) => (sport === 'All sports' || event.sport === sport) && (!query || (event.title + ' ' + event.sport).toLowerCase().includes(query.toLowerCase())));
  return `
    ${heading('FIND YOUR NEXT REPLAY', 'Discover events', 'Search the sports calendar and add events to your request queue.')}
    <div class="toolbar"><label class="search-field"><span>⌕</span><input id="event-search" type="search" placeholder="Search teams, events or promotions" value="${escapeHtml(query)}" autocomplete="off"></label><span class="toolbar-count">${matches.length} EVENTS</span></div>
    <div class="filters" aria-label="Filter sports">${sports.map((name) => `<button type="button" class="filter ${name === sport ? 'active' : ''}" data-action="filter" data-sport="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('')}</div>
    ${matches.length ? `<div class="event-grid discover-grid">${matches.map((item) => eventCard(item)).join('')}</div>` : '<div class="empty">No demo events match this search.</div>'}
    <div class="note"><strong>Prototype boundary</strong><span>These are illustrative event and release records. Connecting to SSS metadata and live indexers is planned for a later stage.</span></div>`;
}

function requestRow(request) {
  const event = events.find((item) => item.id === request.eventId);
  if (!event) return '';
  const release = releases[event.id]?.find((item) => item.id === request.releaseId);
  const action = request.status === 'review'
    ? `<button class="button button-primary" data-action="open-review" data-request="${request.id}">Review matches <span>→</span></button>`
    : ['queued', 'searching', 'downloading', 'importing'].includes(request.status)
      ? `<button class="button button-ghost" data-action="advance" data-request="${request.id}">Simulate next step <span>→</span></button>`
      : '<span class="ready-label">✓ Available in library</span>';
  return `<article class="request-row"><div class="request-symbol art-${event.tone}">${event.team}</div><div class="request-name"><span>${event.sport} / ${event.league}</span><h3>${escapeHtml(event.title)}</h3><small>${formatDate(event.date)}${release ? ' · ' + escapeHtml(release.quality) : ''}</small></div><div class="request-status">${statusPill(request.status)}</div><div class="request-action">${action}</div></article>`;
}

function requestsPage() {
  const order = ['review', 'downloading', 'importing', 'searching', 'queued', 'ready'];
  const sorted = [...state.requests].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return `${heading('YOUR WATCHLIST', 'Requests', 'Follow each replay from request to finished library item.', '<a class="button button-primary" href="#discover">Add an event <span>＋</span></a>')}
    <div class="workflow"><span>01 <strong>Request</strong></span><b>→</b><span>02 <strong>Find a match</strong></span><b>→</b><span>03 <strong>Download</strong></span><b>→</b><span>04 <strong>Import</strong></span></div>
    <div class="section-title"><div><span class="eyebrow">${sorted.length} TOTAL</span><h2>All requests</h2></div></div>
    <div class="request-list">${sorted.length ? sorted.map(requestRow).join('') : '<div class="empty">Your request list is empty. Discover an event to get started.</div>'}</div>
    <div class="note"><strong>Try the workflow</strong><span>Use “Simulate next step” to move demo requests forward. A real build would use indexer results and download-client callbacks.</span></div>`;
}

function activityPage() {
  return `${heading('WHAT HAPPENED', 'Activity', 'A readable history of discovery, decisions, downloads and imports.')}
    <div class="activity-panel"><div class="panel-top"><h2>Timeline</h2><span>NEWEST FIRST</span></div>
    ${state.activity.map((item) => `<div class="activity-row"><div class="activity-icon activity-${escapeHtml(item.kind)}">↗</div><div><strong>${escapeHtml(item.text)}</strong><small>Demo activity · ${escapeHtml(item.time)}</small></div></div>`).join('')}</div>`;
}

function settingsPage() {
  return `${heading('PROTOTYPE CONFIGURATION', 'Settings', 'A preview of the connections Replayarr will need. Nothing here connects to a service yet.')}
    <div class="settings-grid">
      <div class="setting-card"><div class="setting-icon">◈</div><span class="eyebrow">SOURCE OF TRUTH</span><h2>Sports metadata</h2><p>Event schedules, promotions, team aliases and artwork. SSS can provide the starting event contract.</p><span class="planned">PLANNED INTEGRATION</span></div>
      <div class="setting-card"><div class="setting-icon">⌕</div><span class="eyebrow">DISCOVERY</span><h2>Indexers</h2><p>Measured Prowlarr and Bitmagnet searches, candidate scoring, duplicate suppression and a review queue.</p><span class="planned">PLANNED INTEGRATION</span></div>
      <div class="setting-card"><div class="setting-icon">↓</div><span class="eyebrow">ACQUISITION</span><h2>Download clients</h2><p>Send selected releases to a torrent or Usenet client and track progress through completion.</p><span class="planned">PLANNED INTEGRATION</span></div>
      <div class="setting-card"><div class="setting-icon">▣</div><span class="eyebrow">FINAL DESTINATION</span><h2>Media library</h2><p>Verify files, import safely, name consistently and report what is ready for Plex or Jellyfin.</p><span class="planned">PLANNED INTEGRATION</span></div>
    </div><div class="note"><strong>Design rule</strong><span>Replayarr owns request and download state. SSS stays focused on calendars and streaming; the two should not share a writable database.</span></div>`;
}

function reviewPanel() {
  if (!selectedRequest) return '';
  const request = state.requests.find((item) => item.id === selectedRequest);
  if (!request || request.status !== 'review') return '';
  const event = events.find((item) => item.id === request.eventId);
  const candidates = releases[event.id] || [];
  return `<div class="drawer-backdrop" data-action="close-review"><aside class="drawer" role="dialog" aria-modal="true" aria-label="Review release matches">
    <div class="drawer-head"><span class="eyebrow">MANUAL MATCH REVIEW</span><button class="icon-button" data-action="close-review" aria-label="Close">×</button></div>
    <h2>${escapeHtml(event.title)}</h2><p>Choose a candidate to start a demo download. Scores are illustrative.</p>
    <div class="drawer-event"><span>${event.sport}</span><strong>${formatDate(event.date)}</strong><small>${event.league}</small></div>
    <div class="candidate-title">CANDIDATE RELEASES <span>${candidates.length}</span></div>
    ${candidates.length ? candidates.map((candidate) => `<article class="candidate"><div class="candidate-top"><span>${escapeHtml(candidate.source)}</span><strong>${candidate.score}% MATCH</strong></div><h3>${escapeHtml(candidate.title)}</h3><div class="candidate-bottom"><span>${candidate.quality} · ${candidate.size}</span><button class="button button-primary" data-action="select-release" data-request="${request.id}" data-release="${candidate.id}">Select release <span>↗</span></button></div></article>`).join('') : '<div class="empty">No candidates yet. A real search would retry within the indexer budget.</div>'}
    <div class="drawer-note">In the real workflow, Replayarr will keep the event, release identity and decision evidence together for auditing.</div>
  </aside></div>`;
}

function render() {
  page = ['overview', 'discover', 'requests', 'activity', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  document.querySelector('#breadcrumb-page').textContent = page.toUpperCase();
  document.querySelector('#nav-count').textContent = state.requests.length;
  document.querySelectorAll('[data-page]').forEach((link) => {
    link.classList.toggle('active', link.dataset.page === page);
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  view.innerHTML = ({ overview, discover, requests: requestsPage, activity: activityPage, settings: settingsPage })[page]() + reviewPanel();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, event: eventId, request: requestId, release: releaseId } = button.dataset;
  if (action === 'filter') { sport = button.dataset.sport; render(); }
  if (action === 'request') {
    state = addRequest(state, eventId);
    persist();
    showToast('Event added to your requests');
  }
  if (action === 'advance') {
    state = advanceRequest(state, requestId);
    persist();
    showToast('Demo request advanced');
  }
  if (action === 'open-review') { selectedRequest = requestId; render(); }
  if (action === 'close-review' && (button === event.target || button.tagName === 'BUTTON')) { selectedRequest = null; render(); }
  if (action === 'select-release') {
    state = selectRelease(state, requestId, releaseId);
    selectedRequest = null;
    persist();
    showToast('Release selected for demo download');
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id !== 'event-search') return;
  query = event.target.value;
  const position = event.target.selectionStart;
  render();
  const input = document.querySelector('#event-search');
  input.focus();
  input.setSelectionRange(position, position);
});

document.querySelector('#reset-demo').addEventListener('click', () => {
  state = initialState();
  selectedRequest = null;
  query = '';
  sport = 'All sports';
  persist();
  showToast('Demo data reset');
});
window.addEventListener('hashchange', () => { selectedRequest = null; render(); });
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selectedRequest) { selectedRequest = null; render(); }
});
render();
