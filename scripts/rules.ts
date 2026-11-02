// Rule switches for A/B balance runs (batch.ts / humanbench.ts --rule a,b=1,c=600). Every worker parses the same argv,
// so all games of a run use the same rules; a real game never calls this.
//   marketCapFixed, stackAdd   config GOLD_RULES (economy.goldIncome)
//   merchantMerc               the Merchant doctrine's gold bonus becomes mercenaries 30% cheaper (lever mercCost)
//   bankingScience=N           Banking costs N science
import { DOCTRINE_LEVERS, GOLD_RULES, TECHS } from '../src/sim/config';

/** Applies a --rule list; returns the labels for the report header. Exits on an unknown rule. */
export function applyRules(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const [key, raw] = item.split('=');
    const on = raw === undefined || raw === '1' || raw === 'true';
    if (key === 'merchantMerc') {
      if (on) Object.assign(DOCTRINE_LEVERS.merchant, { gold: 0, mercCost: 0.3 });
    } else if (key === 'bankingScience') {
      if (raw !== undefined && Number(raw) > 0) (TECHS.banking as { science: number }).science = Number(raw);
    } else if (key in GOLD_RULES) (GOLD_RULES as Record<string, boolean>)[key] = on;
    else {
      console.error(`Unknown rule ${key} (${Object.keys(GOLD_RULES).join(', ')}, merchantMerc, bankingScience=N)`);
      process.exit(1);
    }
    out.push(`${key}=${raw ?? 1}`);
  }
  return out;
}
