/**
 * HubSpot Contacts Management
 * Handles contact creation, updates, and search operations
 */
export class HubSpotContacts {
  constructor(client) {
    this.client = client;
  }

  /**
   * Create a new contact in HubSpot
   */
  async createContact(contactData) {
    const payload = {
      properties: {
        email: contactData.email,
        firstname: contactData.firstname,
        lastname: contactData.lastname,
        ...contactData.properties // Additional custom properties
      }
    };

    return await this.client.makeRequest('/crm/v3/objects/contacts', {
      method: 'POST',
      body: payload
    });
  }

  /**
   * Update an existing contact by ID
   */
  async updateContact(contactId, contactData) {
    const payload = {
      properties: {
        ...contactData.properties
      }
    };

    return await this.client.makeRequest(`/crm/v3/objects/contacts/${contactId}`, {
      method: 'PATCH',
      body: payload
    });
  }

  /**
   * Search for contacts by email
   */
  async findContactByEmail(email) {
    const response = await this.client.makeRequest('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'email',
                operator: 'EQ',
                value: email
              }
            ]
          }
        ],
        limit: 1
      }
    });

    return response.results?.[0] || null;
  }

  /**
   * Get contact by ID
   */
  async getContact(contactId) {
    return await this.client.makeRequest(`/crm/v3/objects/contacts/${contactId}`);
  }

  /**
   * Batch create or update contacts
   * Uses HubSpot's batch API for efficient processing
   */
  async batchUpsertContacts(contacts, batchSize = 100) {
    const results = [];
    
    // Process in batches
    for (let i = 0; i < contacts.length; i += batchSize) {
      const batch = contacts.slice(i, i + batchSize);
      const batchResults = await this.processBatch(batch);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Process a batch of contacts for upsert
   */
  async processBatch(contacts) {
    const inputs = contacts.map(contact => ({
      properties: {
        email: contact.email,
        firstname: contact.firstname,
        lastname: contact.lastname,
        ...contact.properties
      }
    }));

    return await this.client.makeRequest('/crm/v3/objects/contacts/batch/upsert', {
      method: 'POST',
      body: {
        inputs
      }
    });
  }

  /**
   * Append data to existing contacts
   * Finds contacts by email and updates them with new data
   */
  async appendContactData(contactDataList) {
    const results = [];

    for (const contactData of contactDataList) {
      try {
        // First, try to find existing contact
        const existingContact = await this.findContactByEmail(contactData.email);
        
        if (existingContact) {
          // Update existing contact
          const updatedContact = await this.updateContact(existingContact.id, contactData);
          results.push({
            email: contactData.email,
            action: 'updated',
            contactId: existingContact.id,
            success: true
          });
        } else {
          // Create new contact
          const newContact = await this.createContact(contactData);
          results.push({
            email: contactData.email,
            action: 'created',
            contactId: newContact.id,
            success: true
          });
        }
      } catch (error) {
        results.push({
          email: contactData.email,
          action: 'failed',
          error: error.message,
          success: false
        });
      }
    }

    return results;
  }

  /**
   * Get contacts with pagination
   */
  async getContacts(options = {}) {
    const {
      limit = 100,
      after,
      properties = ['email', 'firstname', 'lastname'],
      archived = false
    } = options;

    const params = {
      limit,
      properties: properties.join(','),
      archived
    };

    if (after) {
      params.after = after;
    }

    return await this.client.makeRequest('/crm/v3/objects/contacts', {
      params
    });
  }

  /**
   * Search contacts with filters
   */
  async searchContacts(searchOptions = {}) {
    const {
      filters = [],
      limit = 100,
      after,
      properties = ['email', 'firstname', 'lastname'],
      sorts = []
    } = searchOptions;

    const payload = {
      filterGroups: filters.length > 0 ? [{ filters }] : [],
      limit,
      properties,
      sorts
    };

    if (after) {
      payload.after = after;
    }

    return await this.client.makeRequest('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: payload
    });
  }

  /**
   * Delete a contact by ID
   */
  async deleteContact(contactId) {
    return await this.client.makeRequest(`/crm/v3/objects/contacts/${contactId}`, {
      method: 'DELETE'
    });
  }
} 