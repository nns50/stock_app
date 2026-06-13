import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTools } from './DataTools';

describe('DataTools', () => {
  it('renders download links to the export endpoints and an import control', () => {
    render(<DataTools onImported={() => {}} />);
    expect(screen.getByText('CSV').getAttribute('href')).toBe('/api/export/positions.csv');
    expect(screen.getByText('JSON').getAttribute('href')).toBe('/api/export/positions.json');
    expect(screen.getByText('Backup .db').getAttribute('href')).toBe('/api/export/backup.db');
    expect(screen.getByRole('button', { name: 'Import…' })).toBeInTheDocument();
  });
});
