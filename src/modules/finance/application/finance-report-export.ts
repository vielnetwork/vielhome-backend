import { Workbook } from 'exceljs';
import PDFDocument = require('pdfkit');
import { resolve } from 'node:path';
import { ValidationError } from '../../../common/errors/app-error';

type Embedding = {
  levels: Uint8Array;
  paragraphs: Array<{ start: number; end: number; level: number }>;
};
const bidi = (require('bidi-js') as () => {
  getEmbeddingLevels(text: string, direction: 'ltr' | 'rtl'): Embedding;
  getReorderedIndices(text: string, embedding: Embedding): number[];
})();

type Format = 'xlsx' | 'pdf';
type Cell = string | number;
type Report = {
  title: string;
  subtitle: string[];
  columns: string[];
  rows: Cell[][];
  total: Cell[];
};

export function validateReportFormat(format?: string): Format {
  if (format === 'xlsx' || format === 'pdf') return format;
  throw new ValidationError('Report format must be xlsx or pdf.');
}

export function reportTranslations(locale?: string) {
  const language = locale === 'en' || locale === 'tr' ? locale : 'fa';
  return {
    fa: {
      rtl: true, debtTitle: 'وضعیت بدهی واحدها', fundsTitle: 'دریافت و پرداخت صندوق‌ها',
      unitNumber: 'شماره واحد', balance: 'مانده قابل پرداخت · ریال', total: 'جمع',
      allFunds: 'همه صندوق‌ها', date: 'تاریخ ثبت · UTC', fund: 'صندوق', type: 'نوع تراکنش',
      received: 'دریافت · ریال', paid: 'پرداخت · ریال',
      movementTypes: {
        PAYMENT: 'دریافت', EXPENSE: 'هزینه', REFUND: 'استرداد',
        REVERSAL: 'برگشت دریافت', VOID_EXPENSE: 'ابطال هزینه',
      } as Record<string, string>,
    },
    en: {
      rtl: false, debtTitle: 'Unit debt balances', fundsTitle: 'Fund receipts and payments',
      unitNumber: 'Unit number', balance: 'Remaining payable (IRR)', total: 'Total',
      allFunds: 'All funds', date: 'Posted at (UTC)', fund: 'Fund', type: 'Movement',
      received: 'Received (IRR)', paid: 'Paid (IRR)',
      movementTypes: {
        PAYMENT: 'Receipt', EXPENSE: 'Expense', REFUND: 'Refund',
        REVERSAL: 'Receipt reversal', VOID_EXPENSE: 'Expense void',
      } as Record<string, string>,
    },
    tr: {
      rtl: false, debtTitle: 'Daire borç durumu', fundsTitle: 'Fon tahsilat ve ödemeleri',
      unitNumber: 'Daire numarası', balance: 'Kalan borç (IRR)', total: 'Toplam',
      allFunds: 'Tüm fonlar', date: 'Kayıt tarihi (UTC)', fund: 'Fon', type: 'İşlem türü',
      received: 'Tahsilat (IRR)', paid: 'Ödeme (IRR)',
      movementTypes: {
        PAYMENT: 'Tahsilat', EXPENSE: 'Gider', REFUND: 'İade',
        REVERSAL: 'Tahsilat iptali', VOID_EXPENSE: 'Gider iptali',
      } as Record<string, string>,
    },
  }[language];
}

