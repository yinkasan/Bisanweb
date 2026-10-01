import jwt from 'jsonwebtoken';
import { config, isProd } from '../config.js';
import { unauthorized, forbidden, asyncHandler } from './errors.js';
import { loadUserContext, hasPermission } from '../services/accessService.js';

export const AUTH_COOKIE = 'depot_token';

export function signToken(userId) {
  return jwt.sign({ uid: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 12, // matches JWT_EXPIRES_IN default
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE);
}

function extractToken(req) {
  if (req.cookies?.[AUTH_COOKIE]) return req.cookies[AUTH_COOKIE];
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * Verifies the JWT, reloads the user's full access context from the database
 * (so deactivation and permission changes take effect immediately) and
 * attaches it as req.user.
 */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw unauthorized('Please sign in');
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    clearAuthCookie(res);
    throw unauthorized('Your session has expired — please sign in again');
  }
  req.user = await loadUserContext(payload.uid);
  next();
});

/** Page-level gate: requires the given action on the given page (SRS 4.1). */
export function requirePermission(pageKey, action = 'view') {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!hasPermission(req.user, pageKey, action)) {
      return next(forbidden(`You do not have "${action}" permission on ${pageKey.replace(/_/g, ' ')}`));
    }
    return next();
  };
}

/** Gate for actions that only the Super Admin may do (user/role administration). */
export function requireSuperAdmin() {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!req.user.isSuperAdmin) return next(forbidden('Only the Super Admin can perform this action'));
    return next();
  };
}
