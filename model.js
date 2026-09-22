export const events = [
  { id: 'mlb-0921', sport: 'MLB', league: 'Regular season', title: 'New York Mets vs New York Yankees', date: '2026-09-21', time: '19:10', team: 'NY', tone: 'baseball' },
  { id: 'nfl-0920', sport: 'NFL', league: 'Week 3', title: 'Kansas City Chiefs vs Buffalo Bills', date: '2026-09-20', time: '21:25', team: 'KC', tone: 'football' },
  { id: 'epl-0921', sport: 'EPL', league: 'Matchweek 5', title: 'Arsenal vs Manchester City', date: '2026-09-21', time: '20:00', team: 'ARS', tone: 'soccer' },
  { id: 'wwe-0921', sport: 'WWE', league: 'Weekly show', title: 'WWE Raw', date: '2026-09-21', time: '01:00', team: 'RAW', tone: 'wrestling' },
  { id: 'ucl-0922', sport: 'UCL', league: 'League phase', title: 'Liverpool vs Napoli', date: '2026-09-22', time: '20:00', team: 'LIV', tone: 'soccer' },
  { id: 'nba-0619', sport: 'NBA', league: 'Finals', title: 'Boston Celtics vs Oklahoma City Thunder', date: '2026-06-19', time: '01:30', team: 'BOS', tone: 'basketball' },
];

export const releases = {
  'mlb-0921': [
    { id: 'mlb-a', title: 'MLB.2026.09.21.Mets.vs.Yankees.1080p.WEB-DL', source: 'Prowlarr · 720pier', quality: '1080p', size: '7.2 GB', score: 96 },
    { id: 'mlb-b', title: 'Baseball.NYM.NYY.2026.09.21.720p.HDTV', source: 'Bitmagnet', quality: '720p', size: '3.8 GB', score: 88 },
  ],
  'nfl-0920': [
    { id: 'nfl-a', title: 'NFL.2026.Week03.Chiefs.vs.Bills.1080p.WEB', source: 'Prowlarr · RuTracker', quality: '1080p', size: '8.4 GB', score: 95 },
  ],
  'epl-0921': [
    { id: 'epl-a', title: 'Premier.League.Arsenal.v.Man.City.2026.09.21.1080p', source: 'Bitmagnet', quality: '1080p', size: '5.9 GB', score: 93 },
  ],
  'wwe-0921': [
    { id: 'wwe-a', title: 'WWE.Raw.2026.09.21.1080p.WEB.h264', source: 'Prowlarr · 720pier', quality: '1080p', size: '4.1 GB', score: 97 },
  ],
  'ucl-0922': [],
  'nba-0619': [],
};

export const steps = ['queued', 'searching', 'review', 'downloading', 'importing', 'ready'];
const next = { queued: 'searching', searching: 'review', downloading: 'importing', importing: 'ready' };

export function initialState() {
  return {
    requests: [
      { id: 'req-1', eventId: 'nfl-0920', status: 'ready', releaseId: 'nfl-a', createdAt: '2026-09-21T11:30:00Z' },
      { id: 'req-2', eventId: 'mlb-0921', status: 'review', releaseId: null, createdAt: '2026-09-22T08:45:00Z' },
      { id: 'req-3', eventId: 'epl-0921', status: 'downloading', releaseId: 'epl-a', createdAt: '2026-09-22T09:10:00Z' },
    ],
    activity: [
      { id: 'act-1', text: 'Arsenal vs Manchester City sent to download client', time: '09:14', kind: 'download' },
      { id: 'act-2', text: 'Two candidate releases found for Mets vs Yankees', time: '08:47', kind: 'match' },
      { id: 'act-3', text: 'Chiefs vs Bills imported to library', time: 'Yesterday', kind: 'ready' },
    ],
  };
}

export function requestFor(state, eventId) {
  return state.requests.find((item) => item.eventId === eventId);
}

export function addRequest(state, eventId) {
  if (!events.some((event) => event.id === eventId) || requestFor(state, eventId)) return state;
  const event = events.find((item) => item.id === eventId);
  return {
    requests: [{ id: `req-${Date.now()}`, eventId, status: 'queued', releaseId: null, createdAt: new Date().toISOString() }, ...state.requests],
    activity: [{ id: `act-${Date.now()}`, text: `${event.title} added to requests`, time: 'Just now', kind: 'request' }, ...state.activity],
  };
}

export function selectRelease(state, requestId, releaseId) {
  const request = state.requests.find((item) => item.id === requestId);
  if (!request || request.status !== 'review' || !releases[request.eventId]?.some((item) => item.id === releaseId)) return state;
  const event = events.find((item) => item.id === request.eventId);
  return {
    requests: state.requests.map((item) => item.id === requestId ? { ...item, status: 'downloading', releaseId } : item),
    activity: [{ id: `act-${Date.now()}`, text: `${event.title} sent to download client`, time: 'Just now', kind: 'download' }, ...state.activity],
  };
}

export function advanceRequest(state, requestId) {
  const request = state.requests.find((item) => item.id === requestId);
  if (!request || !next[request.status]) return state;
  const event = events.find((item) => item.id === request.eventId);
  const status = next[request.status];
  return {
    requests: state.requests.map((item) => item.id === requestId ? { ...item, status } : item),
    activity: [{ id: `act-${Date.now()}`, text: `${event.title}: ${status}`, time: 'Just now', kind: status }, ...state.activity],
  };
}

export function counts(state) {
  return {
    wanted: state.requests.length,
    review: state.requests.filter((item) => item.status === 'review').length,
    active: state.requests.filter((item) => ['queued', 'searching', 'downloading', 'importing'].includes(item.status)).length,
    ready: state.requests.filter((item) => item.status === 'ready').length,
  };
}
