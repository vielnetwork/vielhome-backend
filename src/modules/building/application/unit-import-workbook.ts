import { Workbook } from 'exceljs';
import { fromBuffer, type ZipFile } from 'yauzl';
import { ValidationError } from '../../../common/errors/app-error';
import { normalizeIranianMobilePhone } from '../../../common/phone/phone.util';

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
  'موبایل مالک | Owner mobile',
  'نام مالک | Owner first name',
  'نام خانوادگی مالک | Owner last name',
  'موبایل مستأجر | Tenant mobile',
  'نام مستأجر | Tenant first name',
  'نام خانوادگی مستأجر | Tenant last name',
  'پایان اجاره | Lease end date (YYYY-MM-DD)',
];
const types = {
  RESIDENTIAL: 'مسکونی', COMMERCIAL: 'تجاری', PARKING: 'پارکینگ', STORAGE: 'انباری',
};
const statuses = {
  VACANT: 'خالی', OWNER_OCCUPIED: 'مالک‌نشین', TENANT_OCCUPIED: 'مستأجرنشین',
};

export type ImportContact = {
  role: 'OWNER' | 'TENANT';
  phone: string;
  firstName: string;
  lastName: string;
  leaseEndDate?: Date;
};

export type ImportUnitData = {
  unitNumber: string;
  type?: keyof typeof types;
  floorNumber?: number;
  areaSqm?: number;
  parkingCount?: number;
  storageCount?: number;
  occupancyStatus?: keyof typeof statuses;
  contacts?: ImportContact[];
};

export async function unitImportTemplate(units: readonly ImportUnitData[]) {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Units', { views: [{ state: 'frozen', ySplit: 1, rightToLeft: true }] });
  sheet.addRow(columns).font = { bold: true };
  for (const column of sheet.columns) column.width = 29;
  sheet.getColumn(1).numFmt = '@';
  for (const column of [8, 11, 14]) sheet.getColumn(column).numFmt = '@';
  for (const unit of units) {
    const owner = unit.contacts?.find((contact) => contact.role === 'OWNER');
    const tenant = unit.contacts?.find((contact) => contact.role === 'TENANT');
    sheet.addRow([
      unit.unitNumber, unit.type && types[unit.type], unit.floorNumber, unit.areaSqm,
      unit.parkingCount, unit.storageCount, unit.occupancyStatus && statuses[unit.occupancyStatus],
      owner?.phone, owner?.firstName, owner?.lastName,
      tenant?.phone, tenant?.firstName, tenant?.lastName, tenant?.leaseEndDate?.toISOString().slice(0, 10),
    ]);
  }
  const guide = workbook.addWorksheet('Guide', { views: [{ rightToLeft: true }] });
  guide.getColumn(1).width = 112;
  guide.addRows([
    ['شمارهٔ موجود را برای ویرایش نگه دارید و شمارهٔ جدید را در سطر جدا وارد کنید.'],
    ['سلول خالی برای واحد موجود، مقدار قبلی را حفظ می‌کند. حذف سطر باعث حذف واحد نمی‌شود.'],
    ['نوع واحد: مسکونی، تجاری، پارکینگ، انباری'],
    ['وضعیت سکونت: خالی، مالک‌نشین، مستأجرنشین. وضعیت مستأجرنشین به اجارهٔ جاری نیاز دارد.'],
    ['برای افزودن هر شخص، موبایل، نام و نام خانوادگی را کامل وارد کنید. پایان اجاره را به میلادی، مانند 2027-01-31 وارد کنید.'],
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
  const activeColumns = sheet?.getRow(1).getCell(8).value == null ? columns.slice(0, 7) : columns;
  if (!sheet || activeColumns.some((name, index) => sheet.getRow(1).getCell(index + 1).value !== name)) {
    throw new ValidationError('INVALID_UNIT_TEMPLATE');
  }
  if (sheet.rowCount > maxRows + 1) throw new ValidationError('TOO_MANY_UNIT_ROWS');
  const rows: Array<{ row: number; data: ImportUnitData }> = [];
  const errors: Array<{ row: number; code: string }> = [];
  const seen = new Set<string>();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    try {
      const values = activeColumns.map((_, column) => {
        const value = row.getCell(column + 1).value;
        if (value === null) return '';
        if (column === 13 && value instanceof Date && Number.isFinite(value.getTime())) {
          return value.toISOString().slice(0, 10);
        }
        if (typeof value !== 'string' && typeof value !== 'number') throw new Error('cell');
        return String(value).trim();
      });
      if (values.every((value) => !value)) return;
      const unitNumber = normalizeUnitNumber(values[0]);
      if (!unitNumber || unitNumber.length > 40) throw new Error('unitNumber');
      if (seen.has(unitNumber)) throw new Error('duplicate');
      seen.add(unitNumber);
      const contacts: ImportContact[] = [];
      for (const [role, offset] of [['OWNER', 7], ['TENANT', 10]] as const) {
        const [rawPhone, firstName, lastName] = values.slice(offset, offset + 3);
        const rawDate = role === 'TENANT' ? values[13] : undefined;
        if (!rawPhone && !firstName && !lastName && !rawDate) continue;
        const phone = normalizeIranianMobilePhone(rawPhone);
        if (!phone || !firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
          throw new Error('contact');
        }
        const date = rawDate ? normalizeUnitNumber(rawDate) : '';
        const leaseEndDate = date ? new Date(date) : undefined;
        if (leaseEndDate && (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            !Number.isFinite(leaseEndDate.getTime()) || leaseEndDate.toISOString().slice(0, 10) !== date)) {
          throw new Error('leaseDate');
        }
        contacts.push({ role, phone, firstName, lastName, ...(leaseEndDate ? { leaseEndDate } : {}) });
      }
      if (contacts.length === 2 && contacts[0].phone === contacts[1].phone) throw new Error('contact');
      rows.push({ row: index, data: {
        unitNumber,
        type: enumValue(values[1], types),
        floorNumber: numberValue(values[2], true, -1000, 1000),
        areaSqm: numberValue(values[3], false, 0, 1000000),
        parkingCount: numberValue(values[4], true, 0, 10000),
        storageCount: numberValue(values[5], true, 0, 10000),
        occupancyStatus: enumValue(values[6], statuses),
        ...(contacts.length ? { contacts } : {}),
      } });
    } catch (error) {
      errors.push({ row: index, code: error instanceof Error ? error.message : 'cell' });
    }
  });
  return { rows, errors };
}
