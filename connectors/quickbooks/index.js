import axios from 'axios';
import dotenv from 'dotenv';
import { BaseConnector } from '../MCPAdapter.js';

// Load environment variables from env.local
dotenv.config({ path: 'env.local' });

/**
 * QuickBooks Direct API Connector
 * Calls QuickBooks Online API directly using OAuth2 credentials
 */
export class QuickBooksConnector extends BaseConnector {
  constructor() {
    super('QuickBooks');
    this.clientId = process.env.QUICKBOOKS_CLIENT_ID;
    this.clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
    this.environment = process.env.QUICKBOOKS_ENVIRONMENT || 'Production';
    this.accessToken = null;
    this.companyId = null;
    this.baseUrl = this.environment.toLowerCase() === 'production'
      ? 'https://quickbooks.api.intuit.com'  // Production API
      : 'https://sandbox-quickbooks.api.intuit.com'; // Sandbox API
  }

  async initialize() {
    console.log(`[QuickBooks] Initializing direct API connector...`);
    // Load OAuth tokens from environment
    this.accessToken = process.env.QUICKBOOKS_ACCESS_TOKEN;
    this.companyId = process.env.QUICKBOOKS_COMPANY_ID;

    if (!this.accessToken || !this.companyId) {
      throw new Error('QuickBooks OAuth tokens not found. Run: node connectors/quickbooks/token-refresh.js');
    }

    console.log(`[QuickBooks] ✅ OAuth tokens loaded successfully`);
    console.log(`[QuickBooks] Company ID: ${this.companyId}`);
    console.log(`[QuickBooks] Access token: ${this.accessToken.slice(0, 20)}...`);
    console.log(`[QuickBooks] Direct API connector initialized`);
  }

