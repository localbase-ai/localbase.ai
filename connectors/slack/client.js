/**
 * Slack Webhook Client
 * Posts messages to Slack via Incoming Webhook
 */
export class SlackClient {
  constructor(webhookUrl) {
    if (!webhookUrl) {
      throw new Error('SLACK_WEBHOOK_URL is required');
    }
    this.webhookUrl = webhookUrl;
  }

  async post(payload) {
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Slack webhook failed: ${response.status} ${text}`);
    }

    return true;
  }

  async sendMessage(text) {
    return this.post({ text });
  }

  async sendBlocks(blocks, text = '') {
    return this.post({ text, blocks });
  }
}
