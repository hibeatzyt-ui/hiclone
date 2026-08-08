// account.js
// Hi Clone has no backend (it runs as static files on GitHub Pages), so
// "accounts" are just a name + avatar saved in this browser's localStorage,
// plus a local high-score table keyed by song folder name.

const Account = (() => {
  const PROFILE_KEY = 'hiclone_profile';
  const SCORES_KEY = 'hiclone_scores';
  const SETTINGS_KEY = 'hiclone_settings';

  const AVATARS = ['🎧', '🎹', '🎤', '🥁', '⚡', '🌈', '👾', '🔥'];

  function getProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { name: 'Player', avatar: '🎧' };
  }

  function saveProfile(profile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  }

  function getSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { speed: 1.0, audioOffsetMs: 0 };
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function getAllScores() {
    try {
      const raw = localStorage.getItem(SCORES_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
  }

  // songKey = folder name, e.g. "7rings_DIAMOND"
  function getBestScore(songKey) {
    const all = getAllScores();
    return all[songKey] || null;
  }

  function submitScore(songKey, result) {
    const all = getAllScores();
    const prev = all[songKey];
    if (!prev || result.score > prev.score) {
      all[songKey] = {
        score: result.score,
        accuracy: result.accuracy,
        grade: result.grade,
        maxCombo: result.maxCombo,
        date: new Date().toISOString()
      };
      localStorage.setItem(SCORES_KEY, JSON.stringify(all));
      return true; // new best
    }
    localStorage.setItem(SCORES_KEY, JSON.stringify(all)); // keep as-is but ensure write
    return false;
  }

  return {
    AVATARS,
    getProfile, saveProfile,
    getSettings, saveSettings,
    getAllScores, getBestScore, submitScore
  };
})();
