import { describe, it, expect } from 'vitest';
import { AlertMetrics, evaluateAlert, metricValue } from '../src/services/alertEngine';

const metrics: AlertMetrics = { price: 150, changePct: 3.2, relVol: 2.5, rsi: 72 };

describe('metricValue', () => {
  it('selects the right metric per kind', () => {
    expect(metricValue('price', metrics)).toBe(150);
    expect(metricValue('change', metrics)).toBe(3.2);
    expect(metricValue('relvol', metrics)).toBe(2.5);
    expect(metricValue('rsi', metrics)).toBe(72);
  });
});

describe('evaluateAlert', () => {
  it('triggers when price is above the threshold', () => {
    const ev = evaluateAlert('AAPL', { kind: 'price', operator: 'above', threshold: 145 }, metrics);
    expect(ev.triggered).toBe(true);
    expect(ev.value).toBe(150);
    expect(ev.message).toContain('AAPL');
    expect(ev.message).toContain('above');
  });

  it('does not trigger when below the above-threshold', () => {
    const ev = evaluateAlert('AAPL', { kind: 'price', operator: 'above', threshold: 200 }, metrics);
    expect(ev.triggered).toBe(false);
    expect(ev.message).toBeNull();
  });

  it('supports below + RSI', () => {
    const overbought = evaluateAlert('AAPL', { kind: 'rsi', operator: 'above', threshold: 70 }, metrics);
    expect(overbought.triggered).toBe(true);
    const oversold = evaluateAlert('AAPL', { kind: 'rsi', operator: 'below', threshold: 30 }, metrics);
    expect(oversold.triggered).toBe(false);
  });

  it('is not triggered when the metric is unavailable', () => {
    const ev = evaluateAlert('AAPL', { kind: 'rsi', operator: 'above', threshold: 70 }, { ...metrics, rsi: null });
    expect(ev.triggered).toBe(false);
    expect(ev.value).toBeNull();
  });
});
