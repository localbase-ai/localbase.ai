/**
 * Google Ads auth — this connector's scope and token file over the shared
 * Google OAuth mechanics in ../google-oauth.js.
 *
 * `adwords` is the only scope Google Ads offers, and it is read/write: the
 * grant cannot be narrowed to reporting. This connector only ever calls
 * `googleAds:searchStream` and `customers:listAccessibleCustomers`, both reads,
 * and keeps its token separate from every other Google connector's.
 */
import { googleAuth } from '../google-oauth.js';

export const {
  SCOPES, TOKEN_PATH, loadClientCredentials, buildAuthorizeUrl, readTokens,
  writeTokens, exchangeCode, refreshTokens, isExpired, whoami,
} = googleAuth({
  name: 'google-ads',
  scopes: ['https://www.googleapis.com/auth/adwords'],
});

export { createPkcePair, createState } from '../google-oauth.js';
