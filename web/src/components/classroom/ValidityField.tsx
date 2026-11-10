import { useState } from 'react';

export function validityDays(fields: FormData): number | null {
  const period = fields.get('validityPeriod');
  if (period === 'permanent') return null;
  return Number(period === 'custom' ? fields.get('customValidityDays') : period);
}

export function formatRegistrationValidity(expires: number | null): string {
  if (expires === null) return 'Until used or cancelled';
  return new Date(expires).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ValidityField({ disabled = false }: { disabled?: boolean }) {
  const [period, setPeriod] = useState('14');
  return (
    <>
      <label>
        Valid for
        <select
          name="validityPeriod"
          value={period}
          disabled={disabled}
          onChange={(event) => setPeriod(event.target.value)}
        >
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="custom">Custom number of days</option>
          <option value="permanent">Until used or cancelled</option>
        </select>
      </label>
      {period === 'custom' && (
        <label>
          Number of days
          <input
            name="customValidityDays"
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            step={1}
            required
            disabled={disabled}
          />
        </label>
      )}
    </>
  );
}
