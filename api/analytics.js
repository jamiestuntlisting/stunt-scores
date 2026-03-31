const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

let cachedClient = null;

async function getDb() {
  if (!cachedClient || !cachedClient.topology?.isConnected()) {
    cachedClient = new MongoClient(MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db('stuntschool');
}

// Simple IP geolocation using free ip-api.com (server-side only, no key needed)
function geolocateIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return Promise.resolve({ country: 'Unknown', region: '', city: '' });
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get(`http://ip-api.com/json/${ip}?fields=country,regionName,city`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ country: parsed.country || 'Unknown', region: parsed.regionName || '', city: parsed.city || '' });
        } catch (e) { resolve({ country: 'Unknown', region: '', city: '' }); }
      });
    });
    req.on('error', () => resolve({ country: 'Unknown', region: '', city: '' }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ country: 'Unknown', region: '', city: '' }); });
  });
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

function detectBrowser(ua) {
  if (!ua) return 'Unknown';
  if (ua.includes('CriOS') || (ua.includes('Chrome') && !ua.includes('Edg'))) return 'Chrome';
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
  if (ua.includes('Firefox') || ua.includes('FxiOS')) return 'Firefox';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('Opera') || ua.includes('OPR')) return 'Opera';
  return 'Other';
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = await getDb();
    const { action } = req.body;

    // ---- REGISTER ----
    if (action === 'register') {
      const { userId, firstName, lastName, device } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      const users = db.collection('users');
      await users.createIndex({ userId: 1 }, { unique: true });

      const ip = getClientIP(req);
      const existing = await users.findOne({ userId });

      // Only geolocate if new user or no location stored
      let location = existing?.location;
      if (!location || !location.country || location.country === 'Unknown') {
        location = await geolocateIP(ip);
      }

      const deviceInfo = device ? {
        userAgent: (device.userAgent || '').slice(0, 300),
        mobile: !!device.mobile,
        browser: detectBrowser(device.userAgent),
        screenW: device.screenW || 0,
        screenH: device.screenH || 0,
      } : null;

      if (!existing) {
        await users.insertOne({
          userId,
          firstName: (firstName || '').slice(0, 50),
          lastName: (lastName || '').slice(0, 50),
          firstSeen: new Date(),
          lastSeen: new Date(),
          visits: 1,
          devices: deviceInfo ? [deviceInfo] : [],
          location,
          ip: ip.slice(0, 45),
        });
      } else {
        const update = {
          $set: { lastSeen: new Date(), location },
          $inc: { visits: 1 },
        };
        // Add device if UA is new
        if (deviceInfo) {
          const hasDevice = (existing.devices || []).some(d => d.userAgent === deviceInfo.userAgent);
          if (!hasDevice) {
            update.$push = { devices: deviceInfo };
          }
        }
        await users.updateOne({ userId }, update);
      }

      return res.json({ ok: true });
    }

    // ---- HEARTBEAT ----
    if (action === 'heartbeat') {
      const { userId, sessionId, startedAt, device, games, npcs } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

      const sessions = db.collection('sessions');
      await sessions.createIndex({ sessionId: 1 }, { unique: true });
      await sessions.createIndex({ userId: 1 });
      await sessions.createIndex({ startedAt: -1 });

      const now = new Date();
      const start = startedAt ? new Date(startedAt) : now;
      const durationSec = Math.round((now - start) / 1000);

      const ip = getClientIP(req);

      const deviceInfo = device ? {
        userAgent: (device.userAgent || '').slice(0, 300),
        mobile: !!device.mobile,
        browser: detectBrowser(device.userAgent),
        screenW: device.screenW || 0,
        screenH: device.screenH || 0,
      } : {};

      await sessions.updateOne(
        { sessionId },
        {
          $set: {
            userId: userId || 'anonymous',
            startedAt: start,
            endedAt: now,
            durationSec,
            device: deviceInfo,
            games: Array.isArray(games) ? games.slice(0, 50) : [],
            npcs: (npcs && typeof npcs === 'object') ? npcs : {},
            ip: ip.slice(0, 45),
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action. Use: register, heartbeat' });
  } catch (err) {
    console.error('Analytics error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
