/**
 * HubSpot Meetings Analytics
 * Handles meeting statistics, scheduling data, and analytics
 */
export class HubSpotMeetings {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get meeting statistics for a date range
   */
  async getMeetingStats(options = {}) {
    const {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      endDate = new Date(),
      limit = 100,
      userId = null
    } = options;

    try {
      // Convert dates to HubSpot format (milliseconds since epoch)
      const startTimestamp = startDate instanceof Date ? startDate.getTime() : new Date(startDate).getTime();
      const endTimestamp = endDate instanceof Date ? endDate.getTime() : new Date(endDate).getTime();

      // Get meetings data using the engagements API
      const params = new URLSearchParams({
        limit: limit.toString(),
        engagement_type: 'MEETING',
        since: startTimestamp.toString(),
        until: endTimestamp.toString()
      });

      if (userId) {
        params.append('owner_id', userId);
      }

      const endpoint = `/engagements/v1/engagements/paged?${params}`;
      const response = await this.client.makeRequest(endpoint);

      return this.processMeetingStats(response);
    } catch (error) {
      console.error('❌ Failed to get meeting stats:', error);
      throw error;
    }
  }

  /**
   * Get meeting scheduling page analytics
   */
  async getSchedulingPageStats(options = {}) {
    const {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate = new Date(),
      pageId = null
    } = options;

    try {
      // This would use HubSpot's Analytics API for meetings
      // Note: Exact endpoint depends on HubSpot's current API structure
      let endpoint = '/analytics/v2/reports/meetings';
      
      const params = new URLSearchParams({
        start_date: this.formatDate(startDate),
        end_date: this.formatDate(endDate)
      });

      if (pageId) {
        params.append('page_id', pageId);
      }

      endpoint += `?${params}`;
      
      const response = await this.client.makeRequest(endpoint);
      return this.processSchedulingStats(response);
    } catch (error) {
      console.warn('⚠️ Scheduling page stats may not be available via API:', error.message);
      // Return empty stats structure if API doesn't support this yet
      return {
        schedulingPages: [],
        totalViews: 0,
        totalBookings: 0,
        conversionRate: 0,
        avgDuration: 0
      };
    }
  }

  /**
   * Get meeting attendees and participants data
   */
  async getMeetingParticipants(meetingId) {
    try {
      const endpoint = `/engagements/v1/engagements/${meetingId}`;
      const response = await this.client.makeRequest(endpoint);
      
      return {
        meetingId,
        owner: response.engagement?.owner || null,
        contacts: response.associations?.contactIds || [],
        companies: response.associations?.companyIds || [],
        deals: response.associations?.dealIds || [],
        metadata: response.metadata || {}
      };
    } catch (error) {
      console.error(`❌ Failed to get participants for meeting ${meetingId}:`, error);
      throw error;
    }
  }

  /**
   * Get meetings by outcome/result
   */
  async getMeetingsByOutcome(options = {}) {
    const {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate = new Date(),
      outcome = null // SCHEDULED, COMPLETED, CANCELLED, NO_SHOW
    } = options;

    try {
      const meetings = await this.getMeetingStats({ startDate, endDate, limit: 1000 });
      
      if (outcome) {
        meetings.meetings = meetings.meetings.filter(meeting => 
          meeting.outcome === outcome
        );
      }

      return this.groupMeetingsByOutcome(meetings.meetings);
    } catch (error) {
      console.error('❌ Failed to get meetings by outcome:', error);
      throw error;
    }
  }

  /**
   * Process raw meeting stats from HubSpot API
   */
  processMeetingStats(response) {
    const meetings = response.results || [];
    
    const stats = {
      totalMeetings: meetings.length,
      meetings: meetings.map(engagement => ({
        id: engagement.engagement.id,
        type: engagement.engagement.type,
        timestamp: engagement.engagement.timestamp,
        owner: engagement.engagement.ownerId,
        title: engagement.metadata?.title || 'Untitled Meeting',
        body: engagement.metadata?.body || '',
        startTime: engagement.metadata?.startTime,
        endTime: engagement.metadata?.endTime,
        location: engagement.metadata?.location,
        outcome: engagement.metadata?.outcome,
        source: engagement.metadata?.source,
        contacts: engagement.associations?.contactIds || [],
        companies: engagement.associations?.companyIds || [],
        deals: engagement.associations?.dealIds || []
      })),
      byOutcome: {},
      byMonth: {},
      totalDuration: 0,
      avgDuration: 0
    };

    // Calculate additional stats
    this.calculateAggregateStats(stats);
    
    return stats;
  }

