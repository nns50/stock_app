import { describe, it, expect } from 'vitest';
import { suggestedExitText } from '../src/services/optionAlertPlan';

describe('suggestedExitText', () => {
  it('renders the default take-profit / stop / time-exit plan with the expiry', () => {
    const text = suggestedExitText('2026-07-17');
    expect(text).toContain('take profit +50%');
    expect(text).toContain('stop −50%');
    expect(text).toContain('time-exit 7d before 2026-07-17');
  });

  it('includes a delta band when configured and omits unset rules', () => {
    const text = suggestedExitText(null, { takeProfitPct: 75, deltaMin: 0.2, deltaMax: 0.8 });
    expect(text).toContain('take profit +75%');
    expect(text).not.toContain('stop');
    expect(text).toContain('|Δ| leaves [0.2, 0.8]');
  });

  it('falls back to the word "expiry" for the time-exit clause when no date is given', () => {
    const text = suggestedExitText(null, { timeExitDaysBeforeExpiry: 5 });
    expect(text).toBe('time-exit 5d before expiry');
  });
});
