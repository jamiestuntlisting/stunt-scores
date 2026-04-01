const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'stuntadmin2024';

let cachedClient = null;

async function getDb() {
  if (!cachedClient || !cachedClient.topology?.isConnected()) {
    cachedClient = new MongoClient(MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db('stuntschool');
}

module.exports = async function handler(req, res) {
  const ALLOWED_ORIGINS = ['https://stunt-school-link.vercel.app','https://www.virtualstuntschool.com','http://localhost:3000','http://localhost:5500','http://127.0.0.1:5500'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Password check
  const pw = req.query.password || req.headers['x-dashboard-password'];
  if (pw !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = await getDb();
    const users = db.collection('users');
    const sessions = db.collection('sessions');
    const scores = db.collection('scores');

    // Always exclude known test/spam accounts
    const alwaysExclude = ['6500', '144516', '498001', '<< Test STL Id >>'];
    // Optional additional excludes (comma-separated user IDs)
    const extraExclude = (req.query.exclude || '').split(',').map(s => s.trim()).filter(Boolean);
    const excludeIds = [...new Set([...alwaysExclude, ...extraExclude])];
    const sessionFilter = excludeIds.length > 0 ? { userId: { $nin: excludeIds } } : {};
    const userFilter = excludeIds.length > 0 ? { userId: { $nin: excludeIds } } : {};

    // ---- USERS ----
    // Always hide permanently excluded accounts; dev toggle (id 33) still shows in users list
    const alwaysExcludeFilter = alwaysExclude.length > 0 ? { userId: { $nin: alwaysExclude } } : {};
    const allUsers = await users.find(alwaysExcludeFilter).sort({ lastSeen: -1 }).limit(500).toArray();
    const totalUsers = await users.countDocuments(userFilter);

    // Users by day (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const usersByDay = await users.aggregate([
      { $match: { ...userFilter, firstSeen: { $gte: thirtyDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$firstSeen' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    // ---- SESSIONS ----
    const totalSessions = await sessions.countDocuments(sessionFilter);
    const recentSessions = await sessions.find(sessionFilter).sort({ endedAt: -1 }).limit(100).project({ _id: 0 }).toArray();

    // Sessions by day (last 30 days)
    const sessionsByDay = await sessions.aggregate([
      { $match: { ...sessionFilter, startedAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } }, count: { $sum: 1 }, avgDuration: { $avg: '$durationSec' } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    // Average session duration
    const avgDurationResult = await sessions.aggregate([
      { $match: sessionFilter },
      { $group: { _id: null, avg: { $avg: '$durationSec' } } }
    ]).toArray();
    const avgSessionDuration = avgDurationResult[0]?.avg || 0;

    // ---- GAME STATS ----
    const gameStats = await sessions.aggregate([
      { $match: sessionFilter },
      { $unwind: '$games' },
      { $group: {
        _id: '$games.game',
        totalPlays: { $sum: 1 },
        avgDuration: { $avg: '$games.durationSec' },
        avgScore: { $avg: '$games.score' },
        avgLevel: { $avg: '$games.highestLevel' },
        maxScore: { $max: '$games.score' },
        maxLevel: { $max: '$games.highestLevel' },
        uniquePlayers: { $addToSet: '$userId' },
      }},
      { $project: {
        _id: 1, totalPlays: 1, avgDuration: 1, avgScore: 1, avgLevel: 1,
        maxScore: 1, maxLevel: 1, uniquePlayerCount: { $size: '$uniquePlayers' }
      }},
      { $sort: { totalPlays: -1 } }
    ]).toArray();

    // ---- DEVICE BREAKDOWN ----
    const deviceBreakdown = await sessions.aggregate([
      { $match: sessionFilter },
      { $group: {
        _id: { mobile: '$device.mobile' },
        count: { $sum: 1 }
      }}
    ]).toArray();

    const browserBreakdown = await sessions.aggregate([
      { $match: sessionFilter },
      { $group: { _id: '$device.browser', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    // ---- LOCATION BREAKDOWN (by state/region) ----
    const locationBreakdown = await users.aggregate([
      { $match: { ...userFilter, 'location.country': { $exists: true, $ne: 'Unknown' } } },
      { $group: { _id: { country: '$location.country', region: '$location.region' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 }
    ]).toArray();

    // ---- NPC INTERACTIONS ----
    const npcStats = await sessions.aggregate([
      { $match: sessionFilter },
      { $project: { npcEntries: { $objectToArray: '$npcs' } } },
      { $unwind: '$npcEntries' },
      { $group: { _id: '$npcEntries.k', totalInteractions: { $sum: '$npcEntries.v' }, uniqueSessions: { $sum: 1 } } },
      { $sort: { totalInteractions: -1 } }
    ]).toArray();

    // ---- SCORES (from existing scores collection) ----
    const VALID_GAMES = ['stairfalls', 'fireburns', 'highfalls', 'stuntcoord'];
    const scoreFilter = excludeIds.length > 0 ? { userId: { $nin: excludeIds } } : {};
    const topScores = {};
    for (const game of VALID_GAMES) {
      topScores[game] = await scores.find({ game, ...scoreFilter }).sort({ score: -1 }).limit(10).project({ _id: 0 }).toArray();
    }

    // ---- PER-USER STATS (games + NPC interactions) ----
    const userStats = await sessions.aggregate([
      { $match: sessionFilter },
      { $group: {
        _id: '$userId',
        totalPlayTime: { $sum: '$durationSec' },
        allGames: { $push: '$games' },
        allNpcs: { $push: '$npcs' },
      }},
    ]).toArray();

    // Flatten and compute per-user game + NPC breakdown
    const userStatsMap = userStats.map(u => {
      const allGames = (u.allGames || []).flat().filter(Boolean).map(g => g.game).filter(Boolean);
      const gameBreakdown = {};
      for (const g of allGames) {
        gameBreakdown[g] = (gameBreakdown[g] || 0) + 1;
      }
      const npcBreakdown = {};
      for (const npcObj of (u.allNpcs || [])) {
        if (!npcObj) continue;
        for (const [name, count] of Object.entries(npcObj)) {
          npcBreakdown[name] = (npcBreakdown[name] || 0) + count;
        }
      }
      return {
        userId: u._id,
        totalPlayTime: u.totalPlayTime || 0,
        gamesPlayed: allGames.length,
        gameBreakdown,
        npcBreakdown,
      };
    });

    // ---- SESSION-ONLY USERS (have sessions but no user record) ----
    const registeredIds = new Set(allUsers.map(u => u.userId));
    const sessionUserIds = await sessions.distinct('userId', sessionFilter);
    const sessionOnlyUsers = sessionUserIds
      .filter(id => id && id !== 'anonymous' && !registeredIds.has(id) && !alwaysExclude.includes(id))
      .map(id => ({
        userId: id,
        firstName: '',
        lastName: '',
        firstSeen: null,
        lastSeen: null,
        visits: 0,
        location: null,
        devices: [],
      }));

    // ---- ACTIVE TODAY ----
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const activeToday = await sessions.countDocuments({ ...sessionFilter, endedAt: { $gte: todayStart } });

    return res.json({
      overview: {
        totalUsers,
        totalSessions,
        activeToday,
        avgSessionDuration: Math.round(avgSessionDuration),
      },
      usersByDay,
      sessionsByDay,
      users: [...allUsers.map(u => ({
        userId: u.userId,
        firstName: u.firstName,
        lastName: u.lastName,
        firstSeen: u.firstSeen,
        lastSeen: u.lastSeen,
        visits: u.visits,
        location: u.location,
        devices: (u.devices || []).map(d => ({ mobile: d.mobile, browser: d.browser, screenW: d.screenW, screenH: d.screenH })),
      })), ...sessionOnlyUsers],
      gameStats,
      deviceBreakdown: {
        mobile: deviceBreakdown.find(d => d._id?.mobile === true)?.count || 0,
        desktop: deviceBreakdown.find(d => d._id?.mobile === false)?.count || 0,
      },
      browserBreakdown: browserBreakdown.map(b => ({ browser: b._id || 'Unknown', count: b.count })),
      locationBreakdown: locationBreakdown.map(l => ({ country: l._id.country, region: l._id.region, count: l.count })),
      npcStats: npcStats.map(n => ({ npc: n._id, totalInteractions: n.totalInteractions, uniqueSessions: n.uniqueSessions })),
      userStats: userStatsMap,
      topScores,
      recentSessions: recentSessions.slice(0, 50).map(s => ({
        sessionId: s.sessionId,
        userId: s.userId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSec: s.durationSec,
        device: s.device,
        games: s.games,
        npcs: s.npcs,
      })),
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
