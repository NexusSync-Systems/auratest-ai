import { sendSlackNotification } from './slack-notifier.js';
import dotenv from 'dotenv';
dotenv.config();

async function runTest() {
  const channel = process.env.SLACK_CHANNEL || '#general';
  
  const complianceToken = process.env.SLACK_COMPLIANCE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  const uptimeToken = process.env.SLACK_UPTIME_BOT_TOKEN;

  if (!complianceToken && !uptimeToken) {
    console.error('❌ CHYBA: Nemáte definovaný žádný SLACK_BOT_TOKEN v souboru .env');
    return;
  }

  console.log(`🚀 Spouštím testovací Slack zprávy pro kanál: ${channel}...\n`);

  // Test 1: Compliance Bot
  if (complianceToken) {
    console.log('🤖 Testuji AuraGuard Compliance bota...');
    const complianceBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Nová zranitelnost detekována!*\nKnihovna `axios` verze 1.6.0 obsahuje CVE-2024-1234.' }
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Zobrazit report', emoji: true }, style: 'primary', value: 'report_cve' }
        ]
      }
    ];
    const success1 = await sendSlackNotification(channel, 'AuraGuard Compliance Test', 'Byl detekován bezpečnostní problém.', true, complianceBlocks, 'compliance');
    if (success1) console.log('✅ Zpráva od Compliance bota úspěšně odeslána!');
    else console.log('❌ Odeslání zprávy (compliance) selhalo.');
  } else {
    console.log('⚠️ Compliance token chybí, přeskakuji...');
  }

  // Test 2: Uptime Bot
  if (uptimeToken) {
    console.log('\n🤖 Testuji AuraGuard Uptime bota...');
    const uptimeBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Výpadek produkčního webu!*\nStránka `https://auraguard.eu` vrací status 503.' }
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Zkontrolovat znovu', emoji: true }, style: 'danger', value: 'recheck_uptime' }
        ]
      }
    ];
    const success2 = await sendSlackNotification(channel, 'AuraGuard Uptime Test', 'Web neodpovídá!', true, uptimeBlocks, 'uptime');
    if (success2) console.log('✅ Zpráva od Uptime bota úspěšně odeslána!');
    else console.log('❌ Odeslání zprávy (uptime) selhalo.');
  } else {
    console.log('\n⚠️ Uptime token chybí, přeskakuji...');
  }
}

runTest();
