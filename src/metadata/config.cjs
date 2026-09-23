'use strict';

// The slice of SSS's config.js that the ported sources and transform read.
// Replayarr fills it from its own settings before each refresh (configure).
const config = {
  publicUrl: '',
  addonType: 'movie',
  tsdb: {
    // TheSportsDB's documented free v1 key.
    apiKey: '123',
    leagueId: '4443',
    requestDelayMs: Number(process.env.REPLAYARR_TSDB_DELAY_MS) >= 0 && process.env.REPLAYARR_TSDB_DELAY_MS !== undefined
      ? Number(process.env.REPLAYARR_TSDB_DELAY_MS) : 3000,
    seasons: null,
    maxRoundsPerSeason: 250,
    emptyRoundStopAfter: 5,
  },
  footballData: { apiKey: '' },
  apiFootball: { apiKey: '' },
  tmdb: { apiKey: '' },
  eventWindowDaysBack: 30,
  eventWindowDaysAhead: 90,
};

function configure({ tsdbApiKey, footballDataApiKey, apiFootballApiKey, tmdbApiKey, daysBack, daysAhead } = {}) {
  if (tsdbApiKey !== undefined) config.tsdb.apiKey = String(tsdbApiKey || '123');
  if (footballDataApiKey !== undefined) config.footballData.apiKey = String(footballDataApiKey || '');
  if (apiFootballApiKey !== undefined) config.apiFootball.apiKey = String(apiFootballApiKey || '');
  if (tmdbApiKey !== undefined) config.tmdb.apiKey = String(tmdbApiKey || '');
  if (Number(daysBack) >= 0) config.eventWindowDaysBack = Number(daysBack);
  if (Number(daysAhead) >= 0) config.eventWindowDaysAhead = Number(daysAhead);
}

module.exports = config;
module.exports.configure = configure;
