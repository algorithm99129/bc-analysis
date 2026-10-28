// Crash maths shared by the real BC.Game history and the sandbox game.
'use strict';

const crypto = require('crypto');

// Crash point for a round: HMAC-SHA256(key = salt, msg = hash bytes),
// first 52 bits -> 99 / (1 - X), floored to 2 decimals, minimum 1.00.
function crashPoint(hash, salt) {
  const hmac = crypto.createHmac('sha256', salt).update(Buffer.from(hash, 'hex')).digest('hex');
  const r = parseInt(hmac.slice(0, 13), 16);
  const x = 99 / (1 - r / 2 ** 52);
  return Math.max(1, Math.floor(x) / 100);
}

// The previous round's hash is sha256 of the current hash's hex string.
const prevHash = (hash) => crypto.createHash('sha256').update(hash).digest('hex');

// A round's multiplier grows as e^(GROWTH · ms) while it is flying.
const GROWTH = 0.00006;

module.exports = { crashPoint, prevHash, GROWTH };
