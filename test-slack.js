import { sendSlackNotification } from './slack-notifier.js';
import dotenv from 'dotenv';
dotenv.config();

async function runTest() {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.error('❌ CHYBA: Nemáte definovanou proměnnou SLACK_WEBHOOK_URL v souboru .env');
    console.error('Vytvořte v této složce soubor .env s obsahem: SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...');
    process.exit(1);
  }

  console.log('Odesílám testovací zprávu na Slack...');
  
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
    webhookUrl,
    'AuraGuard: Úspěšný test integrace',
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
