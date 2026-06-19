import { describe, it, expect } from 'vitest';
import { AlertMetrics, evaluateAlert, metricValue } from '../src/services/alertEngine';

const metrics: AlertMetrics = {
  price: 150,
  changePct: 3.2,
  relVol: 2.5,
  rsi: 72,
  maSpreadPct: 1.4,
  pctFromHigh52: -5,
  pctFromLow52: 40,
  optMark: 3.2,
  optBid: 3.1,
  optAsk: 3.3,
  optDelta: 0.45,
  optIv: 42,
};

describe('metricValue', () => {
  it('selects the right metric per kind', () => {
    expect(metricValue('price', metrics)).toBe(150);
    expect(metricValue('change', metrics)).toBe(3.2);
    expect(metricValue('relvol', metrics)).toBe(2.5);
    expect(metricValue('rsi', metrics)).toBe(72);
  });

  it('selects option-contract metrics', () => {
    expect(metricValue('optmark', metrics)).toBe(3.2);
    expect(metricValue('optbid', metrics)).toBe(3.1);
    expect(metricValue('optask', metrics)).toBe(3.3);
    expect(metricValue('optdelta', metrics)).toBe(0.45);
    expect(metricValue('optiv', metrics)).toBe(42);
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

  it('triggers on an option contract metric and names the contract via subject', () => {
    const ev = evaluateAlert(
      'AAPL',
      { kind: 'optmark', operator: 'above', threshold: 3.0 },
      metrics,
      'AAPL 150C 2026-07-17',
    );
    expect(ev.triggered).toBe(true);
    expect(ev.value).toBe(3.2);
    expect(ev.message).toContain('AAPL 150C 2026-07-17');
    expect(ev.message).toContain('option mark');
    expect(ev.message).toContain('$3.20');
  });

  it('formats IV as a percent and delta as a 2dp number', () => {
    const iv = evaluateAlert('AAPL', { kind: 'optiv', operator: 'above', threshold: 40 }, metrics, 'AAPL 150C');
    expect(iv.message).toContain('42%');
    const delta = evaluateAlert('AAPL', { kind: 'optdelta', operator: 'below', threshold: 0.5 }, metrics, 'AAPL 150C');
    expect(delta.triggered).toBe(true);
    expect(delta.message).toContain('0.45');
  });
});
