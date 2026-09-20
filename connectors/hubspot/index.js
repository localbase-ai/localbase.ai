import { HubSpotClient } from './client.js';
import { HubSpotMeetings } from './meetings.js';
import { HubSpotContacts } from './contacts.js';
import { HubSpotDeals } from './deals.js';
import { HubSpotCompanies } from './companies.js';

export class HubSpotService {
  constructor(options = {}) {
    const {
      accessToken,
      refreshToken,
      clientId,
      clientSecret,
      baseUrl
    } = options;

    if (!accessToken && !refreshToken) {
      throw new Error('HubSpot access token or refresh token is required');
    }

    this.client = new HubSpotClient({
      accessToken,
      refreshToken,
      clientId,
      clientSecret,
      baseUrl
    });

    this.meetings = new HubSpotMeetings(this.client);
    this.contacts = new HubSpotContacts(this.client);
    this.deals = new HubSpotDeals(this.client);
    this.companies = new HubSpotCompanies(this.client);
  }

  // Test the HubSpot API connection
  async testConnection() {
    return await this.client.testConnection();
  }

  // Get account information
  async getAccountInfo() {
    return await this.client.getAccountInfo();
  }

  // Get API usage statistics  
  async getApiUsage(period = 'daily') {
    return await this.client.getApiUsage(period);
  }

