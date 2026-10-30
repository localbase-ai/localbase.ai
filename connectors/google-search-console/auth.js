/**
 * Search Console auth — this connector's scope and token file over the shared
 * Google OAuth mechanics in ../google-oauth.js.
 *
 * Read-only. Tokens are per-connector, so this one can only read Search Console
 * even though the same OAuth client also serves Analytics.
 */
import { googleAuth } from '../google-oauth.js';

export const {
  SCOPES, TOKEN_PATH, loadClientCredentials, buildAuthorizeUrl, readTokens,
  writeTokens, exchangeCode, refreshTokens, isExpired, whoami,
} = googleAuth({
  name: 'google-search-console',
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

export { createPkcePair, createState } from '../google-oauth.js';
