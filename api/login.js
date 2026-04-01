const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

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
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const db = getPool();

    // Look up user in login table (has bcrypt passwords)
    const [loginRows] = await db.execute(
      'SELECT id, email, password, first, last FROM login WHERE LOWER(email) = LOWER(?) LIMIT 1',
      [email.trim()]
    );

    if (loginRows.length === 0) {
      return res.json({ success: false, message: 'Email not found' });
    }

    const loginUser = loginRows[0];

    // PHP bcrypt uses $2y$ prefix — replace with $2b$ for Node bcrypt compatibility
    const hash = loginUser.password.replace(/^\$2y\$/, '$2b$');
    const match = await bcrypt.compare(password, hash);

    if (!match) {
      return res.json({ success: false, message: 'Incorrect password' });
    }

    // Auth successful — get full user info from user table (same id)
    const [userRows] = await db.execute(
      'SELECT id, first_name, last_name, email FROM user WHERE id = ? LIMIT 1',
      [loginUser.id]
    );

    if (userRows.length > 0) {
      const user = userRows[0];
      return res.json({
        success: true,
        id: user.id,
        first_name: user.first_name || loginUser.first || '',
        last_name: user.last_name || loginUser.last || '',
      });
    }

    // Fallback: user exists in login but not user table — use login table data
    return res.json({
      success: true,
      id: loginUser.id,
      first_name: loginUser.first || '',
      last_name: loginUser.last || '',
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
