import {
  Layers, ArrowRight, Shield, Activity, Cpu, Cookie,
  AlertTriangle, Globe, MessageSquare,
} from 'lucide-react';

/**
 * Katalog typů testů zobrazený v UI. Vytaženo z App.jsx, kde tvořil
 * ~50 řádků dat uprostřed komponenty.
 */
export const TEST_TYPES = [
  { id: 'all_in_one', label: 'Komplexní Full-Stack Audit (Vše)', icon: Layers, color: '#f59e0b', desc: 'Spustí všechny dostupné audity současně (Přístupnost, NIS2, Green Deal & GDPR, CRA SBOM a Zranitelnosti, DORA, AI Act, Cookies a HTTP dostupnost).' },
  { id: 'agent', label: 'Obecný AI QA Agent', icon: ArrowRight, color: 'var(--accent)', desc: 'Standardní funkční testování aplikace pomocí AI. Agent prokliká UI podle vašeho zadání jako skutečný uživatel a nahlásí případné chyby.' },
  { id: 'eaa', label: 'EAA (Evropský akt o přístupnosti)', icon: Shield, color: 'var(--accent)', desc: 'Zkontroluje web podle standardu WCAG. Hledá problémy pro zrakově či tělesně postižené (kontrast, aria atributy, navigace přes klávesnici).' },
  { id: 'nis2', label: 'NIS2 & PQC', icon: Shield, color: '#10b981', desc: 'Audit kybernetické bezpečnosti. Kontroluje zabezpečení komunikace, kryptografii a základní požadavky na bezpečnost dle směrnice NIS2.' },
  { id: 'green', label: 'Green Deal & GDPR', icon: Shield, color: '#059669', desc: 'Měří energetickou náročnost sítě, velikost přenášených dat (uhlíková stopa) a úniky citlivých PII dat mimo EU servery.' },
  { id: 'cra_sbom', label: 'CRA SBOM', icon: Shield, color: '#4f46e5', desc: 'Cyber Resilience Act (CRA) - generuje a kontroluje softwarový kusovník (SBOM) a mapuje knihovny na frontendové vrstvě.' },
  { id: 'dora', label: 'DORA Chaos', icon: Activity, color: '#f43f5e', desc: 'Zátěžové testování (Chaos Engineering) dle DORA. Zkouší, jak aplikace reaguje na zpomalení sítě či výpadky požadavků.' },
  { id: 'ai_act', label: 'EU AI Act Scanner', icon: Cpu, color: '#8b5cf6', desc: 'Analyzuje, zda web využívá prvky umělé inteligence, a ověřuje splnění transparečních požadavků dle nového EU AI Act.' },
  { id: 'cookies', label: 'GDPR Striktní Cookies', icon: Cookie, color: '#10b981', desc: 'Kontroluje, zda se před udělením aktivního souhlasu s cookies (cookie lišta) nenačítají analytické či marketingové skripty.' },
  { id: 'cve', label: 'CRA Zranitelnosti (CVE)', icon: AlertTriangle, color: '#ef4444', desc: 'Vyhledá ve frontendových knihovnách na webu známé bezpečnostní zranitelnosti z databáze CVE.' },
  { id: 'http_page', label: 'Test Dostupnosti (HTTP)', icon: Globe, color: '#2563eb', desc: 'Ověří HTTP dostupnost stránky zvenčí (status 200 OK), dobu odezvy a funkčnost SSL certifikátů.' },
  { id: 'http_form', label: 'Test Formuláře (HTTP)', icon: MessageSquare, color: '#059669', desc: 'Zkusí programově odeslat data do formuláře (pokud je podporován) a ověří, zda API správně odpovídá.' },
];

export const IMPACT_COLORS = {
  minor: '#fcd34d',
  moderate: '#f97316',
  serious: '#ef4444',
  critical: '#991b1b',
};

export const IMPACT_TRANSLATIONS = {
  minor: 'Nízký dopad',
  moderate: 'Střední dopad',
  serious: 'Vážný problém',
  critical: 'Kritická chyba',
};

/** České popisy axe pravidel zobrazované v reportu přístupnosti. */
export const RULE_TRANSLATIONS = {
  'color-contrast': 'Nedostatečný kontrast barev',
  'image-alt': 'Obrázku chybí alternativní text',
  'button-name': 'Tlačítko nemá popisek pro čtečky',
  'link-name': 'Odkazu chybí textový obsah',
  'document-title': 'Stránka nemá titulek (<title>)',
  'html-has-lang': 'Stránce chybí definice jazyka (lang)',
  'label': 'Formulářový prvek nemá přiřazený popisek',
  'page-has-heading-one': 'Chybí hlavní nadpis <h1>',
  'region': 'Obsah stránky není obalen v oblastech (landmarks)',
  'landmark-one-main': 'Stránka musí mít přesně jednu hlavní oblast <main>',
  'heading-order': 'Nadpisy nejdou logicky po sobě (např. chybí H2)',
};
