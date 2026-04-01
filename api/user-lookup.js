const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: 'stuntlisting-production.c0ecmzrrogms.us-east-1.rds.amazonaws.com',
      port: 3306,
      user: 'stuntlistinggames',
      password: 'xihre0-cotmeg-depsyK',
      database: 'db',
      connectionLimit: 20,
      connectTimeout: 5000,
      waitForConnections: true,
    });
  }
  return pool;
}

module.exports = async function handler(req, res) {
  // CORS
  const ALLOWED_ORIGINS = ['https://stunt-school-link.vercel.app','https://www.virtualstuntschool.com','http://localhost:3000','http://localhost:5500','http://127.0.0.1:5500'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Strip non-numeric chars (Mailchimp adds periods/commas to IDs)
  const rawId = (req.query.id || '').replace(/[^0-9]/g, '');
  const id = rawId ? Number(rawId) : NaN;
  if (!rawId || isNaN(id)) {
    return res.status(400).json({ error: 'Valid numeric id is required' });
  }

  try {
    const db = getPool();
    const [rows] = await db.execute(
      'SELECT first_name, last_name FROM user WHERE id = ? LIMIT 1',
      [id]
    );

    if (rows.length === 0) {
      return res.json({ found: false, id });
    }

    return res.json({
      found: true,
      id,
      first_name: rows[0].first_name || '',
      last_name: rows[0].last_name || '',
    });
  } catch (err) {
    console.error('User lookup error:', err);
    return res.status(500).json({ error: 'Database error' });
  }
};
