import { BaseConnector } from '../APIClient.js';

/**
 * HubSpot API Client
 * Handles authentication and API calls to HubSpot CRM & Marketing APIs
 */
export class HubSpotClient extends BaseConnector {
  constructor(options = {}) {
    super({
      name: 'HubSpot',
      baseURL: options.baseUrl || 'https://api.hubapi.com',
      authType: 'bearer',
      credentials: {
        token: options.accessToken,
        accessToken: options.accessToken
      }
    });

    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;

    if (!this.accessToken && !this.refreshToken) {
      throw new Error('Either accessToken or refreshToken is required for HubSpot API');
    }
  }

  /**
   * Handle unauthorized (401) responses - refresh OAuth token
   * Override BaseConnector's handleUnauthorized
   */
  async handleUnauthorized() {
    if (!this.refreshToken) {
      return false;
    }

    try {
      await this.refreshAccessToken();
      // Update credentials after refresh
      this.credentials.token = this.accessToken;
      this.credentials.accessToken = this.accessToken;
      return true;
    } catch (error) {
      console.error('❌ Failed to refresh HubSpot token:', error.message);
      return false;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken() {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new Error('Refresh token, client ID, and client secret are required for token refresh');
    }

    const refreshUrl = 'https://api.hubapi.com/oauth/v1/token';
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken
    });

    try {
      const response = await fetch(refreshUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
      }

      const tokenData = await response.json();
      this.accessToken = tokenData.access_token;

      if (tokenData.refresh_token) {
        this.refreshToken = tokenData.refresh_token;
      }

      console.log('✅ HubSpot access token refreshed successfully');
      return tokenData;
    } catch (error) {
      console.error('❌ Failed to refresh HubSpot access token:', error);
      throw error;
    }
  }

  /**
   * Test API connection
   */
  async testConnection() {
    try {
      // Try account details first
      const response = await this.makeRequest('/account-info/v3/details');
      console.log('✅ HubSpot connection successful');
      return { success: true, response };
    } catch (accountError) {
      // Fallback to contacts endpoint (we know user has this permission)
      try {
        const contactsResponse = await this.makeRequest('/crm/v3/objects/contacts', {
          params: { limit: 1 }
        });
        console.log('✅ HubSpot connection successful (fallback endpoint)');
        return { success: true, fallback: true, response: contactsResponse };
      } catch (contactsError) {
        console.error('❌ HubSpot connection failed');
        return {
          success: false,
          error: `Account endpoint: ${accountError.message}, Contacts endpoint: ${contactsError.message}`
        };
      }
    }
  }

  /**
   * Get account information
   */
  async getAccountInfo() {
    return await this.makeRequest('/account-info/v3/details');
  }

  /**
   * Get API usage statistics
   */
  async getApiUsage(period = 'daily') {
    return await this.makeRequest(`/account-info/v3/api-usage/${period}`);
  }
}