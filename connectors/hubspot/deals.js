/**
 * HubSpot Deals Service
 * Handles deal pipeline data and analytics
 */
export class HubSpotDeals {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get deals by close date range
   */
  async getDealsByCloseDate(startDate, endDate, options = {}) {
    const {
      limit = 100,
      properties = [
        'dealname',
        'amount',
        'dealstage',
        'closedate',
        'pipeline',
        'hs_is_closed',
        'hs_is_closed_won',
        'hs_is_closed_lost',
        'hs_deal_stage_probability',
        'dealtype',
        'hs_analytics_source',
        'createdate',
        'hs_lastmodifieddate',
        'hubspot_owner_id'
      ]
    } = options;

    try {
      console.log(`🔍 Fetching deals with close dates between ${startDate.toISOString().split('T')[0]} and ${endDate.toISOString().split('T')[0]}`);

      const startTimestamp = startDate.getTime();
      const endTimestamp = endDate.getTime();

      const requestBody = {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'closedate',
                operator: 'GTE',
                value: startTimestamp.toString()
              },
              {
                propertyName: 'closedate',
                operator: 'LTE',
                value: endTimestamp.toString()
              }
            ]
          }
        ],
        properties: properties,
        limit: limit,
        after: 0
      };

      const response = await this.client.makeRequest('/crm/v3/objects/deals/search', {
        method: 'POST',
        body: JSON.stringify(requestBody)
      });

      return this.processDealsResponse(response);
    } catch (error) {
      console.error('❌ Failed to get deals by close date:', error);
      throw error;
    }
  }

  /**
   * Get all deals (paginated)
   */
  async getAllDeals(options = {}) {
    const {
      limit = 100,
      properties = ['dealname', 'amount', 'dealstage', 'closedate', 'pipeline'],
      after = 0
    } = options;

    try {
      const params = {
        limit: limit.toString(),
        after: after.toString(),
        properties: properties.join(',')
      };

      const response = await this.client.makeRequest('/crm/v3/objects/deals', { params });
      return this.processDealsResponse(response);
    } catch (error) {
      console.error('❌ Failed to get all deals:', error);
      throw error;
    }
  }

  /**
   * Get deal pipeline summary
   */
  async getDealPipelineSummary(options = {}) {
    const {
      startDate = new Date(new Date().getFullYear(), 0, 1), // Start of current year
      endDate = new Date()
    } = options;

    try {
      const deals = await this.getDealsByCloseDate(startDate, endDate);

      const pipelineSummary = {
        totalDeals: deals.length,
        totalValue: 0,
        wonDeals: 0,
        wonValue: 0,
        lostDeals: 0,
        lostValue: 0,
        openDeals: 0,
        openValue: 0,
        byStage: {},
        byPipeline: {},
        dateRange: {
          start: startDate.toISOString().split('T')[0],
          end: endDate.toISOString().split('T')[0]
        }
      };

      deals.forEach(deal => {
        const amount = parseFloat(deal.properties.amount) || 0;
        const stage = deal.properties.dealstage;
        const pipeline = deal.properties.pipeline;
        const isClosed = deal.properties.hs_is_closed === 'true';
        const isWon = deal.properties.hs_is_closed_won === 'true';

        pipelineSummary.totalValue += amount;

        // Track by stage
        if (!pipelineSummary.byStage[stage]) {
          pipelineSummary.byStage[stage] = { count: 0, value: 0 };
        }
        pipelineSummary.byStage[stage].count++;
        pipelineSummary.byStage[stage].value += amount;

        // Track by pipeline
        if (!pipelineSummary.byPipeline[pipeline]) {
          pipelineSummary.byPipeline[pipeline] = { count: 0, value: 0 };
        }
        pipelineSummary.byPipeline[pipeline].count++;
        pipelineSummary.byPipeline[pipeline].value += amount;

        if (isClosed) {
          if (isWon) {
            pipelineSummary.wonDeals++;
            pipelineSummary.wonValue += amount;
          } else {
            pipelineSummary.lostDeals++;
            pipelineSummary.lostValue += amount;
          }
        } else {
          pipelineSummary.openDeals++;
          pipelineSummary.openValue += amount;
        }
      });

      return pipelineSummary;
    } catch (error) {
      console.error('❌ Failed to get deal pipeline summary:', error);
      throw error;
    }
  }

  /**
   * Fetch all HubSpot owners and return a map of id -> name
   */
  async fetchOwners() {
    const ownersMap = {};
    try {
      const response = await this.client.makeRequest('/crm/v3/owners', {
        params: { limit: '500' }
      });

      if (response.results) {
        for (const owner of response.results) {
          const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email;
          ownersMap[owner.id] = name;
        }
        console.log(`✅ Loaded ${Object.keys(ownersMap).length} owners`);
      }
    } catch (error) {
      console.warn('⚠️ Could not fetch owners:', error.message);
    }
    return ownersMap;
  }

  /**
   * Process the deals API response
   */
  processDealsResponse(response) {
    if (!response || !response.results) {
      console.warn('⚠️ No deals data in response');
      return [];
    }

    console.log(`✅ Found ${response.results.length} deals`);

    return response.results.map(deal => ({
      id: deal.id,
      properties: deal.properties,
      createdAt: deal.createdAt,
      updatedAt: deal.updatedAt,
      archived: deal.archived
    }));
  }

  /**
   * Update database with all deals (fetch from API + save to SQLite)
   */
  async updateDatabase(options = {}) {
    const {
      startYear = 2022,
      sinceDate = null,
      dbPath = null
    } = options;

    const Database = (await import('better-sqlite3')).default;
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const fs = await import('fs');

    let resolvedDbPath = dbPath;
    if (!resolvedDbPath) {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      resolvedDbPath = path.join(__dirname, '..', '..', 'data', 'hubspot_deals', 'hubspot-deals.sqlite');
    }

    console.log('🚀 Starting HubSpot deals database update...\n');

    let db;
    try {
      // Create data directory if needed
      const dataDir = path.dirname(resolvedDbPath);
      await fs.promises.mkdir(dataDir, { recursive: true });

      db = new Database(resolvedDbPath);
      console.log('✅ Database connected\n');

      // Create table if not exists
      db.prepare(`
        CREATE TABLE IF NOT EXISTS deals (
          id TEXT PRIMARY KEY,
          name TEXT,
          amount REAL,
          stage TEXT,
          close_date TEXT,
          pipeline TEXT,
          is_closed_won INTEGER,
          is_closed_lost INTEGER,
          forecast_probability TEXT,
          create_date TEXT,
          last_modified TEXT,
          owner_id TEXT,
          owner_name TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      // Add owner columns if they don't exist
      try {
        db.prepare('ALTER TABLE deals ADD COLUMN owner_id TEXT').run();
      } catch (e) { /* column already exists */ }
      try {
        db.prepare('ALTER TABLE deals ADD COLUMN owner_name TEXT').run();
      } catch (e) { /* column already exists */ }

      // Determine filter
      let filterTimestamp, filterProperty, logMessage;

      if (sinceDate) {
        const sinceDateObj = new Date(sinceDate);
        filterTimestamp = sinceDateObj.getTime();
        filterProperty = 'hs_lastmodifieddate';
        logMessage = `🔄 Incremental sync: fetching deals modified since ${sinceDate}`;
      } else {
        const startDate = new Date(`${startYear}-01-01`);
        filterTimestamp = startDate.getTime();
        filterProperty = 'createdate';
        logMessage = `🔍 Full sync: fetching deals from ${startYear}`;
      }

      console.log(logMessage);

      const properties = [
        'dealname',
        'amount',
        'dealstage',
        'closedate',
        'pipeline',
        'hs_is_closed_won',
        'hs_is_closed_lost',
        'hs_deal_stage_probability',
        'createdate',
        'hs_lastmodifieddate',
        'hubspot_owner_id'
      ];

      // Fetch owner names
      console.log('👤 Fetching HubSpot owners...');
      const ownersMap = await this.fetchOwners();

      let allDeals = [];
      let after = undefined;
      let pageNum = 1;

      // Pagination loop
      do {
        console.log(`📄 Fetching page ${pageNum}...`);

        const requestBody = {
          filterGroups: [{
            filters: [{
              propertyName: filterProperty,
              operator: 'GTE',
              value: filterTimestamp.toString()
            }]
          }],
          properties,
          limit: 200,
          after
        };

        const response = await this.client.makeRequest('/crm/v3/objects/deals/search', {
          method: 'POST',
          body: requestBody
        });

        const deals = response.results || [];
        allDeals = allDeals.concat(deals);

        after = response.paging?.next?.after;
        pageNum++;

        console.log(`   ✓ Got ${deals.length} deals (Total: ${allDeals.length})`);

      } while (after);

      console.log(`\n✅ Retrieved ${allDeals.length} total deals`);

      // Clear and insert
      console.log('\n💾 Saving to database...');
      db.prepare('DELETE FROM line_items').run();
      db.prepare('DELETE FROM deals').run();

      const insert = db.prepare(`
        INSERT INTO deals (
          id, name, amount, stage, close_date, pipeline,
          is_closed_won, is_closed_lost, forecast_probability,
          create_date, last_modified, owner_id, owner_name, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      const transaction = db.transaction((deals) => {
        for (const deal of deals) {
          const props = deal.properties || {};
          const ownerId = props.hubspot_owner_id || null;
          const ownerName = ownerId ? (ownersMap[ownerId] || null) : null;
          insert.run(
            deal.id,
            props.dealname || null,
            parseFloat(props.amount) || null,
            props.dealstage || null,
            props.closedate || null,
            props.pipeline || null,
            props.hs_is_closed_won === 'true' ? 1 : 0,
            props.hs_is_closed_lost === 'true' ? 1 : 0,
            props.hs_deal_stage_probability || null,
            props.createdate || null,
            props.hs_lastmodifieddate || null,
            ownerId,
            ownerName
          );
        }
      });

      transaction(allDeals);
      console.log(`✅ Saved ${allDeals.length} deals to database`);

      // Sync line items
      console.log('\n📦 Syncing line items...');

      db.prepare(`
        CREATE TABLE IF NOT EXISTS line_items (
          id TEXT PRIMARY KEY,
          deal_id TEXT,
          name TEXT,
          amount REAL,
          price REAL,
          quantity REAL,
          product_id TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (deal_id) REFERENCES deals(id)
        )
      `).run();

      db.prepare('DELETE FROM line_items').run();

      const insertLineItem = db.prepare(`
        INSERT INTO line_items (id, deal_id, name, amount, price, quantity, product_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      let totalLineItems = 0;

      for (const deal of allDeals) {
        try {
          const assocResponse = await this.client.makeRequest(
            `/crm/v4/objects/deals/${deal.id}/associations/line_items`
          );

          const lineItemIds = (assocResponse.results || []).map(r => r.toObjectId);
          if (lineItemIds.length === 0) continue;

          for (const liId of lineItemIds) {
            const liResponse = await this.client.makeRequest(
              `/crm/v3/objects/line_items/${liId}`,
              { params: { properties: 'name,amount,price,quantity,hs_product_id' } }
            );
            const props = liResponse.properties || {};
            insertLineItem.run(
              liId,
              deal.id,
              props.name || null,
              parseFloat(props.amount) || null,
              parseFloat(props.price) || null,
              parseFloat(props.quantity) || null,
              props.hs_product_id || null
            );
            totalLineItems++;
          }
        } catch (e) {
          console.warn(`   ⚠️ Could not fetch line items for deal ${deal.id}: ${e.message}`);
        }
      }

      console.log(`✅ Saved ${totalLineItems} line items`);

      // Get stats
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN is_closed_won = 1 THEN 1 ELSE 0 END) as won,
          SUM(CASE WHEN is_closed_lost = 1 THEN 1 ELSE 0 END) as lost,
          SUM(CASE WHEN is_closed_won = 0 AND is_closed_lost = 0 THEN 1 ELSE 0 END) as open,
          ROUND(SUM(CASE WHEN is_closed_won = 1 THEN amount ELSE 0 END), 2) as won_value
        FROM deals
      `).get();

      console.log('\n📊 Database Stats:');
      console.log(`   Total deals: ${stats.total}`);
      console.log(`   Won: ${stats.won} ($${(stats.won_value || 0).toLocaleString()})`);
      console.log(`   Lost: ${stats.lost}`);
      console.log(`   Open: ${stats.open}`);
      console.log(`   Line items: ${totalLineItems}`);

      console.log('\n🎉 HubSpot deals database update complete!');

      return {
        success: true,
        total: stats.total,
        won: stats.won,
        lost: stats.lost,
        open: stats.open,
        wonValue: stats.won_value
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
