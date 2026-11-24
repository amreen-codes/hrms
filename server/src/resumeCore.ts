/** Resume upload rules (P6 / S1). Pure: checks the real file bytes, not just the name the browser sends. */
import crypto from 'node:crypto';
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const TYPES: { ext: string; mime: string; magic: number[] }[] = [
  { ext: 'pdf', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4b, 0x03, 0x04] },
  { ext: 'doc', mime: 'application/msword', magic: [0xd0, 0xcf, 0x11, 0xe0] },
];
export function safeName(name: string): string { return (name || 'resume').replace(/^.*[\\/]/, '').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'resume'; }
export function checkResume(fileName: string, bytes: Buffer): { ok: true; ext: string; mime: string; storedName: string; original: string } | { ok: false; error: string } {
  if (!bytes || !bytes.length) return { ok: false, error: 'The file is empty' };
  if (bytes.length > MAX_RESUME_BYTES) return { ok: false, error: 'File is larger than 5 MB' };
  const t = TYPES.find((x) => x.magic.every((b, i) => bytes[i] === b));
  if (!t) return { ok: false, error: 'Only PDF, DOC and DOCX files are accepted' };
  const ext = safeName(fileName).split('.').pop()?.toLowerCase();
  if (ext !== t.ext) return { ok: false, error: `File content is ${t.ext.toUpperCase()} but the name ends in .${ext}` };
  return { ok: true, ext: t.ext, mime: t.mime, original: safeName(fileName), storedName: `${crypto.randomBytes(16).toString('hex')}.${t.ext}` };
}
