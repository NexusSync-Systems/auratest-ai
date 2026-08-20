// Pozn.: dřív se importoval `node-fetch`, který ale NENÍ v package.json —
// fungovalo to jen díky hoistingu tranzitivní závislosti firebase-admin.
// Node 18+ má fetch globálně.

/**
 * Odešle upozornění do Slacku pomocí Slack Bot API (chat.postMessage).
 * 
 * @param {string} channel - Název nebo ID kanálu (např. "#devops-alerts")
 * @param {string} title - Nadpis zprávy
 * @param {string} message - Detail zprávy
 * @param {boolean} isError - Zda jde o chybu (červená barva) nebo info (zelená)
 * @param {Array} extraBlocks - Volitelné další bloky (Slack Block Kit)
 * @param {string} botType - Typ bota ('compliance', 'uptime', 'ai')
 */
export async function sendSlackNotification(channel, title, message, isError = true, extraBlocks = [], botType = 'compliance') {
  let token = process.env.SLACK_BOT_TOKEN; // Fallback for backwards compatibility

  if (botType === 'uptime') token = process.env.SLACK_UPTIME_BOT_TOKEN;
  else if (botType === 'compliance') token = process.env.SLACK_COMPLIANCE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  else if (botType === 'ai') token = process.env.SLACK_AI_BOT_TOKEN || process.env.SLACK_COMPLIANCE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  
  if (!token) {
    console.warn(`⚠️ Slack Token pro bota '${botType}' není definován, přeskočeno odesílání upozornění.`);
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
      // Bez timeoutu mohl CLI v CI viset donekonečna.
      signal: AbortSignal.timeout(10000),
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
