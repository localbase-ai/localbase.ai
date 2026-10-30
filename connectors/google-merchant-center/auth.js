/**
 * Google Merchant Center auth — this connector's scope and token file over the
 * shared Google OAuth mechanics in ../google-oauth.js.
 *
 * The Merchant API has a single scope, `content`, and it is read/write — there
 * is no read-only variant. This connector only ever reads (the one exception is
 * the opt-in developer registration in register.js, which the API requires).
 */
import { googleAuth } from '../google-oauth.js';

export const {
  SCOPES, TOKEN_PATH, loadClientCredentials, buildAuthorizeUrl, readTokens,
  writeTokens, exchangeCode, refreshTokens, isExpired, whoami,
} = googleAuth({
  name: 'google-merchant-center',
  scopes: ['https://www.googleapis.com/auth/content'],
});

export { createPkcePair, createState } from '../google-oauth.js';