  /**
   * Process scheduling page statistics
   */
  processSchedulingStats(response) {
    // Structure depends on actual HubSpot API response
    return {
      schedulingPages: response.pages || [],
      totalViews: response.total_views || 0,
      totalBookings: response.total_bookings || 0,
      conversionRate: response.conversion_rate || 0,
      avgDuration: response.avg_duration || 0,
      byPage: response.by_page || {}
    };
  }

  /**
   * Calculate aggregate statistics
   */
  calculateAggregateStats(stats) {
    const outcomeCount = {};
    const monthlyCount = {};
    let totalDuration = 0;

    stats.meetings.forEach(meeting => {
      // Count by outcome
      const outcome = meeting.outcome || 'UNKNOWN';
      outcomeCount[outcome] = (outcomeCount[outcome] || 0) + 1;

      // Count by month
      const date = new Date(meeting.timestamp);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      monthlyCount[monthKey] = (monthlyCount[monthKey] || 0) + 1;

      // Calculate duration if available
      if (meeting.startTime && meeting.endTime) {
        const duration = meeting.endTime - meeting.startTime;
        totalDuration += duration;
      }
    });

    stats.byOutcome = outcomeCount;
    stats.byMonth = monthlyCount;
    stats.totalDuration = totalDuration;
    stats.avgDuration = stats.totalMeetings > 0 ? totalDuration / stats.totalMeetings : 0;
  }

  /**
   * Group meetings by outcome
   */
  groupMeetingsByOutcome(meetings) {
    return meetings.reduce((acc, meeting) => {
      const outcome = meeting.outcome || 'UNKNOWN';
      if (!acc[outcome]) {
        acc[outcome] = [];
      }
      acc[outcome].push(meeting);
      return acc;
    }, {});
  }

