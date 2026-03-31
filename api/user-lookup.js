const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: 'stuntlisting-production.c0ecmzrrogms.us-east-1.rds.amazonaws.com',
      port: 3306,
      user: 'stuntlistinggames',
      password: 'xihre0-cotmeg-depsyK',
      database: 'stuntlisting',
      connectionLimit: 5,
      connectTimeout: 5000,
      waitForConnections: true,
    });
  }
  return pool;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const id = req.query.id;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: 'Valid numeric id is required' });
  }

  try {
    const db = getPool();
    const [rows] = await db.execute(
      'SELECT first_name, last_name FROM users WHERE id = ? LIMIT 1',
      [Number(id)]
    );

    if (rows.length === 0) {
      return res.json({ found: false, id: Number(id) });
    }

    return res.json({
      found: true,
      id: Number(id),
      first_name: rows[0].first_name || '',
      last_name: rows[0].last_name || '',
    });
  } catch (err) {
    console.error('User lookup error:', err);
    return res.status(500).json({ error: 'Database error' });
  }
};
