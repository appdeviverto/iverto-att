import { isSafeStorageKey, isUploadKey } from './uploads';

const T = 'tenant-1';
const U = '0b7a2f1e-1111-4222-8333-944455556666';
const KEY = `${T}/${U}/3f2b8c9d-aaaa-4bbb-8ccc-1234567890ab.pdf`;

describe('upload keys', () => {
  it('accepts a minted key for its tenant and uploader', () => {
    expect(isUploadKey(KEY, T, U)).toBe(true);
    expect(isUploadKey(KEY, T)).toBe(true);
  });

  it('rejects other tenants, other users and anything not minted', () => {
    expect(isUploadKey(KEY, 'tenant-2', U)).toBe(false);
    expect(isUploadKey(KEY, T, 'someone-else')).toBe(false);
    expect(isUploadKey(`${T}/${U}/notes.pdf`, T, U)).toBe(false);
    expect(isUploadKey(`${KEY}.exe`, T, U)).toBe(false);
  });

  it('rejects path traversal past the prefix (SEC-01)', () => {
    expect(isUploadKey(`${T}/${U}/../../../punch-photos/${T}/SN1/42.jpg`, T, U)).toBe(false);
    expect(isUploadKey(`${T}/../3f2b8c9d-aaaa-4bbb-8ccc-1234567890ab.pdf`, T)).toBe(false);
    expect(isSafeStorageKey(`${T}/${U}/../../../punch-photos/${T}/SN1/42.jpg`)).toBe(false);
    expect(isSafeStorageKey(`${T}/${U}/%2e%2e/x.jpg`)).toBe(false);
    expect(isSafeStorageKey(`${T}//x.jpg`)).toBe(false);
    expect(isSafeStorageKey(`${T}/x.jpg?download=1`)).toBe(false);
    expect(isSafeStorageKey(KEY)).toBe(true);
    expect(isSafeStorageKey(`${T}/SN-001/42.jpg`)).toBe(true);
  });
});
