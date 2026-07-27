'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'llm_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function sameValue(actual, expected) {
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}

function parseCookies(header) {
  const cookies = {};
  for (const pair of String(header || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return cookies;
}

function createAuth(credentials) {
  const sessions = new Map();

  function authenticate(username, password) {
    if (!sameValue(username, credentials.username) || !sameValue(password, credentials.password)) {
      return null;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  function isAuthenticated(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    const expiresAt = token && sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function clear(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (token) sessions.delete(token);
  }

  return { authenticate, isAuthenticated, clear };
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function expiredSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

module.exports = { createAuth, expiredSessionCookie, sessionCookie };
