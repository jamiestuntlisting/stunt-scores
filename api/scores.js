const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const VALID_GAMES = ['stairfalls', 'fireburns', 'highfalls', 'stuntcoord'];

let cachedClient = null;

async function getDb() {
  if (!cachedClient || !cachedClient.topology?.isConnected()) {
    cachedClient = new MongoClient(MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db('stuntschool');
}

module.exports = async function handler(req, res) {
  // CORS — use specific origin to support credentialed requests
  const ALLOWED_ORIGINS = [
    'https://stunt-school-link.vercel.app',
    'https://www.virtualstuntschool.com',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ];
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db = await getDb();
    const scores = db.collection('scores');

    // Ensure index for fast lookups (only created once)
    await scores.createIndex({ game: 1, userId: 1 }, { unique: true });
    await scores.createIndex({ game: 1, score: -1 });

    // GET: Return top 10 scores for all games (deduplicated by userId)
    if (req.method === 'GET') {
      const result = {};
      for (const game of VALID_GAMES) {
        // Use aggregation to keep only the highest score per userId
        result[game] = await scores.aggregate([
          { $match: { game } },
          { $sort: { score: -1 } },
          { $group: {
            _id: '$userId',
            name: { $first: '$name' },
            score: { $first: '$score' },
            userId: { $first: '$userId' }
          }},
          { $sort: { score: -1 } },
          { $limit: 10 },
          { $project: { _id: 0, name: 1, score: 1, userId: 1 } }
        ]).toArray();
      }
      return res.json(result);
    }

    // POST: Submit or update a score (only saves if higher than existing)
    if (req.method === 'POST') {
      const { game, userId, firstName, lastName, score } = req.body;

      // Validate game
      if (!VALID_GAMES.includes(game)) {
        return res.status(400).json({ error: 'Invalid game. Must be one of: ' + VALID_GAMES.join(', ') });
      }

      // Validate userId
      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        return res.status(400).json({ error: 'userId is required' });
      }

      // Validate name
      if (!firstName || typeof firstName !== 'string' || firstName.trim().length === 0) {
        return res.status(400).json({ error: 'firstName is required' });
      }
      if (!lastName || typeof lastName !== 'string' || lastName.trim().length === 0) {
        return res.status(400).json({ error: 'lastName is required' });
      }

      // Validate score
      if (typeof score !== 'number' || score < 0 || score > 999999 || !Number.isFinite(score)) {
        return res.status(400).json({ error: 'Score must be a number between 0 and 999999' });
      }

      // Sanitize
      const cleanFirst = firstName.replace(/[<>&"']/g, '').trim().slice(0, 30);
      const cleanLast = lastName.replace(/[<>&"']/g, '').trim().slice(0, 30);
      const fullName = cleanFirst + ' ' + cleanLast;
      const roundedScore = Math.round(score);

      // Upsert: only update if new score is higher than existing
      // Uses the unique index on {game, userId}
      const existing = await scores.findOne({ game, userId: userId.trim() });

      if (!existing) {
        // No existing score — insert new
        await scores.insertOne({
          game,
          userId: userId.trim(),
          name: fullName,
          score: roundedScore,
          date: new Date()
        });
        return res.json({ ok: true, action: 'new', score: roundedScore });
      } else if (roundedScore > existing.score) {
        // New score is higher — update
        await scores.updateOne(
          { game, userId: userId.trim() },
          { $set: { name: fullName, score: roundedScore, date: new Date() } }
        );
        return res.json({ ok: true, action: 'updated', previousScore: existing.score, score: roundedScore });
      } else {
        // Existing score is higher or equal — keep it
        return res.json({ ok: true, action: 'kept', currentBest: existing.score, submitted: roundedScore });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
