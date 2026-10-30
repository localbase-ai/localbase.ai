/**
 * Google Analytics 4 auth — this connector's scope and token file over the
 * shared Google OAuth mechanics in ../google-oauth.js.
 *
 * Read-only. GA4 also offers a read/write scope; a reporting connector needs
 * neither edit nor delete.
 */
import { googleAuth } from '../google-oauth.js';

export const {
  SCOPES, TOKEN_PATH, loadClientCredentials, buildAuthorizeUrl, readTokens,
  writeTokens, exchangeCode, refreshTokens, isExpired, whoami,
} = googleAuth({
  name: 'google-analytics',
  scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
});

export { createPkcePair, createState } from '../google-oauth.js';
