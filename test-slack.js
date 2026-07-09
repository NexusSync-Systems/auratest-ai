import { sendSlackNotification } from './slack-notifier.js';
import dotenv from 'dotenv';
dotenv.config();

async function runTest() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL || '#general';
  
  if (!token) {
    console.error('❌ CHYBA: Nemáte definovanou proměnnou SLACK_BOT_TOKEN v souboru .env');
    console.error('Vytvořte v této složce soubor .env s obsahem: SLACK_BOT_TOKEN=xoxb-... (a volitelně SLACK_CHANNEL=#vas-kanal)');
    process.exit(1);
  }

  console.log(`Odesílám testovací zprávu na Slack (do kanálu ${channel})...`);
  
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*AuraGuard Slack Integrace funguje na výbornou!* 🎉\nTato zpráva potvrzuje, že CI/CD nástroj a monitorovací služba mohou od nynějška úspěšně zasílat upozornění.'
      }
    }
  ];

  const success = await sendSlackNotification(
    channel,
    'AuraGuard: Úspěšný test integrace (Bot API)',
    'Integrace Slacku proběhla v pořádku.',
    false, // false = green color (info), true = red (error)
    blocks
  );

  if (success) {
    console.log('✅ Zpráva byla úspěšně odeslána. Zkontrolujte svůj Slack!');
  } else {
    console.log('❌ Odeslání zprávy selhalo. Zkontrolujte prosím správnost vaší Webhook URL.');
  }
}

runTest();
