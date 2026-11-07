import { describe, expect, it } from 'vitest';
import { createSummaryValueMatcher, recoverSummaryQuote } from '../netlify/functions/_shared/summary-evidence-validation';

describe('summary quantity provenance', () => {
  it.each([
    ['Dose: 25 mg.', '25mg'], ['Dose: 25\u00a0mg.', '25 mg'],
    ['Dose: 25\nmg.', '25 mg'], ['Temperature: 20 °C.', '20°C'],
    ['Dose: −25 mg.', '-25mg'], ['Dose: 1.5 mg.', '1,5mg'],
    ['Dose: 0.005 mg.', '0,005mg'], ['Dose: 25 µg.', '25 μg'],
    ['Result: 1e-3 mg.', '1e-3mg'], ['Result: <25 mg.', '<25mg'],
    ['Result: <=-25 mg.', '<=-25mg'], ['Dose: 1.000 mg.', '1.000mg'],
    ['Rate: 25 mg day^-1.', '25mg day^-1'],
  ])('accepts whole original quantities despite layout: %s / %s', (source, value) => {
    expect(createSummaryValueMatcher(source)(value)).toBe(true);
  });
  it.each([
    ['Dose: 125 mg.', '25 mg'], ['Dose: -25 mg.', '25 mg'],
    ['Dose: +25 mg.', '25 mg'], ['Dose: 25 mg.', '-25 mg'],
    ['Dose: 25 Mg.', '25 mg'], ['Dose: 25 mg.', '25 g'],
    ['Dose: 1.50 mg.', '1.5 mg'], ['Dose: 1,000 mg.', '1.000 mg'],
    ['Dose: 1 000 mg.', '000 mg'], ['Dose: 1e-3 mg.', '-3 mg'],
    ['Dose: 1e25 mg.', '25 mg'], ['Dose: 1-3 mg.', '-3 mg'],
    ['Dose: <-3 mg.', '-3 mg'], ['Dose: <=25 mg.', '25 mg'],
    ['Dose: >=25 mg.', '25 mg'], ['Dose: 25 mg/L.', '25 mg'],
    ['Rate: 25 mg day-1.', '25 mg'], ['Rate: 25 mg day^-1.', '25 mg'],
    ['Rate: 25 mg subject⁻¹.', '25 mg'], ['Area: 25 m².', '25 m'],
    ['Area: 25 m2.', '25 m'], ['Rate: 25 mg kg-1.', '25 mg'],
    ['Measurement: 25 ± 3 mg.', '3 mg'], ['Dose: 25 mg.', ''],
    ['Dose: 25 mg.', 'measured mass'],
  ])('does not accept altered magnitude or a quantity fragment: %s / %s', (source, value) => {
    expect(createSummaryValueMatcher(source)(value)).toBe(false);
  });
  it('bounds oversized generated values instead of spending unbounded time matching them', () => {
    expect(createSummaryValueMatcher('a '.repeat(10_000) + '25 mg')('a '.repeat(2_000) + '25 mg')).toBe(false);
  });
  it('restores original quote whitespace without accepting a changed word or regex injection', () => {
    expect(recoverSummaryQuote('Dose (25 mg) at 20 °C.', 'Dose (25\nmg) at\u00a020 °C.')).toBe('Dose (25\nmg) at\u00a020 °C.');
    expect(recoverSummaryQuote('Dose (42 mg)', 'Dose (25 mg)')).toBeUndefined();
    expect(recoverSummaryQuote('Dose .*', 'Dose (25 mg)')).toBeUndefined();
    expect(recoverSummaryQuote(' ', 'Dose (25 mg)')).toBeUndefined();
  });
});
