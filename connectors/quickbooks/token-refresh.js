#!/usr/bin/env node

import fs from 'fs';

// Load environment variables manually
const envContent = fs.readFileSync('./env.local', 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  if (line.includes('=') && !line.startsWith('#')) {
    const [key, ...valueParts] = line.split('=');
    envVars[key] = valueParts.join('=');
  }
});

async function refreshQuickBooksToken() {
  console.log('🔄 Refreshing QuickBooks OAuth token...');

  const refreshToken = envVars.QUICKBOOKS_REFRESH_TOKEN;
  const clientId = envVars.QUICKBOOKS_CLIENT_ID;
  const clientSecret = envVars.QUICKBOOKS_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    console.error('❌ Missing required OAuth credentials in env.local');
    console.error('   Required: QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REFRESH_TOKEN');
    return;
  }

  const tokenEndpoint = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authHeader}`,
        'Accept': 'application/json'
      },
      body: params
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Token refresh failed:', response.status, errorText);
      return;
    }

    const tokenData = await response.json();
    console.log('✅ Token refresh successful!');

    // Calculate new expiration time
    const expiresIn = tokenData.expires_in; // seconds
    const expiresAt = new Date(Date.now() + (expiresIn * 1000));

    // Read current env.local file
    let envContent = fs.readFileSync('./env.local', 'utf8');

    // Update tokens
    envContent = envContent.replace(
      /QUICKBOOKS_ACCESS_TOKEN=.*/,
      `QUICKBOOKS_ACCESS_TOKEN=${tokenData.access_token}`
    );

    if (tokenData.refresh_token) {
      envContent = envContent.replace(
        /QUICKBOOKS_REFRESH_TOKEN=.*/,
        `QUICKBOOKS_REFRESH_TOKEN=${tokenData.refresh_token}`
      );
    }

    envContent = envContent.replace(
      /QUICKBOOKS_TOKEN_EXPIRES_AT=.*/,
      `QUICKBOOKS_TOKEN_EXPIRES_AT=${expiresAt.toISOString()}`
    );

    // Write updated env.local file
    fs.writeFileSync('./env.local', envContent);

    console.log(`💾 Updated env.local with new tokens`);
    console.log(`⏰ New token expires at: ${expiresAt.toISOString()}`);
    console.log(`🚀 Ready to run QuickBooks sync!`);

  } catch (error) {
    console.error('❌ Error refreshing token:', error.message);
  }
}

refreshQuickBooksToken().catch(console.error);
