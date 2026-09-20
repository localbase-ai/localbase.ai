/**
 * HubSpot Companies Service
 * Handles company data retrieval and management
 */
export class HubSpotCompanies {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get all companies with pagination
   */
  async getCompanies(options = {}) {
    const {
      limit = 100,
      after,
      properties = [
        'name',
        'domain',
        'city',
        'state',
        'country',
        'industry',
        'phone',
        'website',
        'numberofemployees',
        'annualrevenue',
        'createdate',
        'hs_lastmodifieddate'
      ]
    } = options;

    try {
      const params = {
        limit,
        properties: properties.join(',')
      };

      if (after) {
        params.after = after;
      }

      const response = await this.client.makeRequest('/crm/v3/objects/companies', { params });

      return {
        success: true,
        total: response.results?.length || 0,
        companies: (response.results || []).map(company => ({
          id: company.id,
          ...company.properties
        })),
        paging: response.paging
      };
    } catch (error) {
      console.error('❌ Failed to fetch companies:', error);
      return {
        success: false,
        error: error.message,
        companies: []
      };
    }
  }

  /**
   * Get a specific company by ID
   */
  async getCompanyById(companyId, properties = ['name', 'domain', 'industry']) {
    try {
      const response = await this.client.makeRequest(`/crm/v3/objects/companies/${companyId}`, {
        params: {
          properties: properties.join(',')
        }
      });

      return {
        success: true,
        company: {
          id: response.id,
          ...response.properties
        }
      };
    } catch (error) {
      console.error(`❌ Failed to fetch company ${companyId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Search companies by name or domain
   */
  async searchCompanies(query, options = {}) {
    const {
      limit = 100,
      properties = ['name', 'domain', 'industry']
    } = options;

    try {
      const response = await this.client.makeRequest('/crm/v3/objects/companies/search', {
        method: 'POST',
        body: {
          query,
          limit,
          properties
        }
      });

      return {
        success: true,
        total: response.total,
        companies: response.results.map(company => ({
          id: company.id,
          ...company.properties
        }))
      };
    } catch (error) {
      console.error('❌ Failed to search companies:', error);
      return {
        success: false,
        error: error.message,
        companies: []
      };
    }
  }

  /**
   * Get all company properties to see available fields
   */
  async getCompanyProperties() {
    try {
      const response = await this.client.makeRequest('/crm/v3/properties/companies');

      return {
        success: true,
        totalProperties: response.results.length,
        properties: response.results.map(prop => ({
          name: prop.name,
          label: prop.label,
          type: prop.type,
          fieldType: prop.fieldType
        }))
      };
    } catch (error) {
      console.error('❌ Failed to fetch company properties:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Update database with all companies (fetch from API + save to SQLite)
   */
  async updateDatabase(options = {}) {
    const { dbPath = null } = options;

    // Import required modules dynamically
    const Database = (await import('better-sqlite3')).default;
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const fs = await import('fs');

    // Resolve database path
    let resolvedDbPath = dbPath;
    if (!resolvedDbPath) {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      resolvedDbPath = path.join(__dirname, '..', '..', 'data', 'hubspot_companies', 'hubspot-companies.sqlite');
    }

    console.log('🏢 Starting HubSpot companies database update...\n');

    let db;
    try {
      // Create data directory if needed
      const dataDir = path.dirname(resolvedDbPath);
      await fs.promises.mkdir(dataDir, { recursive: true });

      // Open database
      db = new Database(resolvedDbPath);
      console.log('✅ Database connected\n');

      // Create table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS companies (
          id TEXT PRIMARY KEY,
          name TEXT,
          domain TEXT,
          city TEXT,
          state TEXT,
          country TEXT,
          industry TEXT,
          phone TEXT,
          description TEXT,
          num_employees INTEGER,
          annual_revenue REAL,
          website TEXT,
          create_date TEXT,
          last_modified TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
        CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
        CREATE INDEX IF NOT EXISTS idx_companies_last_modified ON companies(last_modified);
      `);

      // Fetch all companies with pagination
      console.log('🔍 Fetching companies...');

      const properties = [
        'name',
        'domain',
        'city',
        'state',
        'country',
        'industry',
        'phone',
        'description',
        'numberofemployees',
        'annualrevenue',
        'website',
        'createdate'
      ];

      let allCompanies = [];
      let after = undefined;
      let pageNum = 1;

      // Pagination loop
      do {
        console.log(`📄 Fetching page ${pageNum}...`);

        const params = {
          properties: properties.join(','),
          limit: 100
        };

        if (after) {
          params.after = after;
        }

        const response = await this.client.makeRequest('/crm/v3/objects/companies', { params });

        const companies = response.results || [];
        allCompanies = allCompanies.concat(companies);

        after = response.paging?.next?.after;
        pageNum++;

        console.log(`   ✓ Got ${companies.length} companies (Total: ${allCompanies.length})`);

      } while (after);

      console.log(`\n✅ Retrieved ${allCompanies.length} total companies`);

      // Insert/update companies
      console.log('\n💾 Saving to database...');

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO companies (
          id, name, domain, city, state, country, industry, phone, description,
          num_employees, annual_revenue, website, create_date, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const transaction = db.transaction((companies) => {
        for (const company of companies) {
          const props = company.properties;
          stmt.run(
            company.id,
            props.name || null,
            props.domain || null,
            props.city || null,
            props.state || null,
            props.country || null,
            props.industry || null,
            props.phone || null,
            props.description || null,
            props.numberofemployees ? parseInt(props.numberofemployees) : null,
            props.annualrevenue ? parseFloat(props.annualrevenue) : null,
            props.website || null,
            props.createdate || null,
            new Date().toISOString()
          );
        }
      });

      transaction(allCompanies);
      console.log(`✅ Saved ${allCompanies.length} companies to database`);

      // Get stats
      const stats = db.prepare(`
        SELECT COUNT(*) as total FROM companies
      `).get();

      console.log('\n📊 Database Stats:');
      console.log(`   Total companies: ${stats.total}`);

      console.log('\n🎉 HubSpot companies database update complete!');

      return {
        success: true,
        total: stats.total
      };

    } catch (error) {
      console.error('\n❌ Database update failed:', error);
      throw error;
    } finally {
      if (db) {
        db.close();
        console.log('✅ Database connection closed');
      }
    }
  }
}