  /**
   * Format date for HubSpot API
   */
  formatDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD format
  }

  /**
   * Get meeting trends over time
   */
  async getMeetingTrends(options = {}) {
    const {
      startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days
      endDate = new Date(),
      groupBy = 'week' // day, week, month
    } = options;

    try {
      const stats = await this.getMeetingStats({ startDate, endDate, limit: 10000 });
      return this.calculateTrends(stats.meetings, groupBy);
    } catch (error) {
      console.error('❌ Failed to get meeting trends:', error);
      throw error;
    }
  }

  /**
   * Calculate trends from meeting data
   */
  calculateTrends(meetings, groupBy) {
    const trends = {};
    
    meetings.forEach(meeting => {
      const date = new Date(meeting.timestamp);
      let key;
      
      switch (groupBy) {
        case 'day':
          key = date.toISOString().split('T')[0];
          break;
        case 'week':
          const startOfWeek = new Date(date);
          startOfWeek.setDate(date.getDate() - date.getDay());
          key = startOfWeek.toISOString().split('T')[0];
          break;
        case 'month':
          key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          break;
        default:
          key = date.toISOString().split('T')[0];
      }
      
      if (!trends[key]) {
        trends[key] = {
          date: key,
          count: 0,
          completed: 0,
          cancelled: 0,
          noShow: 0
        };
      }
      
      trends[key].count++;
      
      switch (meeting.outcome) {
        case 'COMPLETED':
          trends[key].completed++;
          break;
        case 'CANCELLED':
          trends[key].cancelled++;
          break;
        case 'NO_SHOW':
          trends[key].noShow++;
          break;
      }
    });

    return Object.values(trends).sort((a, b) => a.date.localeCompare(b.date));
  }

  // ===== MEETING CRUD OPERATIONS =====

  /**
   * Get a single meeting by ID
   */
  async getMeeting(meetingId, options = {}) {
    const {
      properties = ['hs_meeting_title', 'hs_meeting_outcome', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_body', 'hs_meeting_location'],
      associations = []
    } = options;

    try {
      let endpoint = `/crm/v3/objects/meetings/${meetingId}`;
      const params = new URLSearchParams();
      
      if (properties.length > 0) {
        params.append('properties', properties.join(','));
      }
      
      if (associations.length > 0) {
        params.append('associations', associations.join(','));
      }
      
      if (params.toString()) {
        endpoint += `?${params}`;
      }

      const response = await this.client.makeRequest(endpoint);
      return response;
    } catch (error) {
      console.error(`❌ Failed to get meeting ${meetingId}:`, error);
      throw error;
    }
  }

  /**
   * Get associations for a batch of meetings
   */
  async getMeetingAssociations(meetingIds, toObjectType = 'contacts') {
    try {
      // HubSpot batch associations endpoint
      const response = await this.client.makeRequest(`/crm/v4/associations/meetings/${toObjectType}/batch/read`, {
        method: 'POST',
        body: {
          inputs: meetingIds.map(id => ({ id }))
        }
      });

      // Build a map of meeting ID -> associated IDs
      const associations = {};
      if (response.results) {
        for (const result of response.results) {
          const meetingId = result.from?.id;
          if (meetingId && result.to && result.to.length > 0) {
            associations[meetingId] = result.to.map(t => t.toObjectId);
          }
        }
      }
      return associations;
    } catch (error) {
      console.error(`❌ Failed to get meeting associations:`, error.message);
      return {};
    }
  }

  /**
   * Search for meetings with filters
   */
  async searchMeetings(options = {}) {
    const {
      filters = [],
      properties = ['hs_meeting_title', 'hs_meeting_outcome', 'hs_meeting_start_time', 'hs_createdate'],
      sorts = [],
      limit = 100,
      after = undefined
    } = options;

    try {
      const searchBody = {
        filterGroups: filters.length > 0 ? [{ filters }] : [],
        properties,
        limit
      };

      if (sorts.length > 0) {
        searchBody.sorts = sorts;
      }

      if (after) {
        searchBody.after = after;
      }

      const response = await this.client.makeRequest('/crm/v3/objects/meetings/search', {
        method: 'POST',
        body: searchBody
      });
      return response;
    } catch (error) {
      console.error('❌ Failed to search meetings:', error);
      throw error;
    }
  }

  /**
   * Update a meeting's properties
   */
  async updateMeeting(meetingId, properties) {
    try {
      const updateBody = { properties };
      const endpoint = `/crm/v3/objects/meetings/${meetingId}`;
      
      const response = await this.client.makeRequest(endpoint, {
        method: 'PATCH',
        body: updateBody
      });
      
      console.log(`✅ Updated meeting ${meetingId}`);
      return response;
    } catch (error) {
      console.error(`❌ Failed to update meeting ${meetingId}:`, error);
      throw error;
    }
  }

  /**
   * Update meeting outcome specifically
   */
  async updateMeetingOutcome(meetingId, outcome) {
    const validOutcomes = ['SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELED', 'ARCHIVED'];
    
    if (!validOutcomes.includes(outcome)) {
      throw new Error(`Invalid outcome: ${outcome}. Valid outcomes: ${validOutcomes.join(', ')}`);
    }

    try {
      return await this.updateMeeting(meetingId, {
        hs_meeting_outcome: outcome
      });
    } catch (error) {
      console.error(`❌ Failed to update meeting outcome for ${meetingId}:`, error);
      throw error;
    }
  }

  /**
   * Bulk update meetings with filters
   */
  async bulkUpdateMeetings(options = {}) {
    const {
      filters = [],
      properties = {},
      dryRun = false,
      batchSize = 10,
      delayMs = 100
    } = options;

    try {
      console.log('🔍 Searching for meetings to update...');
      
      // Get all matching meetings
      let allMeetings = [];
      let after = undefined;
      
      do {
        const searchResult = await this.searchMeetings({
          filters,
          properties: ['hs_meeting_title', 'hs_meeting_outcome', 'hs_createdate'],
          limit: 100,
          after
        });
        
        allMeetings = allMeetings.concat(searchResult.results);
        after = searchResult.paging?.next?.after;
        
      } while (after);

      console.log(`📊 Found ${allMeetings.length} meetings to update`);

      if (dryRun) {
        console.log('🧪 DRY RUN - No actual updates will be made');
        
        // Show sample of what would be updated
        const sample = allMeetings.slice(0, 5);
        console.log('\nSample meetings that would be updated:');
        sample.forEach((meeting, index) => {
          console.log(`${index + 1}. Meeting ${meeting.id}`);
          console.log(`   Title: ${meeting.properties.hs_meeting_title || 'No title'}`);
          console.log(`   Current Outcome: ${meeting.properties.hs_meeting_outcome || 'NOT_SET'}`);
          console.log(`   Would update with:`, properties);
        });
        
        return {
          dryRun: true,
          totalMeetings: allMeetings.length,
          sampleMeetings: sample.map(m => ({
            id: m.id,
            title: m.properties.hs_meeting_title,
            currentOutcome: m.properties.hs_meeting_outcome
          }))
        };
      }

      // Perform actual updates in batches
      console.log(`🔄 Starting bulk update of ${allMeetings.length} meetings...`);
      console.log(`   Batch size: ${batchSize}, Delay: ${delayMs}ms`);
      
      const results = {
        totalMeetings: allMeetings.length,
        updated: 0,
        errors: []
      };

      for (let i = 0; i < allMeetings.length; i += batchSize) {
        const batch = allMeetings.slice(i, i + batchSize);
        
        console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allMeetings.length / batchSize)}...`);
        
        // Process batch concurrently
        const batchPromises = batch.map(async (meeting) => {
          try {
            await this.updateMeeting(meeting.id, properties);
            return { success: true, meetingId: meeting.id };
          } catch (error) {
            console.error(`Failed to update meeting ${meeting.id}:`, error.message);
            return { success: false, meetingId: meeting.id, error: error.message };
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach(result => {
          if (result.status === 'fulfilled') {
            if (result.value.success) {
              results.updated++;
            } else {
              results.errors.push(result.value);
            }
          } else {
            results.errors.push({ error: result.reason.message });
          }
        });

        // Add delay between batches to respect rate limits
        if (i + batchSize < allMeetings.length && delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      console.log(`\n✅ Bulk update completed!`);
      console.log(`   Updated: ${results.updated}/${results.totalMeetings} meetings`);
      console.log(`   Errors: ${results.errors.length}`);

      return results;
    } catch (error) {
      console.error('❌ Bulk update failed:', error);
      throw error;
    }
  }

  /**
   * Archive meetings older than a specific date
   */
  async archiveOldMeetings(cutoffDate, options = {}) {
    const {
      dryRun = true,
      batchSize = 10,
      delayMs = 100
    } = options;

    const filters = [
      {
        propertyName: 'hs_createdate',
        operator: 'LT',
        value: new Date(cutoffDate).getTime()
      },
      {
        propertyName: 'hs_meeting_start_time',
        operator: 'LT',
        value: new Date().getTime() // Only past meetings
      }
    ];

    console.log(`📦 Archiving meetings created before ${cutoffDate}...`);

    return await this.bulkUpdateMeetings({
      filters,
      properties: { hs_meeting_outcome: 'ARCHIVED' },
      dryRun,
      batchSize,
      delayMs
    });
  }

  /**
   * Update database with all meetings (fetch from API + save to SQLite)
   */
  async updateDatabase(options = {}) {
    const {
      fullSync = false,
      dbPath = null
    } = options;

    // Import required modules dynamically
    const Database = (await import('better-sqlite3')).default;
    const path = await import('path');
    const { fileURLToPath } = await import('url');

    // Resolve database path
    let resolvedDbPath = dbPath;
    if (!resolvedDbPath) {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      resolvedDbPath = path.join(__dirname, '..', '..', 'data', 'hubspot_meetings', 'hubspot-meetings.sqlite');
    }

    console.log('🔄 Starting HubSpot meetings database update...\n');

    let db;
    try {
      // Open database
      db = new Database(resolvedDbPath);
      console.log('✅ Database connected\n');

      // Fetch meetings with pagination
      console.log(`📊 Fetching meetings from HubSpot${fullSync ? ' (FULL SYNC)' : ''}...`);

      const properties = [
        'hs_meeting_title',
        'hs_meeting_outcome',
        'hs_meeting_start_time',
        'hs_meeting_end_time',
        'hs_createdate',
        'hs_meeting_body',
        'hs_meeting_location',
        'hubspot_owner_id'
      ];

      let allMeetings = [];
      let after = undefined;
      let pageNum = 1;

      // Pagination loop
      do {
        console.log(`📄 Fetching page ${pageNum}...`);

        const searchResult = await this.searchMeetings({
          properties,
          sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
          limit: 100,
          after
        });

        const meetings = searchResult.results || [];
        allMeetings = allMeetings.concat(meetings);

        after = searchResult.paging?.next?.after;
        pageNum++;

        console.log(`   ✓ Got ${meetings.length} meetings (Total: ${allMeetings.length})`);

        // If not full sync, stop after first page
        if (!fullSync) {
          break;
        }

      } while (after);

      console.log(`\n📊 Found ${allMeetings.length} total meetings to process`);

      if (allMeetings.length === 0) {
        console.log('ℹ️ No meetings to update');
        return { success: true, inserted: 0, updated: 0 };
      }

      // Fetch contact associations in batches
      console.log(`\n🔗 Fetching contact associations...`);
      const allAssociations = {};
      const batchSize = 100;
      for (let i = 0; i < allMeetings.length; i += batchSize) {
        const batch = allMeetings.slice(i, i + batchSize);
        const meetingIds = batch.map(m => m.id);
        const batchAssociations = await this.getMeetingAssociations(meetingIds, 'contacts');
        Object.assign(allAssociations, batchAssociations);
        console.log(`   ✓ Fetched associations for meetings ${i + 1}-${Math.min(i + batchSize, allMeetings.length)}`);
      }
      console.log(`   Found ${Object.keys(allAssociations).length} meetings with contact associations`);

      // Ensure associated_contact_ids column exists
      try {
        db.exec(`ALTER TABLE meetings ADD COLUMN associated_contact_ids TEXT`);
        console.log('   Added associated_contact_ids column');
      } catch (e) {
        // Column already exists
      }

      // Prepare upsert statement
      const upsertMeeting = db.prepare(`
        INSERT INTO meetings
        (id, title, outcome, start_time, end_time, created_date, owner_id, body, location, associated_contact_ids, data_source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          outcome = excluded.outcome,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          owner_id = excluded.owner_id,
          body = excluded.body,
          location = excluded.location,
          associated_contact_ids = excluded.associated_contact_ids,
          data_source = 'api',
          updated_at = CURRENT_TIMESTAMP
      `);

      let updated = 0;
      let inserted = 0;

      console.log(`💾 Upserting meetings to database...`);

      const transaction = db.transaction((meetingsBatch) => {
        for (const meeting of meetingsBatch) {
          try {
            const props = meeting.properties;

            // Check if meeting exists
            const existing = db.prepare('SELECT id FROM meetings WHERE id = ?').get(meeting.id);

            // Get associated contact IDs (as JSON array string)
            const contactIds = allAssociations[meeting.id];
            const contactIdsJson = contactIds && contactIds.length > 0 ? JSON.stringify(contactIds) : null;

            upsertMeeting.run(
              meeting.id,
              props.hs_meeting_title || null,
              props.hs_meeting_outcome || null,
              props.hs_meeting_start_time || null,
              props.hs_meeting_end_time || null,
              props.hs_createdate || null,
              props.hubspot_owner_id || null,
              props.hs_meeting_body || null,
              props.hs_meeting_location || null,
              contactIdsJson
            );

            if (existing) {
              updated++;
            } else {
              inserted++;
            }

          } catch (error) {
            console.error(`❌ Error processing meeting ${meeting.id}:`, error.message);
          }
        }
      });

      transaction(allMeetings);

      console.log(`✅ Meetings sync completed:`);
      console.log(`   Inserted: ${inserted} new meetings`);
      console.log(`   Updated: ${updated} existing meetings`);

      // Get stats
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN data_source = 'api' THEN 1 ELSE 0 END) as api_count,
          SUM(CASE WHEN data_source = 'csv' THEN 1 ELSE 0 END) as csv_count
        FROM meetings
      `).get();

      const outcomes = db.prepare(`
        SELECT outcome, COUNT(*) as count
        FROM meetings
        WHERE outcome IS NOT NULL AND outcome != ''
        GROUP BY outcome
        ORDER BY count DESC
        LIMIT 5
      `).all();

      console.log('\n📊 Database Stats:');
      console.log(`   Total meetings: ${stats.total}`);
      console.log(`   API source: ${stats.api_count}`);
      console.log(`   CSV legacy: ${stats.csv_count}`);

      console.log('\n🎯 Top outcomes:');
      outcomes.forEach(o => console.log(`   ${o.outcome}: ${o.count}`));

      console.log('\n🎉 HubSpot meetings database update complete!');

      return {
        success: true,
        total: stats.total,
        inserted,
        updated,
        apiCount: stats.api_count,
        csvCount: stats.csv_count
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