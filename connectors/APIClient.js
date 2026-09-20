/**
 * BaseConnector - Standard connector pattern for all data sources
 *
 * Provides:
 * - Unified auth handling (Bearer, Basic, API Key, Custom)
 * - Request management with retry logic
 * - Rate limiting
 * - Error handling
 * - Pagination helpers
 * - Standard logging
 */
export class BaseConnector {
  constructor(config = {}) {
    this.name = config.name || 'Unknown';
    this.baseURL = config.baseURL || config.baseUrl;
    this.authType = config.authType || 'none'; // 'bearer', 'basic', 'apikey', 'custom', 'none'
    this.credentials = config.credentials || {};
    this.rateLimit = config.rateLimit || null; // milliseconds between requests
    this.retryAttempts = config.retryAttempts || 3;
    this.timeout = config.timeout || 30000;
    this.lastRequestTime = 0;

    if (!this.baseURL) {
      throw new Error(`BaseURL is required for ${this.name} connector`);
    }
  }

  /**
   * Build auth headers based on auth type
   */
  getAuthHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    switch (this.authType) {
      case 'bearer':
        if (this.credentials.token || this.credentials.accessToken) {
          headers['Authorization'] = `Bearer ${this.credentials.token || this.credentials.accessToken}`;
        }
        break;

      case 'basic':
        if (this.credentials.username && this.credentials.password) {
          const encoded = Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
        }
        break;

      case 'apikey':
        if (this.credentials.apiKey && this.credentials.headerName) {
          headers[this.credentials.headerName] = this.credentials.apiKey;
        } else if (this.credentials.apiKey) {
          headers['Authorization'] = this.credentials.apiKey;
        }
        break;

      case 'custom':
        // Subclasses can override getAuthHeaders() for custom auth
        break;
    }

    return headers;
  }

  /**
   * Apply rate limiting
   */
  async applyRateLimit() {
    if (!this.rateLimit) return;

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.rateLimit) {
      const waitTime = this.rateLimit - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Make HTTP request with retry logic
   */
  async makeRequest(endpoint, options = {}) {
    const {
      method = 'GET',
      params = {},
      body = null,
      headers = {},
      retries = this.retryAttempts
    } = options;

    // Apply rate limiting
    await this.applyRateLimit();

    // Build URL with query params
    let url = `${this.baseURL}${endpoint}`;
    if (Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, typeof value === 'object' ? JSON.stringify(value) : value);
        }
      });
      if (searchParams.toString()) {
        url += `?${searchParams.toString()}`;
      }
    }

    // Merge headers
    const requestHeaders = {
      ...this.getAuthHeaders(),
      ...headers
    };

    const requestOptions = {
      method,
      headers: requestHeaders,
      timeout: this.timeout
    };

    if (body && method !== 'GET') {
      requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    // Retry logic
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(`${attempt > 0 ? '🔄' : '🔗'} ${this.name}: ${method} ${endpoint}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);

        const response = await fetch(url, requestOptions);

        // Log rate limit info if available
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining') || response.headers.get('RateLimit-Remaining');
        if (rateLimitRemaining) {
          console.log(`⚡ ${this.name} rate limit remaining: ${rateLimitRemaining}`);
        }

        if (!response.ok) {
          // Handle specific status codes
          if (response.status === 429) {
            // Rate limit exceeded - wait longer
            const retryAfter = response.headers.get('Retry-After') || 60;
            console.warn(`⚠️  ${this.name} rate limit exceeded. Waiting ${retryAfter}s...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue;
          }

          if (response.status === 401 && this.handleUnauthorized) {
            // Let subclass handle token refresh
            const refreshed = await this.handleUnauthorized();
            if (refreshed) continue;
          }

          throw new Error(`${this.name} API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data;

      } catch (error) {
        const isLastAttempt = attempt === retries;

        if (isLastAttempt) {
          console.error(`❌ ${this.name} request failed after ${retries + 1} attempts:`, error.message);
          throw error;
        }

        // Exponential backoff
        const backoffTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`⚠️  ${this.name} request failed, retrying in ${backoffTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
  }

  /**
   * Paginate through all results
   */
  async makeAllRequests(endpoint, options = {}) {
    const {
      params = {},
      pageParam = 'page',
      pageSizeParam = 'page_size',
      pageSize = 100,
      maxPages = 100,
      getNextPage = null // Custom function to determine if there are more pages
    } = options;

    const allData = [];
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages && currentPage <= maxPages) {
      const pageParams = {
        ...params,
        [pageParam]: currentPage,
        [pageSizeParam]: pageSize
      };

      try {
        const response = await this.makeRequest(endpoint, {
          ...options,
          params: pageParams
        });

        // Extract data (subclasses can override)
        const pageData = this.extractPageData(response);

        if (pageData && pageData.length > 0) {
          allData.push(...pageData);
          console.log(`📄 ${this.name}: Fetched page ${currentPage}, total records: ${allData.length}`);
        }

        // Determine if there are more pages
        if (getNextPage) {
          hasMorePages = getNextPage(response);
        } else {
          hasMorePages = pageData && pageData.length === pageSize;
        }

        currentPage++;

      } catch (error) {
        console.error(`❌ ${this.name} pagination error on page ${currentPage}:`, error.message);
        break;
      }
    }

    console.log(`✅ ${this.name}: Completed pagination. Total records: ${allData.length}`);
    return allData;
  }

  /**
   * Extract data from paginated response
   * Override in subclass if response format differs
   */
  extractPageData(response) {
    // Common patterns:
    if (Array.isArray(response)) return response;
    if (response.data && Array.isArray(response.data)) return response.data;
    if (response.results && Array.isArray(response.results)) return response.results;
    return [];
  }

  /**
   * Test connection to API
   * Subclasses should override with specific endpoint
   */
  async testConnection() {
    throw new Error(`testConnection() must be implemented by ${this.name} connector`);
  }

  /**
   * Handle unauthorized responses (e.g., token refresh)
   * Subclasses can override
   */
  async handleUnauthorized() {
    return false; // Not handled by default
  }

  /**
   * Update data from source
   * Subclasses should implement
   */
  async update() {
    throw new Error(`update() must be implemented by ${this.name} connector`);
  }
}