  async getTools() {
    return [
      {
        name: 'quickbooks_get_company_info',
        description: 'Get basic company information from QuickBooks',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'quickbooks_list_customers',
        description: 'List customers from QuickBooks',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of customers to return',
              default: 20,
            },
          },
        },
      },
      {
        name: 'quickbooks_list_items',
        description: 'List items/services from QuickBooks',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of items to return',
              default: 20,
            },
          },
        },
      },
      {
        name: 'quickbooks_list_invoices',
        description: 'List invoices from QuickBooks',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of invoices to return',
              default: 20,
            },
            startDate: {
              type: 'string',
              description: 'Start date for invoice filter (YYYY-MM-DD)',
            },
            endDate: {
              type: 'string',
              description: 'End date for invoice filter (YYYY-MM-DD)',
            },
          },
        },
      },
      {
        name: 'quickbooks_profit_loss_report',
        description: 'Get Profit & Loss report from QuickBooks',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: {
              type: 'string',
              description: 'Start date for P&L report (YYYY-MM-DD)',
            },
            endDate: {
              type: 'string',
              description: 'End date for P&L report (YYYY-MM-DD)',
            },
            summarizeColumnBy: {
              type: 'string',
              description: 'How to summarize columns (Day, Month, Quarter, Year)',
              enum: ['Day', 'Month', 'Quarter', 'Year'],
              default: 'Month'
            }
          },
        },
      },
      {
        name: 'quickbooks_generic_query',
        description: 'Execute any QuickBooks API call with custom endpoint and parameters',
        inputSchema: {
          type: 'object',
          properties: {
            endpoint: {
              type: 'string',
              description: 'API endpoint (e.g., "reports/BalanceSheet", "query", "items/123")',
            },
            query: {
              type: 'string',
              description: 'SQL-like query for query endpoint (e.g., "SELECT * FROM Employee")',
            },
            parameters: {
              type: 'object',
              description: 'Additional query parameters as key-value pairs',
            }
          },
          required: ['endpoint']
        },
      },
      {
        name: 'quickbooks_create_customer',
        description: 'Create a new customer in QuickBooks',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: {
              type: 'string',
              description: 'Customer first name',
            },
            lastName: {
              type: 'string',
              description: 'Customer last name',
            },
            email: {
              type: 'string',
              description: 'Customer email address (optional)',
            },
            phone: {
              type: 'string',
              description: 'Customer phone number (optional)',
            },
            address: {
              type: 'string',
              description: 'Customer address (optional)',
            },
          },
          required: ['firstName', 'lastName']
        },
      },
      {
        name: 'quickbooks_update_customer',
        description: 'Update an existing customer in QuickBooks',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: {
              type: 'string',
              description: 'QuickBooks customer ID',
            },
            email: {
              type: 'string',
              description: 'New email address (optional)',
            },
            displayName: {
              type: 'string',
              description: 'New display name (optional)',
            },
          },
          required: ['customerId']
        },
      },
    ];
  }

  async canHandleTool(toolName) {
    return toolName.startsWith('quickbooks_');
  }

  async handleTool(toolName, args) {
    try {
      // Handle customer creation
      if (toolName === 'quickbooks_create_customer') {
        const result = await this.createCustomer(args);
        return this.formatResponse(result);
      }

      // Handle customer update
      if (toolName === 'quickbooks_update_customer') {
        const { customerId, ...updates } = args;
        const result = await this.updateCustomer(customerId, updates);
        return this.formatResponse(result);
      }

      let operation = this.mapToolToOperation(toolName);

      // Handle P&L report parameters
      let params = {};
      if (toolName === 'quickbooks_profit_loss_report') {
        if (args.startDate) params.start_date = args.startDate;
        if (args.endDate) params.end_date = args.endDate;
        if (args.summarizeColumnBy) params.summarize_column_by = args.summarizeColumnBy;
      }

      // Handle generic query
      if (toolName === 'quickbooks_generic_query') {
        if (args.query) {
          operation = 'query';
          params.query = args.query;
        } else {
          operation = args.endpoint;
        }
        if (args.parameters) {
          params = { ...params, ...args.parameters };
        }
      }

      const result = await this.callQuickBooksAPI(operation, params);

      return this.formatResponse(result);
    } catch (error) {
      console.error(`[QuickBooks] Error handling ${toolName}:`, error);
      return this.formatError(error);
    }
  }

  mapToolToOperation(toolName) {
    const operationMap = {
      'quickbooks_get_company_info': 'companyinfo/1',
      'quickbooks_list_customers': 'query?query=SELECT * FROM Customer',
      'quickbooks_list_items': 'query?query=SELECT * FROM Item',
      'quickbooks_list_invoices': 'query?query=SELECT * FROM Invoice',
      'quickbooks_profit_loss_report': 'reports/ProfitAndLoss',
    };

    return operationMap[toolName] || toolName.replace('quickbooks_', '');
  }

  async callQuickBooksAPI(operation, parameters = {}) {
    console.log(`[QuickBooks] Calling ${operation} API with:`, parameters);

    const url = `${this.baseUrl}/v3/company/${this.companyId}/${operation}`;
    console.log(`[QuickBooks] Making API request to: ${url}`);

    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json'
        },
        params: parameters
      });

      console.log(`[QuickBooks] API response status: ${response.status}`);
      return response.data;

    } catch (error) {
      console.error(`[QuickBooks] API call failed:`, error.message);
      console.error(`[QuickBooks] Response status:`, error.response?.status);
      console.error(`[QuickBooks] Response data:`, error.response?.data);

      if (error.response?.status === 401) {
        throw new Error('QuickBooks access token expired. Run: node connectors/quickbooks/token-refresh.js');
      }

      throw error;
    }
  }

  // Direct query method for sync scripts
  async query(sqlQuery) {
    console.log(`[QuickBooks] Calling query API with:`, { query: sqlQuery });

    const url = `${this.baseUrl}/v3/company/${this.companyId}/query`;
    console.log(`[QuickBooks] Making API request to: ${url}`);

    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json'
        },
        params: { query: sqlQuery }
      });

      console.log(`[QuickBooks] API response status: ${response.status}`);
      return response.data;

    } catch (error) {
      console.error(`[QuickBooks] API call failed:`, error.message);
      console.error(`[QuickBooks] Response status:`, error.response?.status);
      console.error(`[QuickBooks] Response data:`, error.response?.data);

      if (error.response?.status === 401) {
        throw new Error('QuickBooks access token expired. Run: node connectors/quickbooks/token-refresh.js');
      }

      throw error;
    }
  }

  /**
   * Create an invoice in QuickBooks
   */
  async createInvoice(invoiceData) {
    const { customerId, amount, txnDate, description, itemId } = invoiceData;

    console.log(`[QuickBooks] Creating invoice for customer ${customerId}, amount ${amount}`);

    // If no itemId provided, get the first active service item
    let lineItemId = itemId;
    if (!lineItemId) {
      const itemsQuery = await this.query("SELECT Id, Name FROM Item WHERE Active = true AND Type = 'Service' MAXRESULTS 1");
      if (itemsQuery.QueryResponse?.Item?.[0]) {
        lineItemId = itemsQuery.QueryResponse.Item[0].Id;
        console.log(`[QuickBooks] Using service item ID ${lineItemId}`);
      } else {
        throw new Error('No active service items found in QuickBooks. Please specify an itemId.');
      }
    }

    const invoice = {
      Line: [
        {
          Amount: amount,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: {
            ItemRef: {
              value: lineItemId
            },
            Qty: 1,
            UnitPrice: amount
          },
          Description: description
        }
      ],
      CustomerRef: {
        value: customerId
      },
      TxnDate: txnDate
    };

    const url = `${this.baseUrl}/v3/company/${this.companyId}/invoice`;

    try {
      const response = await axios.post(url, invoice, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      console.log(`[QuickBooks] ✅ Invoice created successfully: ${response.data.Invoice.Id}`);
      return response.data.Invoice;

    } catch (error) {
      console.error(`[QuickBooks] Failed to create invoice:`, error.message);
      console.error(`[QuickBooks] Response:`, error.response?.data);

      if (error.response?.status === 401) {
        throw new Error('QuickBooks access token expired. Run: node connectors/quickbooks/token-refresh.js');
      }

      throw error;
    }
  }

  /**
   * Create a payment in QuickBooks and apply it to an invoice
   */
  async createPayment(paymentData) {
    const { customerId, amount, txnDate, invoiceId } = paymentData;

    console.log(`[QuickBooks] Creating payment for customer ${customerId}, amount ${amount}, invoice ${invoiceId}`);

    const payment = {
      CustomerRef: {
        value: customerId
      },
      TotalAmt: amount,
      TxnDate: txnDate,
      Line: [
        {
          Amount: amount,
          LinkedTxn: [
            {
              TxnId: invoiceId,
              TxnType: 'Invoice'
            }
          ]
        }
      ]
    };

    const url = `${this.baseUrl}/v3/company/${this.companyId}/payment`;

    try {
      const response = await axios.post(url, payment, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      console.log(`[QuickBooks] ✅ Payment created successfully: ${response.data.Payment.Id}`);
      return response.data.Payment;

    } catch (error) {
      console.error(`[QuickBooks] Failed to create payment:`, error.message);
      console.error(`[QuickBooks] Response:`, error.response?.data);

      if (error.response?.status === 401) {
        throw new Error('QuickBooks access token expired. Run: node connectors/quickbooks/token-refresh.js');
      }

      throw error;
    }
  }

  /**
   * Create a new customer in QuickBooks
   */
  async createCustomer(customerData) {
    const { firstName, lastName, email, phone, address } = customerData;

    const payload = {
      DisplayName: `${firstName} ${lastName}`,
      GivenName: firstName,
      FamilyName: lastName
    };

    if (email) {
      payload.PrimaryEmailAddr = { Address: email };
    }

    if (phone) {
      payload.PrimaryPhone = { FreeFormNumber: phone };
    }

    if (address) {
      if (typeof address === 'string') {
        payload.BillAddr = { Line1: address };
      } else {
        payload.BillAddr = {};
        if (address.line1) payload.BillAddr.Line1 = address.line1;
        if (address.city) payload.BillAddr.City = address.city;
        if (address.state) payload.BillAddr.CountrySubDivisionCode = address.state;
        if (address.zip) payload.BillAddr.PostalCode = address.zip;
      }
    }

    console.log('[QuickBooks] Creating customer:', payload.DisplayName);

    const url = `${this.baseUrl}/v3/company/${this.companyId}/customer`;

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      console.log('[QuickBooks] ✅ Customer created successfully');
      console.log('[QuickBooks] Customer ID:', response.data.Customer.Id);

      return response.data.Customer;

    } catch (error) {
      console.error('[QuickBooks] Failed to create customer:', error.message);
      if (error.response?.data) {
        console.error('[QuickBooks] Error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Update a customer in QuickBooks
   */
  async updateCustomer(customerId, updates) {
    console.log(`[QuickBooks] Updating customer ${customerId}:`, updates);

    const customerQuery = await this.query(`SELECT * FROM Customer WHERE Id = '${customerId}'`);
    const customer = customerQuery.QueryResponse?.Customer?.[0];

    if (!customer) {
      throw new Error(`Customer ${customerId} not found`);
    }

    const updateData = {
      Id: customerId,
      SyncToken: customer.SyncToken,
      sparse: true
    };

    if (updates.email) {
      updateData.PrimaryEmailAddr = { Address: updates.email };
    }

    if (updates.displayName) {
      updateData.DisplayName = updates.displayName;
    }

    const url = `${this.baseUrl}/v3/company/${this.companyId}/customer`;

    try {
      const response = await axios.post(url, updateData, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      console.log(`[QuickBooks] ✅ Customer updated successfully`);
      return response.data.Customer;

    } catch (error) {
      console.error(`[QuickBooks] Failed to update customer:`, error.message);

      if (error.response?.status === 401) {
        throw new Error('QuickBooks access token expired. Run: node connectors/quickbooks/token-refresh.js');
      }

      throw error;
    }
  }

  /**
   * Get a QuickBooks report
   */
  async getReport(reportName, params = {}) {
    console.log(`[QuickBooks] Getting ${reportName} report with params:`, params);
    return await this.callQuickBooksAPI(`reports/${reportName}`, params);
  }

  /**
   * Get Balance Sheet report
   */
  async getBalanceSheet(date, accountingMethod = 'Accrual') {
    console.log(`[QuickBooks] Getting Balance Sheet for ${date} (${accountingMethod})`);
    return await this.getReport('BalanceSheet', {
      start_date: '2020-01-01',
      end_date: date,
      accounting_method: accountingMethod
    });
  }

  async cleanup() {
    console.log(`[QuickBooks] Cleaning up direct API connector`);
    this.accessToken = null;
    this.companyId = null;
  }
}