  // Get comprehensive meeting analytics
  async getMeetingAnalytics(options = {}) {
    const {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate = new Date(),
      includeSchedulingStats = true,
      includeTrends = true,
      groupBy = 'week'
    } = options;

    try {
      console.log('📊 Fetching HubSpot meeting analytics...');
      
      const results = await Promise.allSettled([
        this.meetings.getMeetingStats({ startDate, endDate }),
        includeSchedulingStats ? this.meetings.getSchedulingPageStats({ startDate, endDate }) : null,
        includeTrends ? this.meetings.getMeetingTrends({ startDate, endDate, groupBy }) : null
      ]);

      const [statsResult, schedulingResult, trendsResult] = results;

      const analytics = {
        dateRange: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        },
        meetingStats: statsResult.status === 'fulfilled' ? statsResult.value : null,
        schedulingStats: schedulingResult?.status === 'fulfilled' ? schedulingResult.value : null,
        trends: trendsResult?.status === 'fulfilled' ? trendsResult.value : null,
        errors: []
      };

      // Collect any errors
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const errorTypes = ['meetingStats', 'schedulingStats', 'trends'];
          analytics.errors.push({
            type: errorTypes[index],
            error: result.reason.message
          });
        }
      });

      console.log('✅ Meeting analytics fetched successfully');
      return analytics;
    } catch (error) {
      console.error('❌ Failed to get meeting analytics:', error);
      throw error;
    }
  }

  // Get meeting performance summary
  async getMeetingPerformanceSummary(options = {}) {
    try {
      const analytics = await this.getMeetingAnalytics(options);
      const stats = analytics.meetingStats;
      
      if (!stats) {
        throw new Error('No meeting stats available');
      }

      const summary = {
        overview: {
          totalMeetings: stats.totalMeetings,
          avgDuration: Math.round(stats.avgDuration / (1000 * 60)), // Convert to minutes
          completionRate: this.calculateCompletionRate(stats.byOutcome),
          noShowRate: this.calculateNoShowRate(stats.byOutcome)
        },
        outcomes: stats.byOutcome,
        monthlyTrends: stats.byMonth,
        topPerformers: await this.getTopPerformers(stats.meetings),
        insights: this.generateInsights(stats, analytics.trends)
      };

      if (analytics.schedulingStats) {
        summary.scheduling = {
          totalViews: analytics.schedulingStats.totalViews,
          totalBookings: analytics.schedulingStats.totalBookings,
          conversionRate: analytics.schedulingStats.conversionRate,
          avgDuration: analytics.schedulingStats.avgDuration
        };
      }

      return summary;
    } catch (error) {
      console.error('❌ Failed to generate performance summary:', error);
      throw error;
    }
  }

  // Calculate completion rate from outcomes
  calculateCompletionRate(outcomes) {
    const total = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
    const completed = outcomes.COMPLETED || 0;
    return total > 0 ? Math.round((completed / total) * 100) : 0;
  }

  // Calculate no-show rate from outcomes
  calculateNoShowRate(outcomes) {
    const total = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
    const noShows = outcomes.NO_SHOW || 0;
    return total > 0 ? Math.round((noShows / total) * 100) : 0;
  }

  // Get top performing users/owners
  async getTopPerformers(meetings) {
    const ownerStats = {};
    
    meetings.forEach(meeting => {
      const owner = meeting.owner || 'Unknown';
      if (!ownerStats[owner]) {
        ownerStats[owner] = {
          owner,
          totalMeetings: 0,
          completed: 0,
          cancelled: 0,
          noShow: 0
        };
      }
      
      ownerStats[owner].totalMeetings++;
      
      switch (meeting.outcome) {
        case 'COMPLETED':
          ownerStats[owner].completed++;
          break;
        case 'CANCELLED':
          ownerStats[owner].cancelled++;
          break;
        case 'NO_SHOW':
          ownerStats[owner].noShow++;
          break;
      }
    });

    // Calculate completion rates and sort
    return Object.values(ownerStats)
      .map(stats => ({
        ...stats,
        completionRate: stats.totalMeetings > 0 ? 
          Math.round((stats.completed / stats.totalMeetings) * 100) : 0
      }))
      .sort((a, b) => b.completionRate - a.completionRate)
      .slice(0, 10); // Top 10 performers
  }

  // Generate insights from the data
  generateInsights(stats, trends) {
    const insights = [];
    
    // Meeting volume insight
    if (stats.totalMeetings > 0) {
      insights.push({
        type: 'volume',
        message: `Analyzed ${stats.totalMeetings} meetings`,
        value: stats.totalMeetings
      });
    }

    // Completion rate insight
    const completionRate = this.calculateCompletionRate(stats.byOutcome);
    if (completionRate > 0) {
      const benchmark = 75; // Industry benchmark
      insights.push({
        type: 'completion',
        message: completionRate >= benchmark ? 
          `Strong completion rate of ${completionRate}%` :
          `Completion rate of ${completionRate}% below ${benchmark}% benchmark`,
        value: completionRate,
        benchmark
      });
    }

    // Trend insight
    if (trends && trends.length > 1) {
      const recent = trends.slice(-4); // Last 4 periods
      const avgRecent = recent.reduce((sum, t) => sum + t.count, 0) / recent.length;
      const earlier = trends.slice(0, 4); // First 4 periods
      const avgEarlier = earlier.reduce((sum, t) => sum + t.count, 0) / earlier.length;
      
      if (avgRecent > avgEarlier * 1.1) {
        insights.push({
          type: 'trend',
          message: 'Meeting volume trending upward',
          value: Math.round(((avgRecent - avgEarlier) / avgEarlier) * 100)
        });
      } else if (avgRecent < avgEarlier * 0.9) {
        insights.push({
          type: 'trend',
          message: 'Meeting volume trending downward', 
          value: Math.round(((avgEarlier - avgRecent) / avgEarlier) * 100)
        });
      }
    }

    return insights;
  }

  // Export meeting data for analysis
  async exportMeetingData(options = {}) {
    const {
      format = 'json',
      startDate,
      endDate,
      includeContacts = false
    } = options;

    try {
      const analytics = await this.getMeetingAnalytics({ startDate, endDate });
      
      if (format === 'csv') {
        return this.convertToCSV(analytics.meetingStats.meetings);
      }
      
      return analytics;
    } catch (error) {
      console.error('❌ Failed to export meeting data:', error);
      throw error;
    }
  }

  // Convert meeting data to CSV format
  convertToCSV(meetings) {
    const headers = [
      'id', 'title', 'timestamp', 'owner', 'outcome', 
      'duration', 'location', 'source', 'contacts_count'
    ];
    
    const rows = meetings.map(meeting => [
      meeting.id,
      meeting.title,
      new Date(meeting.timestamp).toISOString(),
      meeting.owner,
      meeting.outcome,
      meeting.endTime && meeting.startTime ? 
        Math.round((meeting.endTime - meeting.startTime) / (1000 * 60)) : '',
      meeting.location || '',
      meeting.source || '',
      meeting.contacts.length
    ]);

    return [headers, ...rows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');
  }
}