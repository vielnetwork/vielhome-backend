import { Workbook } from 'exceljs';
import { fromBuffer, type ZipFile } from 'yauzl';
import { ValidationError } from '../../../common/errors/app-error';

export const unitWorkbookLimit = 2 * 1024 * 1024;
const maxRows = 3000;
const columns = [
  'شماره واحد | Unit number',
  'نوع واحد | Type',
  'طبقه | Floor',
  'متراژ | Area',
  'تعداد پارکینگ | Parking',
  'تعداد انباری | Storage',
  'وضعیت سکونت | Occupancy',
];
const types = {
  RESIDENTIAL: 'مسکونی', COMMERCIAL: 'تجاری', PARKING: 'پارکینگ', STORAGE: 'انباری',
};
const statuses = {
  VACANT: 'خالی', OWNER_OCCUPIED: 'مالک‌نشین', TENANT_OCCUPIED: 'مستأجرنشین',
};

export type ImportUnitData = {
  unitNumber: string;
  type?: keyof typeof types;
  floorNumber?: number;
  areaSqm?: number;
  parkingCount?: number;
  storageCount?: number;
  occupancyStatus?: keyof typeof statuses;
};

export async function unitImportTemplate(units: readonly ImportUnitData[]) {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Units', { views: [{ state: 'frozen', ySplit: 1, rightToLeft: true }] });
  sheet.addRow(columns).font = { bold: true };
  for (const column of sheet.columns) column.width = 29;
  sheet.getColumn(1).numFmt = '@';
  for (const unit of units) {
    sheet.addRow([
      unit.unitNumber, unit.type && types[unit.type], unit.floorNumber, unit.areaSqm,
      unit.parkingCount, unit.storageCount, unit.occupancyStatus && statuses[unit.occupancyStatus],
    ]);
  }
  const guide = workbook.addWorksheet('Guide', { views: [{ rightToLeft: true }] });
  guide.getColumn(1).width = 112;
  guide.addRows([
    ['شمارهٔ موجود را برای ویرایش نگه دارید و شمارهٔ جدید را در سطر جدا وارد کنید.'],
    ['سلول خالی برای واحد موجود، مقدار قبلی را حفظ می‌کند. حذف سطر باعث حذف واحد نمی‌شود.'],
    ['نوع واحد: مسکونی، تجاری، پارکینگ، انباری'],
    ['وضعیت سکونت: خالی، مالک‌نشین، مستأجرنشین. وضعیت مستأجرنشین به اجارهٔ جاری نیاز دارد.'],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function openZip(file: Buffer) {
  return new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

async function validateArchive(file: Buffer) {
  if (!file.length || file.length > unitWorkbookLimit) throw new Error('file-size');
  const zip = await openZip(file);
  await new Promise<void>((resolve, reject) => {
    let size = 0;
    const fail = (error: Error) => { reject(error); zip.close(); };
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      size += entry.uncompressedSize;
      if (zip.entryCount > 100 || size > 24 * 1024 * 1024 ||
          /vbaProject|externalLinks/i.test(entry.fileName)) {
        fail(new Error('archive-limit'));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        stream.on('error', fail);
        stream.on('end', () => zip.readEntry());
        stream.resume();
      });
    });
    zip.readEntry();
  });
}

export function normalizeUnitNumber(value: string) {
  return value.trim().replace(/[\u06f0-\u06f9\u0660-\u0669]/g, (digit) =>
    String(digit.charCodeAt(0) & 15),
  );
}

function enumValue<T extends string>(value: string, options: Record<T, string>): T | undefined {
  if (!value) return undefined;
  for (const key of Object.keys(options) as T[]) {
    if (value === key || value === options[key]) return key;
  }
  throw new Error('choice');
}

function numberValue(value: string, integer: boolean, minimum: number, maximum: number) {
  if (!value) return undefined;
  const normalized = normalizeUnitNumber(value).replace('٫', '.');
  const number = Number(normalized);
  if (!/^-?\d+(\.\d+)?$/.test(normalized) || number < minimum || number > maximum ||
      (integer && !Number.isInteger(number))) throw new Error('number');
  return number;
}

export async function readUnitWorkbook(file: Buffer) {
  const workbook = new Workbook();
  try {
    await validateArchive(file);
    await workbook.xlsx.load(Uint8Array.from(file).buffer);
  } catch {
    throw new ValidationError('INVALID_UNIT_WORKBOOK');
  }
  const sheet = workbook.getWorksheet('Units');
  if (!sheet || columns.some((name, index) => sheet.getRow(1).getCell(index + 1).value !== name)) {
    throw new ValidationError('INVALID_UNIT_TEMPLATE');
  }
  if (sheet.rowCount > maxRows + 1) throw new ValidationError('TOO_MANY_UNIT_ROWS');
  const rows: Array<{ row: number; data: ImportUnitData }> = [];
  const errors: Array<{ row: number; code: string }> = [];
  const seen = new Set<string>();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    try {
      const values = columns.map((_, column) => {
        const value = row.getCell(column + 1).value;
        if (value === null) return '';
        if (typeof value !== 'string' && typeof value !== 'number') throw new Error('cell');
        return String(value).trim();
      });
      if (values.every((value) => !value)) return;
      const unitNumber = normalizeUnitNumber(values[0]);
      if (!unitNumber || unitNumber.length > 40) throw new Error('unitNumber');
      if (seen.has(unitNumber)) throw new Error('duplicate');
      seen.add(unitNumber);
      rows.push({ row: index, data: {
        unitNumber,
        type: enumValue(values[1], types),
        floorNumber: numberValue(values[2], true, -1000, 1000),
        areaSqm: numberValue(values[3], false, 0, 1000000),
        parkingCount: numberValue(values[4], true, 0, 10000),
        storageCount: numberValue(values[5], true, 0, 10000),
        occupancyStatus: enumValue(values[6], statuses),
      } });
    } catch (error) {
      errors.push({ row: index, code: error instanceof Error ? error.message : 'cell' });
    }
  });
  return { rows, errors };
}
