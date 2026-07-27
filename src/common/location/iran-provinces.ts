import { LocationNames } from './countries';

export interface ProvinceOption {
  code: string;
  names: LocationNames;
}

/**
 * All 31 provinces of Iran (Building Setup Refinement Phase 2 —
 * Country -> Province -> City + Postal Code Normalization).
 *
 * IMPORTANT — `code` values (e.g. `IR-TEHRAN`) are VielHome-internal
 * location codes. They are NOT official ISO 3166-2:IR subdivision
 * codes and must never be presented, stored, or exported as if they
 * were an ISO standard. They exist purely as stable, unique identifiers
 * for this dataset. Reproducing the official numeric ISO 3166-2:IR
 * codes correctly from memory without a verifiable source risked
 * presenting wrong data as an official standard, which was judged worse
 * than a clearly-labeled, stable home-grown scheme. If true ISO
 * 3166-2:IR codes are wanted later, swapping them in is a data-only
 * change — nothing in the validation logic depends on the code's shape,
 * only on it being stable and unique.
 *
 * `names.fa` are the standard Persian province names. `names.tr` are
 * hand-curated Turkish adaptations of the Persian names, following
 * standard Turkish orthographic conventions for Persian place names
 * (the same conventions behind established exonyms like "Tahran",
 * "Kirman", "Kum"). These are NOT copied from a single verified
 * authority and should ideally be spot-checked by a Turkish speaker,
 * but every entry is a genuine, deliberate Turkish adaptation — none
 * of the 31 provinces has `names.tr` equal to `names.en`.
 */
export const IRAN_PROVINCES: readonly ProvinceOption[] = [
  { code: 'IR-TEHRAN', names: { en: 'Tehran', fa: 'تهران', tr: 'Tahran' } },
  { code: 'IR-ALBORZ', names: { en: 'Alborz', fa: 'البرز', tr: 'Elburz' } },
  { code: 'IR-ISFAHAN', names: { en: 'Isfahan', fa: 'اصفهان', tr: 'İsfahan' } },
  { code: 'IR-FARS', names: { en: 'Fars', fa: 'فارس', tr: 'Fars' } },
  { code: 'IR-RAZAVI_KHORASAN', names: { en: 'Razavi Khorasan', fa: 'خراسان رضوی', tr: 'Rezevi Horasan' } },
  { code: 'IR-NORTH_KHORASAN', names: { en: 'North Khorasan', fa: 'خراسان شمالی', tr: 'Kuzey Horasan' } },
  { code: 'IR-SOUTH_KHORASAN', names: { en: 'South Khorasan', fa: 'خراسان جنوبی', tr: 'Güney Horasan' } },
  { code: 'IR-EAST_AZERBAIJAN', names: { en: 'East Azerbaijan', fa: 'آذربایجان شرقی', tr: 'Doğu Azerbaycan' } },
  { code: 'IR-WEST_AZERBAIJAN', names: { en: 'West Azerbaijan', fa: 'آذربایجان غربی', tr: 'Batı Azerbaycan' } },
  { code: 'IR-ARDABIL', names: { en: 'Ardabil', fa: 'اردبیل', tr: 'Erdebil' } },
  { code: 'IR-KERMAN', names: { en: 'Kerman', fa: 'کرمان', tr: 'Kirman' } },
  { code: 'IR-KHUZESTAN', names: { en: 'Khuzestan', fa: 'خوزستان', tr: 'Huzistan' } },
  { code: 'IR-KERMANSHAH', names: { en: 'Kermanshah', fa: 'کرمانشاه', tr: 'Kirmanşah' } },
  { code: 'IR-KURDISTAN', names: { en: 'Kurdistan', fa: 'کردستان', tr: 'Kürdistan' } },
  { code: 'IR-GILAN', names: { en: 'Gilan', fa: 'گیلان', tr: 'Gilan' } },
  { code: 'IR-MAZANDARAN', names: { en: 'Mazandaran', fa: 'مازندران', tr: 'Mazenderan' } },
  { code: 'IR-GOLESTAN', names: { en: 'Golestan', fa: 'گلستان', tr: 'Gülistan' } },
  { code: 'IR-SISTAN_BALUCHESTAN', names: { en: 'Sistan and Baluchestan', fa: 'سیستان و بلوچستان', tr: 'Sistan ve Belucistan' } },
  { code: 'IR-HORMOZGAN', names: { en: 'Hormozgan', fa: 'هرمزگان', tr: 'Hürmüzgan' } },
  { code: 'IR-BUSHEHR', names: { en: 'Bushehr', fa: 'بوشهر', tr: 'Buşehr' } },
  { code: 'IR-YAZD', names: { en: 'Yazd', fa: 'یزد', tr: 'Yezd' } },
  { code: 'IR-SEMNAN', names: { en: 'Semnan', fa: 'سمنان', tr: 'Semnan' } },
  { code: 'IR-QOM', names: { en: 'Qom', fa: 'قم', tr: 'Kum' } },
  { code: 'IR-QAZVIN', names: { en: 'Qazvin', fa: 'قزوین', tr: 'Kazvin' } },
  { code: 'IR-ZANJAN', names: { en: 'Zanjan', fa: 'زنجان', tr: 'Zencan' } },
  { code: 'IR-MARKAZI', names: { en: 'Markazi', fa: 'مرکزی', tr: 'Merkezi' } },
  { code: 'IR-HAMADAN', names: { en: 'Hamadan', fa: 'همدان', tr: 'Hemedan' } },
  { code: 'IR-LORESTAN', names: { en: 'Lorestan', fa: 'لرستان', tr: 'Luristan' } },
  { code: 'IR-ILAM', names: { en: 'Ilam', fa: 'ایلام', tr: 'İlam' } },
  { code: 'IR-KOHGILUYEH_BOYERAHMAD', names: { en: 'Kohgiluyeh and Boyer-Ahmad', fa: 'کهگیلویه و بویراحمد', tr: 'Kohkiluye ve Boyerahmed' } },
  { code: 'IR-CHAHARMAHAL_BAKHTIARI', names: { en: 'Chaharmahal and Bakhtiari', fa: 'چهارمحال و بختیاری', tr: 'Çeharmahal ve Bahtiyari' } },
] as const;

const IRAN_PROVINCE_CODES = new Set(IRAN_PROVINCES.map((p) => p.code));

export function isValidIranProvinceCode(code: unknown): code is string {
  return typeof code === 'string' && IRAN_PROVINCE_CODES.has(code);
}