async function spreadsheet(report: Report, rtl: boolean) {
  const workbook = new Workbook();
  const headerRow = report.subtitle.length + 2;
  const sheet = workbook.addWorksheet('Report', {
    views: [{ state: 'frozen', ySplit: headerRow, rightToLeft: rtl }],
  });
  report.columns.forEach((_, index) => {
    sheet.getColumn(index + 1).width = report.columns.length === 2 ? 29 : 25;
  });
  for (const line of [report.title, ...report.subtitle]) {
    const row = sheet.addRow([line]);
    sheet.mergeCells(row.number, 1, row.number, report.columns.length);
  }
  sheet.getRow(1).font = { bold: true, size: 16 };
  const header = sheet.addRow(report.columns);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF163A59' } };
  sheet.addRows(report.rows);
  sheet.addRow(report.total).font = { bold: true };
  for (let column = report.columns.length === 2 ? 2 : 4; column <= report.columns.length; column++) {
    sheet.getColumn(column).numFmt = '#,##0';
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function pdf(report: Report, rtl: boolean): Promise<Buffer> {
  return new Promise((fulfill, reject) => {
    const wide = report.columns.length > 2;
    const document = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 36 });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => fulfill(Buffer.concat(chunks)));
    document.on('error', reject);
    document.font(resolve('assets/fonts/Vazirmatn.ttf'));

    const width = document.page.width - 72;
    const columnWidth = width / report.columns.length;
    let y = 36;
    const drawText = (text: string, x: number, top: number, available: number) => {
      const line = text.replace(/\s+/g, ' ').trim().replace(
        /[\u0660-\u0669\u06f0-\u06f9]/g,
        (digit) => String(digit.charCodeAt(0) & 0x0f),
      );
      if (!/[\u0590-\u08ff]/u.test(line)) {
        document.text(line, x, top, {
          align: rtl ? 'right' : 'left', width: available, height: 24, ellipsis: true,
        });
        return;
      }
      const measure = (value: string) => document.widthOfString(value, { features: [] });
      let shortened = line;
      while (shortened.length > 1 && measure(shortened) > available) {
        shortened = shortened.endsWith('…')
          ? shortened.slice(0, -2) + '…'
          : shortened.slice(0, -1) + '…';
      }
      const embedding = bidi.getEmbeddingLevels(shortened, rtl ? 'rtl' : 'ltr');
      const visualIndices = bidi.getReorderedIndices(shortened, embedding);
      const runs: string[] = [];
      let start = 0;
      for (let i = 1; i <= visualIndices.length; i++) {
        const first = visualIndices[start];
        const previous = visualIndices[i - 1];
        const level = embedding.levels[first];
        const step = level % 2 === 0 ? 1 : -1;
        if (embedding.levels[visualIndices[i]] === level && visualIndices[i] === previous + step) continue;
        runs.push(shortened.slice(Math.min(first, previous), Math.max(first, previous) + 1));
        start = i;
      }
      let left = rtl ? x + available - runs.reduce((total, run) => total + measure(run), 0) : x;
      for (const run of runs) {
        document.text(run, left, top, { lineBreak: false, features: [] });
        left += measure(run);
      }
    };
    const drawRow = (cells: Cell[], header = false) => {
      document.rect(36, y, width, 25).fill(header ? '#163a59' : '#f1f5f9');
      cells.forEach((value, index) => {
        const column = rtl ? cells.length - 1 - index : index;
        document.fillColor(header ? '#ffffff' : '#13283c').fontSize(10);
        drawText(
          typeof value === 'number' ? value.toLocaleString('en-US') : value,
          36 + columnWidth * column + 6, y + 5,
          columnWidth - 12,
        );
      });
      y += 27;
    };
    const drawPageHeading = () => {
      document.fillColor('#13283c').fontSize(18);
      drawText(report.title, 36, 36, width);
      y = 64;
      document.fontSize(10);
      for (const line of report.subtitle) {
        drawText(line, 36, y, width);
        y += 15;
      }
      y += 10;
      drawRow(report.columns, true);
    };
    drawPageHeading();
    for (const row of [...report.rows, report.total]) {
      if (y + 27 > document.page.height - 36) {
        document.addPage();
        drawPageHeading();
      }
      drawRow(row);
    }
    document.end();
  });
}

export async function renderFinanceReport(format: Format, name: string, rtl: boolean, report: Report) {
  const file = format === 'xlsx' ? await spreadsheet(report, rtl) : await pdf(report, rtl);
  return {
    fileName: `vielhome-${name}.${format}`,
    mimeType: format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/pdf',
    data: file.toString('base64'),
  };
}
