/**
 * Base Connector Class
 * All connectors should extend this class
 */
export class BaseConnector {
  constructor(name) {
    this.name = name;
  }

  /**
   * Get list of tools this connector provides
   * @returns {Array} Array of tool definitions
   */
  async getTools() {
    throw new Error('getTools() must be implemented by connector');
  }

  /**
   * Check if this connector can handle a specific tool
   * @param {string} toolName 
   * @returns {boolean}
   */
  async canHandleTool(toolName) {
    return false;
  }

  /**
   * Handle a tool request
   * @param {string} toolName 
   * @param {object} args 
   * @returns {object} MCP response
   */
  async handleTool(toolName, args) {
    throw new Error('handleTool() must be implemented by connector');
  }

  /**
   * Initialize the connector (optional)
   * Called when the connector is loaded
   */
  async initialize() {
    // Override if needed
  }

  /**
   * Cleanup resources (optional)
   * Called when the connector is unloaded
   */
  async cleanup() {
    // Override if needed
  }

  /**
   * Format MCP response
   * @param {*} data 
   * @param {string} type 
   * @returns {object}
   */
  formatResponse(data, type = 'text') {
    return {
      content: [
        {
          type,
          text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  /**
   * Format error response
   * @param {Error} error 
   * @returns {object}
   */
  formatError(error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error in ${this.name}: ${error.message}`,
        },
      ],
    };
  }
}