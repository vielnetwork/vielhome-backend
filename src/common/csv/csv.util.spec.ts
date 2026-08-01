import { toCsv, DEFAULT_EXPORT_ROW_CAP } from './csv.util';

describe('toCsv (ADR-115 — Backoffice Reports & Export)', () => {
  it('renders only the header row for an empty row set', () => {
    expect(toCsv([], ['id', 'name'])).toBe('id,name');
  });

  it('renders one line per row, reading each column in the given order', () => {
    const csv = toCsv(
      [
        { id: '1', name: 'Alice', extra: 'ignored' },
        { id: '2', name: 'Bob' },
      ],
      ['id', 'name'],
    );
    expect(csv).toBe('id,name\n1,Alice\n2,Bob');
  });

  it('renders null and undefined cells as an empty string', () => {
    const csv = toCsv([{ id: '1', name: null, note: undefined }], ['id', 'name', 'note']);
    expect(csv).toBe('id,name,note\n1,,');
  });

  it('renders a Date cell as its own toISOString()', () => {
    const date = new Date('2026-08-01T12:00:00.000Z');
    const csv = toCsv([{ id: '1', createdAt: date }], ['id', 'createdAt']);
    expect(csv).toBe(`id,createdAt\n1,${date.toISOString()}`);
  });

  it('quotes and escapes a value containing a comma', () => {
    const csv = toCsv([{ id: '1', note: 'a, b' }], ['id', 'note']);
    expect(csv).toBe('id,note\n1,"a, b"');
  });

  it('quotes and doubles internal quotes for a value containing a double quote', () => {
    const csv = toCsv([{ id: '1', note: 'say "hi"' }], ['id', 'note']);
    expect(csv).toBe('id,note\n1,"say ""hi"""');
  });

  it('quotes a value containing a newline', () => {
    const csv = toCsv([{ id: '1', note: 'line1\nline2' }], ['id', 'note']);
    expect(csv).toBe('id,note\n1,"line1\nline2"');
  });

  it("exports a 5000-row default cap, matching AuditService.exportCsv's own default", () => {
    expect(DEFAULT_EXPORT_ROW_CAP).toBe(5000);
  });
});
