import { describe, it, expect } from 'vitest';
import { checkResume, safeName, MAX_RESUME_BYTES } from '../src/resumeCore';
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(50)]);
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(50)]);
describe('resume upload (S1)', () => {
  it('accepts a real PDF and stores under a random name', () => { const r: any = checkResume('CV.pdf', pdf); expect(r.ok).toBe(true); expect(r.storedName.endsWith('.pdf')).toBe(true); expect(r.storedName.includes('CV')).toBe(false); });
  it('accepts DOCX', () => expect((checkResume('cv.docx', docx) as any).ok).toBe(true));
  it('rejects an exe renamed to .pdf', () => expect((checkResume('cv.pdf', Buffer.from('MZ\x90\x00 fake exe')) as any).error).toBe('Only PDF, DOC and DOCX files are accepted'));
  it('rejects extension that does not match the content', () => expect((checkResume('cv.docx', pdf) as any).ok).toBe(false));
  it('rejects empty and oversize files', () => { expect((checkResume('a.pdf', Buffer.alloc(0)) as any).ok).toBe(false); expect((checkResume('a.pdf', Buffer.concat([pdf, Buffer.alloc(MAX_RESUME_BYTES)])) as any).error).toBe('File is larger than 5 MB'); });
  it('strips paths from file names', () => expect(safeName('../../etc/passwd.pdf')).toBe('passwd.pdf'));
});
