import fetch from 'node-fetch';

/**
 * Odešle upozornění do Slacku pomocí Slack Bot API (chat.postMessage).
 * 
 * @param {string} channel - Název nebo ID kanálu (např. "#devops-alerts")
 * @param {string} title - Nadpis zprávy
 * @param {string} message - Detail zprávy
 * @param {boolean} isError - Zda jde o chybu (červená barva) nebo info (zelená)
 * @param {Array} blocks - Volitelné další bloky (Slack Block Kit)
 */
export async function sendSlackNotification(channel, title, message, isError = true, extraBlocks = []) {
  const token = process.env.SLACK_BOT_TOKEN;
  
  if (!token) {
    console.warn('⚠️ SLACK_BOT_TOKEN není definována, přeskočeno odesílání upozornění.');
    return false;
  }

  const color = isError ? '#ef4444' : '#10b981';
  const emoji = isError ? '🚨' : '✅';

  const payload = {
    channel: channel,
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
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!data.ok) {
      console.error(`Chyba API při odesílání do Slacku: ${data.error}`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Chyba spojení při odesílání přes Slack API:', error.message);
    return false;
  }
}
