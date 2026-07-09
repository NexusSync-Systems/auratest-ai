import fetch from 'node-fetch';

/**
 * Odešle upozornění do Slacku pomocí Incoming Webhooku.
 * Používá Slack Block Kit pro strukturované zobrazení.
 * 
 * @param {string} webhookUrl - Konfigurovaná Slack Webhook URL
 * @param {string} title - Nadpis zprávy
 * @param {string} message - Detail zprávy
 * @param {boolean} isError - Zda jde o chybu (červená barva) nebo info (zelená)
 * @param {Array} blocks - Volitelné další bloky (Slack Block Kit)
 */
export async function sendSlackNotification(webhookUrl, title, message, isError = true, extraBlocks = []) {
  if (!webhookUrl) {
    console.warn('⚠️ SLACK_WEBHOOK_URL není definována, přeskočeno odesílání upozornění.');
    return false;
  }

  const color = isError ? '#ef4444' : '#10b981';
  const emoji = isError ? '🚨' : '✅';

  const payload = {
    text: `${emoji} ${title}`, // Fallback pro push notifikaci
    attachments: [
      {
        color: color,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `${emoji} ${title}`,
              emoji: true
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: message
            }
          },
          ...extraBlocks
        ]
      }
    ]
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`Chyba při odesílání do Slacku. Status: ${response.status}`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Chyba spojení při odesílání Slack Webhooku:', error.message);
    return false;
  }
}
